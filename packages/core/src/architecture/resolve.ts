import { builtinModules } from 'node:module'
import { posix } from 'node:path'
import type { ExternalEcosystem, ImportFact, ResolverConfig, SourceLanguage } from './model.js'

export type Resolution =
  | { kind: 'internal'; files: string[] }
  | { kind: 'external'; name: string; ecosystem: ExternalEcosystem; builtin: boolean }
  // 项目里的非代码文件（样式、图片、JSON），不进依赖图
  | { kind: 'asset' }
  | { kind: 'unresolved' }

const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte']
const JS_TO_TS: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] }
const NODE_BUILTINS = new Set(builtinModules)
const RUST_BUILTIN_CRATES = new Set(['std', 'core', 'alloc', 'proc_macro', 'test'])

// Python 标准库里常用的顶层模块；没列到的按第三方包算
const PYTHON_STDLIB = new Set(
  'abc argparse array ast asyncio atexit base64 binascii bisect builtins bz2 calendar cmath codecs collections colorsys concurrent configparser contextlib contextvars copy copyreg cProfile csv ctypes curses dataclasses datetime dbm decimal difflib dis doctest email encodings enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http imaplib importlib inspect io ipaddress itertools json keyword linecache locale logging lzma mailbox marshal math mimetypes mmap multiprocessing netrc numbers operator optparse os pathlib pdb pickle pkgutil platform plistlib poplib posixpath pprint profile pstats pty pwd queue quopri random re readline reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex shutil signal site smtplib socket socketserver sqlite3 ssl stat statistics string stringprep struct subprocess symtable sys sysconfig syslog tabnanny tarfile tempfile termios textwrap threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc tty turtle types typing unicodedata unittest urllib uuid venv warnings wave weakref webbrowser winreg winsound wsgiref xml xmlrpc zipapp zipfile zipimport zlib zoneinfo __future__ _thread'.split(
    ' ',
  ),
)

const dirOf = (path: string) => {
  const dir = posix.dirname(path)
  return dir === '.' ? '' : dir
}
const joinPath = (...parts: string[]) => {
  const joined = posix.normalize(posix.join(...parts.filter((part) => part !== '')))
  return joined === '.' ? '' : joined.replace(/\/$/, '')
}
const insideRoot = (path: string) => path !== '..' && !path.startsWith('../')

interface AliasRule {
  prefix: string
  suffix: string
  // 不带 * 的别名只认完全相同的导入路径
  exact: boolean
  targets: string[]
}

export interface ResolverInput {
  config: ResolverConfig
  // 项目里所有文件（含非代码文件），相对路径
  allFiles: ReadonlySet<string>
  // 深度解析的代码文件 → 语言
  sourceFiles: ReadonlyMap<string, SourceLanguage>
  // Java：文件 → package；Go 不需要（按目录）
  namespaces: ReadonlyMap<string, string | null>
  // Go、Cargo、Maven、Python 清单里声明的依赖，用来把外部导入归到声明的名字上
  declaredGo: readonly string[]
  // v2 · M9：Kotlin、Scala、C#、PHP、Swift 文件里顶层定义的名字（类型、函数），按「包.名字」对上 import
  types?: ReadonlyMap<string, readonly string[]>
}

const JVM_LANGUAGES = new Set<SourceLanguage>(['java', 'kotlin', 'scala'])
const RUBY_STDLIB = new Set(
  'json set date time fileutils pathname open3 optparse yaml psych net uri securerandom digest logger erb csv tempfile tmpdir socket benchmark English forwardable singleton observer ostruct stringio timeout zlib openssl base64 bigdecimal etc io pp prettyprint rbconfig ripper monitor shellwords strscan find getoptlong open-uri pstore resolv weakref coverage objspace pty readline fiddle'.split(' '),
)
const SWIFT_SYSTEM = new Set(
  'Swift Foundation UIKit SwiftUI AppKit Combine CoreData CoreGraphics CoreFoundation CoreLocation CoreImage CoreML CoreText Darwin Dispatch os OSLog XCTest Testing Observation AVFoundation MapKit WebKit StoreKit UserNotifications Security Network Photos PhotosUI CloudKit GameKit SpriteKit SceneKit Metal MetalKit QuartzCore Accelerate Charts WidgetKit AuthenticationServices LocalAuthentication Glibc'.split(' '),
)
const C_SYSTEM_DIRS = new Set(['sys', 'bits', 'linux', 'arpa', 'netinet', 'asm', 'machine', 'mach', 'net'])

