import { builtinModules } from 'node:module'
import { posix } from 'node:path'
import type { ImportFact, ResolverConfig, SourceLanguage } from './model.js'

export type Resolution =
  | { kind: 'internal'; files: string[] }
  | { kind: 'external'; name: string; ecosystem: 'npm' | 'python' | 'go' | 'cargo' | 'java'; builtin: boolean }
  // 项目里的非代码文件（样式、图片、JSON），不进依赖图
  | { kind: 'asset' }
  | { kind: 'unresolved' }

const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue']
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

  constructor(private readonly input: ResolverInput) {
    for (const [file, language] of input.sourceFiles) {
      const dir = dirOf(file)
      const inDir = this.dirFiles.get(dir)
      if (inDir) inDir.push(file)
      else this.dirFiles.set(dir, [file])
      if (language === 'java') {
        const namespace = input.namespaces.get(file) ?? ''
        const name = posix.basename(file, '.java')
        this.javaClasses.set(namespace ? `${namespace}.${name}` : name, file)
        const inPackage = this.javaPackages.get(namespace)
        if (inPackage) inPackage.push(file)
        else this.javaPackages.set(namespace, [file])
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

  resolve(from: string, language: SourceLanguage, fact: ImportFact): Resolution {
    switch (language) {
      case 'typescript':
      case 'javascript':
      case 'vue':
        return this.resolveScript(from, fact.specifier)
      case 'python':
        return this.resolvePython(from, fact)
      case 'go':
        return this.resolveGo(from, fact.specifier)
      case 'rust':
        return this.resolveRust(from, fact)
      case 'java':
        return this.resolveJava(fact.specifier)
    }
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
    const builtin = ['java', 'javax', 'jdk', 'sun'].includes(segments[0]!)
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