// 一个路径所有的后缀：a/b/c.h → a/b/c.h、b/c.h、c.h
function* suffixes(path: string): Generator<string> {
  const parts = path.split('/')
  for (let index = 0; index < parts.length; index++) yield parts.slice(index).join('/')
}

const pushTo = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
  const list = map.get(key)
  if (list) {
    if (!list.includes(value)) list.push(value)
  } else map.set(key, [value])
}

// 和 from 共同上级目录最深的排前面：同名头文件、同名 Ruby 文件有好几个时取最近的
function closest(from: string, files: readonly string[]): string {
  const depth = (file: string) => {
    const a = from.split('/')
    const b = file.split('/')
    let shared = 0
    while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++
    return shared
  }
  return [...files].sort((x, y) => depth(y) - depth(x) || x.length - y.length)[0]!
}

// 把导入路径对上项目里的文件，或者归到外部包
export class Resolver {
  private readonly dirFiles = new Map<string, string[]>()
  private readonly javaClasses = new Map<string, string>()
  private readonly javaPackages = new Map<string, string[]>()
  private readonly rustModules = new Map<string, Map<string, string>>()
  private readonly crateRoots: Array<{ dir: string; root: string }>
  // tsconfig 的路径别名按所在目录分组：一个文件只试管得到它的那几份 tsconfig，近的优先，前缀长的优先。
  // 大仓库里几百份 tsconfig 继承同一份 paths，摊平成一张表逐条试会慢到几分钟
  private readonly aliasScopes: Array<{ scope: string; rules: AliasRule[] }>
  private readonly aliasCache = new Map<string, AliasRule[][]>()
  private readonly goModules: Array<[string, string]>
  private readonly declaredGo: string[]
  // v2 · M9：更多语言
  private readonly csTypes = new Map<string, string[]>()
  private readonly csNamespaces = new Set<string>()
  private readonly phpTypes = new Map<string, string>()
  private readonly swiftModules = new Map<string, string[]>()
  private readonly swiftTypes = new Map<string, string[]>()
  private readonly cSuffixes = new Map<string, string[]>()
  private readonly rubySuffixes = new Map<string, string[]>()
  private readonly dartLibs = new Map<string, string[]>()

  constructor(private readonly input: ResolverInput) {
    for (const [file, language] of input.sourceFiles) {
      const dir = dirOf(file)
      const inDir = this.dirFiles.get(dir)
      if (inDir) inDir.push(file)
      else this.dirFiles.set(dir, [file])
      if (JVM_LANGUAGES.has(language)) {
        const namespace = input.namespaces.get(file) ?? ''
        // Kotlin、Scala 一个文件可以定义好几个类和顶层函数，都记上；Java 按文件名
        const names = language === 'java' ? [posix.basename(file, '.java')] : [posix.basename(file).replace(/\.[^.]+$/, ''), ...(input.types?.get(file) ?? [])]
        for (const name of names) {
          const key = namespace ? `${namespace}.${name}` : name
          if (!this.javaClasses.has(key)) this.javaClasses.set(key, file)
        }
        const inPackage = this.javaPackages.get(namespace)
        if (inPackage) inPackage.push(file)
        else this.javaPackages.set(namespace, [file])
      } else if (language === 'csharp') {
        const namespace = input.namespaces.get(file) ?? ''
        this.csNamespaces.add(namespace)
        for (const name of input.types?.get(file) ?? []) pushTo(this.csTypes, namespace ? `${namespace}.${name}` : name, file)
      } else if (language === 'php') {
        const namespace = input.namespaces.get(file) ?? ''
        for (const name of input.types?.get(file) ?? []) {
          const key = namespace ? `${namespace}\\${name}` : name
          if (!this.phpTypes.has(key)) this.phpTypes.set(key, file)
        }
      } else if (language === 'swift') {
        const module = swiftModuleOf(file)
        pushTo(this.swiftModules, module, file)
        for (const name of input.types?.get(file) ?? []) pushTo(this.swiftTypes, `${module}.${name}`, file)
      } else if (language === 'c' || language === 'cpp') {
        for (const suffix of suffixes(file)) pushTo(this.cSuffixes, suffix, file)
      } else if (language === 'ruby') {
        for (const suffix of suffixes(file.replace(/\.rb$/, ''))) pushTo(this.rubySuffixes, suffix, file)
      } else if (language === 'dart') {
        // 包的 lib/ 下面的文件，package:名字/路径 按「lib/ 之后的路径」找
        const lib = file.lastIndexOf('lib/')
        if (lib >= 0 && (lib === 0 || file[lib - 1] === '/') && input.allFiles.has(`${file.slice(0, lib)}pubspec.yaml`)) pushTo(this.dartLibs, file.slice(lib + 4), file)
      }
    }
    const byScope = new Map<string, AliasRule[]>()
    for (const alias of input.config.aliases) {
      const star = alias.pattern.indexOf('*')
      const rule: AliasRule = star < 0 ? { prefix: alias.pattern, suffix: '', exact: true, targets: alias.targets } : { prefix: alias.pattern.slice(0, star), suffix: alias.pattern.slice(star + 1), exact: false, targets: alias.targets }
      const rules = byScope.get(alias.scope)
      if (rules) rules.push(rule)
      else byScope.set(alias.scope, [rule])
    }
    this.aliasScopes = [...byScope]
      .map(([scope, rules]) => ({ scope, rules: rules.sort((a, b) => b.prefix.length - a.prefix.length) }))
      .sort((a, b) => b.scope.length - a.scope.length)
    this.goModules = Object.entries(input.config.goModules).sort((a, b) => b[0].length - a[0].length)
    this.declaredGo = [...input.declaredGo].sort((a, b) => b.length - a.length)
    this.crateRoots = Object.values(input.config.crates)
      .map((root) => ({ root, dir: crateDirOf(root) }))
      .sort((a, b) => b.dir.length - a.dir.length)
    for (const { root } of this.crateRoots) this.rustModules.set(root, new Map())
    for (const [file, language] of input.sourceFiles) {
      if (language !== 'rust') continue
      const crate = this.crateOf(file)
      if (!crate) continue
      const modulePath = rustModulePath(crate.dir, file)
      if (modulePath !== null && !this.rustModules.get(crate.root)!.has(modulePath)) this.rustModules.get(crate.root)!.set(modulePath, file)
    }
  }

  // typeRefs：文件里出现的类型名（C#、Swift 的整个命名空间、模块导入按它挑出真正用到的文件）
  resolve(from: string, language: SourceLanguage, fact: ImportFact, typeRefs: readonly string[] = []): Resolution {
    switch (language) {
      case 'typescript':
      case 'javascript':
      case 'vue':
      case 'svelte':
        return this.resolveScript(from, fact.specifier)
      case 'python':
        return this.resolvePython(from, fact)
      case 'go':
        return this.resolveGo(from, fact.specifier)
      case 'rust':
        return this.resolveRust(from, fact)
      case 'java':
      case 'kotlin':
      case 'scala':
        return this.resolveJava(fact.specifier)
      case 'csharp':
        return this.resolveCsharp(fact.specifier, typeRefs)
      case 'php':
        return this.resolvePhp(from, fact)
      case 'ruby':
        return this.resolveRuby(from, fact.specifier)
      case 'c':
      case 'cpp':
        return this.resolveC(from, fact.specifier)
      case 'swift':
        return this.resolveSwift(fact.specifier, typeRefs)
      case 'dart':
        return this.resolveDart(from, fact.specifier)
    }
  }

  // 不用 import 就能用的：Java、Kotlin、Scala 同一个包，C# 同一个和上级命名空间，PHP 同一个命名空间，Swift 同一个模块
  implicitTargets(from: string, language: SourceLanguage, typeRefs: readonly string[]): string[] {
    if (JVM_LANGUAGES.has(language)) return this.samePackageJava(from, typeRefs)
    const namespace = this.input.namespaces.get(from) ?? ''
    const targets = new Set<string>()
    if (language === 'csharp') {
      const scopes = namespace.split('.').map((_, index, parts) => parts.slice(0, parts.length - index).join('.'))
      for (const ref of typeRefs) for (const scope of [...scopes, '']) for (const file of this.csTypes.get(scope ? `${scope}.${ref}` : ref) ?? []) targets.add(file)
    } else if (language === 'php') {
      for (const ref of typeRefs) {
        const file = this.phpTypes.get(namespace ? `${namespace}\\${ref}` : ref)
        if (file) targets.add(file)
      }
    } else if (language === 'swift') {
      const module = swiftModuleOf(from)
      for (const ref of typeRefs) for (const file of this.swiftTypes.get(`${module}.${ref}`) ?? []) targets.add(file)
    }
    targets.delete(from)
    return [...targets]
  }

  // ---------- v2 · M9：C#、PHP、Ruby、C/C++、Swift、Dart ----------

  private resolveCsharp(specifier: string, typeRefs: readonly string[]): Resolution {
    // using A.B; 引入整个命名空间：只连这个文件真用到的类型所在的文件
    if (this.csNamespaces.has(specifier)) return { kind: 'internal', files: [...new Set(typeRefs.flatMap((ref) => this.csTypes.get(`${specifier}.${ref}`) ?? []))] }
    // using static A.B.C; / using X = A.B.C;
    const type = this.csTypes.get(specifier)
    if (type) return { kind: 'internal', files: type }
    if ([...this.csNamespaces].some((namespace) => namespace.startsWith(`${specifier}.`))) return { kind: 'internal', files: [] }
    const segments = specifier.split('.')
    return { kind: 'external', name: segments.slice(0, 2).join('.'), ecosystem: 'nuget', builtin: segments[0] === 'System' }
  }

  private resolvePhp(from: string, fact: ImportFact): Resolution {
    const specifier = fact.specifier
    if (fact.kind === 'require') {
      for (const candidate of [joinPath(dirOf(from), specifier), joinPath(specifier)]) if (insideRoot(candidate) && this.input.allFiles.has(candidate)) return { kind: 'internal', files: [candidate] }
      return { kind: 'unresolved' }
    }
    const file = this.phpTypes.get(specifier)
    if (file) return { kind: 'internal', files: [file] }
    const segments = specifier.split('\\')
    if (segments.length === 1) return { kind: 'external', name: specifier, ecosystem: 'composer', builtin: true }
    if ([...this.phpTypes.keys()].some((key) => key.startsWith(`${segments[0]}\\`))) return { kind: 'unresolved' }
    return { kind: 'external', name: segments.slice(0, 2).join('\\'), ecosystem: 'composer', builtin: false }
  }

  private resolveRuby(from: string, specifier: string): Resolution {
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const base = joinPath(dirOf(from), specifier)
      for (const candidate of [base, `${base}.rb`]) if (this.input.allFiles.has(candidate)) return { kind: 'internal', files: [candidate] }
      return { kind: 'unresolved' }
    }
    const matches = this.rubySuffixes.get(specifier.replace(/\.rb$/, ''))
    if (matches) {
      const preferred = matches.filter((file) => file.startsWith('lib/') || file.includes('/lib/'))
      return { kind: 'internal', files: [closest(from, preferred.length > 0 ? preferred : matches)] }
    }
    const name = specifier.split('/')[0]!
    return { kind: 'external', name, ecosystem: 'gem', builtin: RUBY_STDLIB.has(name) }
  }

  private resolveC(from: string, specifier: string): Resolution {
    const system = specifier.startsWith('<')
    const name = system ? specifier.slice(1, -1) : specifier
    if (!system) {
      const local = joinPath(dirOf(from), name)
      if (insideRoot(local) && this.input.allFiles.has(local)) return { kind: 'internal', files: [local] }
    }
    // 项目里的 include 目录（include/、src/……）：按路径后缀找，同名的取最近的
    const matches = this.cSuffixes.get(name.replace(/^(\.\/)+/, ''))
    if (matches) return { kind: 'internal', files: [closest(from, matches)] }
    if (!system) return { kind: 'unresolved' }
    const first = name.split('/')[0]!
    const builtin = !name.includes('/') || C_SYSTEM_DIRS.has(first)
    return { kind: 'external', name: builtin ? name : first, ecosystem: 'native', builtin }
  }

  private resolveSwift(module: string, typeRefs: readonly string[]): Resolution {
    if (this.swiftModules.has(module)) return { kind: 'internal', files: [...new Set(typeRefs.flatMap((ref) => this.swiftTypes.get(`${module}.${ref}`) ?? []))] }
    return { kind: 'external', name: module, ecosystem: 'swift', builtin: SWIFT_SYSTEM.has(module) }
  }

  private resolveDart(from: string, specifier: string): Resolution {
    if (specifier.startsWith('dart:')) return { kind: 'external', name: specifier, ecosystem: 'pub', builtin: true }
    if (specifier.startsWith('package:')) {
      const [name, ...rest] = specifier.slice(8).split('/')
      const files = this.dartLibs.get(rest.join('/'))
      if (files) {
        const named = files.filter((file) => posix.basename(file.slice(0, file.lastIndexOf('lib/')).replace(/\/$/, '')) === name)
        return { kind: 'internal', files: [closest(from, named.length > 0 ? named : files)] }
      }
      return { kind: 'external', name: name!, ecosystem: 'pub', builtin: false }
    }
    const local = joinPath(dirOf(from), specifier)
    if (insideRoot(local) && this.input.allFiles.has(local)) return { kind: 'internal', files: [local] }
    return { kind: 'unresolved' }
  }

  // Java 同一个包里的类不用 import：文件里出现的类型名对上同包的类
  samePackageJava(from: string, typeRefs: readonly string[]): string[] {
    const namespace = this.input.namespaces.get(from) ?? ''
    const targets: string[] = []
    for (const ref of typeRefs) {
      const file = this.javaClasses.get(namespace ? `${namespace}.${ref}` : ref)
      if (file && file !== from) targets.push(file)
    }
    return targets
  }

  // ---------- TS / JS / Vue ----------

  private scriptFile(base: string): string | null {
    if (!insideRoot(base)) return null
    const { sourceFiles, allFiles } = this.input
    if (sourceFiles.has(base)) return base
    const extension = posix.extname(base)
    for (const replacement of JS_TO_TS[extension] ?? []) {
      const candidate = base.slice(0, -extension.length) + replacement
      if (sourceFiles.has(candidate)) return candidate
    }
    for (const suffix of SCRIPT_EXTENSIONS) if (sourceFiles.has(base + suffix)) return base + suffix
    for (const suffix of SCRIPT_EXTENSIONS) if (sourceFiles.has(`${base}/index${suffix}`)) return `${base}/index${suffix}`
    return allFiles.has(base) ? '' : null
  }

  private scriptResult(file: string | null): Resolution | null {
    if (file === null) return null
    return file === '' ? { kind: 'asset' } : { kind: 'internal', files: [file] }
  }

  private resolveScript(from: string, specifier: string): Resolution {
    const clean = specifier.replace(/[?#].*$/, '')
    if (clean.startsWith('.') || clean.startsWith('/')) {
      return this.scriptResult(this.scriptFile(joinPath(clean.startsWith('/') ? '' : dirOf(from), clean))) ?? { kind: 'unresolved' }
    }
    for (const rules of this.aliasesFor(from)) {
      for (const rule of rules) {
        const matches = rule.exact ? clean === rule.prefix : clean.startsWith(rule.prefix) && clean.endsWith(rule.suffix) && clean.length >= rule.prefix.length + rule.suffix.length
        if (!matches) continue
        const wildcard = rule.exact ? '' : clean.slice(rule.prefix.length, clean.length - rule.suffix.length)
        for (const target of rule.targets) {
          const result = this.scriptResult(this.scriptFile(joinPath(target.replace('*', wildcard))))
          if (result) return result
        }
      }
    }
    const name = clean.startsWith('@') ? clean.split('/').slice(0, 2).join('/') : clean.split('/')[0]!
    const workspace = this.input.config.npmPackages[name]
    if (workspace) {
      const subpath = `.${clean.slice(name.length)}`
      const exported = workspace.exports[subpath]
      const candidates = exported ? [exported] : subpath === '.' ? ['src/index', 'index'].map((item) => joinPath(workspace.dir, item)) : [joinPath(workspace.dir, subpath), joinPath(workspace.dir, 'src', subpath)]
      for (const candidate of candidates) {
        const result = this.scriptResult(this.scriptFile(candidate))
        if (result) return result
      }
      return { kind: 'unresolved' }
    }
    const bare = clean.replace(/^node:/, '')
    const builtin = clean.startsWith('node:') || NODE_BUILTINS.has(bare) || NODE_BUILTINS.has(bare.split('/')[0]!)
    return { kind: 'external', name: builtin ? `node:${bare.split('/')[0]}` : name, ecosystem: 'npm', builtin }
  }

  private aliasesFor(from: string): AliasRule[][] {
    const dir = dirOf(from)
    let rules = this.aliasCache.get(dir)
    if (!rules) {
      rules = this.aliasScopes.filter(({ scope }) => scope === '' || dir === scope || dir.startsWith(`${scope}/`)).map((item) => item.rules)
      this.aliasCache.set(dir, rules)
    }
    return rules
  }

  // ---------- Python ----------

  private pythonModule(base: string): string | null {
    if (!insideRoot(base)) return null
    if (this.input.sourceFiles.has(`${base}.py`)) return `${base}.py`
    if (this.input.sourceFiles.has(`${base}/__init__.py`)) return `${base}/__init__.py`
    return null
  }

  private pythonTargets(base: string, names: readonly string[]): string[] {
    const targets = new Set<string>()
    // from pkg import a, b：a、b 可能是子模块，也可能是 pkg 里定义的名字
    let needsModule = names.length === 0
    for (const name of names) {
      const submodule = this.pythonModule(joinPath(base, name))
      if (submodule) targets.add(submodule)
      else needsModule = true
    }
    if (needsModule) {
      const module = this.pythonModule(base)
      if (module) targets.add(module)
    }
    return [...targets]
  }

  private resolvePython(from: string, fact: ImportFact): Resolution {
    const specifier = fact.specifier
    if (specifier.startsWith('.')) {
      const dots = /^\.+/.exec(specifier)![0].length
      let base = dirOf(from)
      for (let level = 1; level < dots; level++) base = dirOf(base)
      const rest = specifier.slice(dots).replace(/\./g, '/')
      const targets = this.pythonTargets(joinPath(base, rest), fact.names)
      return targets.length > 0 ? { kind: 'internal', files: targets } : { kind: 'unresolved' }
    }
    const path = specifier.replace(/\./g, '/')
    for (const root of this.input.config.pythonRoots) {
      const targets = this.pythonTargets(joinPath(root, path), fact.names)
      if (targets.length > 0) return { kind: 'internal', files: targets }
    }
    // 没有 pyproject 的项目：从文件所在目录往上找顶层包（脚本在哪个目录运行，那里就是导入根）
    for (let dir = dirOf(from); dir !== ''; dir = dirOf(dir)) {
      const targets = this.pythonTargets(joinPath(dir, path), fact.names)
      if (targets.length > 0) return { kind: 'internal', files: targets }
    }
    const top = specifier.split('.')[0]!
    return { kind: 'external', name: top, ecosystem: 'python', builtin: PYTHON_STDLIB.has(top) }
  }

  // ---------- Go ----------

  private resolveGo(from: string, specifier: string): Resolution {
    for (const [module, dir] of this.goModules) {
      if (specifier !== module && !specifier.startsWith(`${module}/`)) continue
      const target = joinPath(dir, specifier.slice(module.length + 1))
      const files = (this.dirFiles.get(target) ?? []).filter((file) => file.endsWith('.go') && !file.endsWith('_test.go') && file !== from)
      return files.length > 0 ? { kind: 'internal', files } : { kind: 'unresolved' }
    }
    const first = specifier.split('/')[0]!
    if (!first.includes('.')) return { kind: 'external', name: first, ecosystem: 'go', builtin: true }
    const declared = this.declaredGo.find((module) => specifier === module || specifier.startsWith(`${module}/`))
    return { kind: 'external', name: declared ?? specifier.split('/').slice(0, 3).join('/'), ecosystem: 'go', builtin: false }
  }

  // ---------- Rust ----------

  private crateOf(file: string): { dir: string; root: string } | null {
    return this.crateRoots.find(({ dir }) => dir === '' || file.startsWith(`${dir}/`)) ?? null
  }

  private resolveRust(from: string, fact: ImportFact): Resolution {
    const crate = this.crateOf(from)
    if (!crate) return { kind: 'unresolved' }
    const modules = this.rustModules.get(crate.root)!
    const current = rustModulePath(crate.dir, from) ?? ''
    const segments = fact.specifier.split('::').filter(Boolean)
    if (fact.kind === 'mod') {
      const target = modules.get(current ? `${current}::${segments[0]}` : segments[0]!)
      return target ? { kind: 'internal', files: [target] } : { kind: 'unresolved' }
    }
    let targetModules = modules
    let base: string[]
    let rest: string[]
    const head = segments[0] ?? ''
    if (head === 'crate') {
      base = []
      rest = segments.slice(1)
    } else if (head === 'self' || head === 'super') {
      base = current ? current.split('::') : []
      let index = 0
      if (segments[0] === 'self') index = 1
      while (segments[index] === 'super') {
        base = base.slice(0, -1)
        index++
      }
      rest = segments.slice(index)
    } else if (this.input.config.crates[head] && this.input.config.crates[head] !== crate.root) {
      targetModules = this.rustModules.get(this.input.config.crates[head]!) ?? new Map()
      base = []
      rest = segments.slice(1)
    } else {
      // 2018 版以后 use 的路径也可以从当前模块的子模块开始
      const local = current ? `${current}::${head}` : head
      if (!modules.has(local)) return { kind: 'external', name: head, ecosystem: 'cargo', builtin: RUST_BUILTIN_CRATES.has(head) }
      base = current ? current.split('::') : []
      rest = segments
    }
    // 最长的、能对上文件的模块路径；剩下的段是模块里的名字
    for (let length = rest.length; length >= 0; length--) {
      const path = [...base, ...rest.slice(0, length)].join('::')
      const target = targetModules.get(path)
      if (target) return target === from ? { kind: 'asset' } : { kind: 'internal', files: [target] }
    }
    return { kind: 'unresolved' }
  }

  // ---------- Java ----------

  private resolveJava(specifier: string): Resolution {
    if (specifier.endsWith('.*')) {
      const name = specifier.slice(0, -2)
      const files = this.javaPackages.get(name) ?? (this.javaClasses.has(name) ? [this.javaClasses.get(name)!] : null)
      if (files) return { kind: 'internal', files }
    } else {
      // 静态导入、内部类：去掉最后一两段再找类
      const segments = specifier.split('.')
      for (let drop = 0; drop <= 2 && segments.length - drop > 0; drop++) {
        const file = this.javaClasses.get(segments.slice(0, segments.length - drop).join('.'))
        if (file) return { kind: 'internal', files: [file] }
      }
    }
    const segments = specifier.replace(/\.\*$/, '').split('.')
    const builtin = ['java', 'javax', 'jdk', 'sun', 'kotlin', 'scala'].includes(segments[0]!)
    const third = segments[2]
    const name = third && /^[a-z]/.test(third) && segments.length > 3 ? segments.slice(0, 3).join('.') : segments.slice(0, 2).join('.')
    return { kind: 'external', name, ecosystem: 'java', builtin }
  }
}

export function crateDirOf(root: string): string {
  // crate 根文件在 <dir>/src/lib.rs 或 <dir>/src/main.rs
  const src = dirOf(root)
  return posix.basename(src) === 'src' ? dirOf(src) : src
}

// Rust 文件对应的模块路径：src/a/b.rs、src/a/b/mod.rs → a::b；lib.rs、main.rs → ''
export function rustModulePath(crateDir: string, file: string): string | null {
  const prefix = crateDir ? `${crateDir}/src/` : 'src/'
  if (!file.startsWith(prefix)) return null
  const relative = file.slice(prefix.length).replace(/\.rs$/, '')
  if (relative === 'lib' || relative === 'main') return ''
  if (relative.startsWith('bin/')) return null
  const segments = relative.split('/')
  if (segments[segments.length - 1] === 'mod') segments.pop()
  return segments.join('::')
}

// Swift Package 的模块是 Sources/<模块名>/ 下的文件；不是 Package 结构的（Xcode 工程）整个项目算一个模块
export function swiftModuleOf(file: string): string {
  const match = /(?:^|\/)Sources\/([^/]+)\//.exec(file)
  return match ? match[1]! : ''
}
