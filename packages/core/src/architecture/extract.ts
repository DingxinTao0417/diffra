import { extname } from 'node:path'
import { Lang, type NapiConfig, parse, type SgNode } from '@ast-grep/napi'
import { dynamicLanguageAvailable, vueScripts } from '../syntax.js'
import type { CallFact, FileFacts, ImportFact, SourceLanguage, SymbolFact, SymbolKind } from './model.js'

export function sourceLanguageOf(path: string): SourceLanguage | null {
  switch (extname(path).toLowerCase()) {
    case '.ts':
    case '.tsx':
    case '.mts':
    case '.cts':
      return 'typescript'
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript'
    case '.vue':
      return 'vue'
    case '.py':
      return dynamicLanguageAvailable('python') ? 'python' : null
    case '.go':
      return dynamicLanguageAvailable('go') ? 'go' : null
    case '.rs':
      return dynamicLanguageAvailable('rust') ? 'rust' : null
    case '.java':
      return dynamicLanguageAvailable('java') ? 'java' : null
    default:
      return null
  }
}

// 一个文件的 import、顶层符号（含类和 impl 的方法）和包名；语言不支持时返回 null。解析器容错，有语法错误也只取认得出的部分
export function extractFacts(path: string, source: string): FileFacts | null {
  const language = sourceLanguageOf(path)
  if (!language) return null
  const calls = new CallCollector()
  const facts: FileFacts = { language, imports: [], symbols: [], namespace: null, typeRefs: [] }
  switch (language) {
    case 'typescript':
    case 'javascript': {
      const lang = /\.[jt]sx$/i.test(path) ? Lang.Tsx : language === 'typescript' ? Lang.TypeScript : Lang.JavaScript
      const root = parse(lang, source).root()
      scriptFacts(root, 0, facts)
      calls.collect(root, 'script', 0)
      break
    }
    case 'vue':
      for (const block of vueScripts(source)) {
        const root = parse(block.lang, block.code).root()
        scriptFacts(root, block.lineOffset, facts)
        calls.collect(root, 'script', block.lineOffset)
      }
      break
    case 'python': {
      const root = parse('python', source).root()
      pythonFacts(root, facts)
      calls.collect(root, 'python', 0)
      break
    }
    case 'go': {
      const root = parse('go', source).root()
      goFacts(root, facts)
      calls.collect(root, 'go', 0)
      break
    }
    case 'rust': {
      const root = parse('rust', source).root()
      rustFacts(root, facts)
      calls.collect(root, 'rust', 0)
      break
    }
    case 'java': {
      const root = parse('java', source).root()
      javaFacts(root, facts)
      calls.collect(root, 'java', 0)
      break
    }
  }
  facts.imports.sort((a, b) => a.line - b.line)
  facts.calls = calls.list
  return facts
}

// ---------- 函数调用（v2 · M9） ----------

export const MAX_FILE_CALLS = 2000

type CallDialect = 'script' | 'python' | 'go' | 'rust' | 'java'

const CALL_RULES: Record<CallDialect, NapiConfig> = {
  script: { rule: { any: [{ kind: 'call_expression' }, { kind: 'new_expression' }] } },
  python: { rule: { kind: 'call' } },
  go: { rule: { kind: 'call_expression' } },
  rust: { rule: { kind: 'call_expression' } },
  java: { rule: { any: [{ kind: 'method_invocation' }, { kind: 'object_creation_expression' }] } },
}

const SELF_NAMES = new Set(['this', 'self', 'Self'])

// a.b.c() 的前缀取 b；this / self 照记；调用结果、下标这类看不出是谁的记 ?
function qualifierOf(node: SgNode | null, dialect: CallDialect): string | null {
  if (!node) return '?'
  const kind = String(node.kind())
  if (kind === 'identifier' || kind === 'this' || kind === 'self' || kind === 'type_identifier') return node.text()
  if (kind === 'member_expression') return node.field('property')?.text() ?? '?'
  if (kind === 'attribute') return node.field('attribute')?.text() ?? '?'
  if (kind === 'field_access') return node.field('field')?.text() ?? '?'
  if (kind === 'selector_expression') return node.field('field')?.text() ?? '?'
  if (kind === 'field_expression') return node.field('field')?.text() ?? '?'
  if (dialect === 'rust' && (kind === 'scoped_identifier' || kind === 'crate' || kind === 'super')) return node.text().split('::').pop() ?? '?'
  return '?'
}

function calleeOf(node: SgNode, dialect: CallDialect): [string, string | null] | null {
  const kind = String(node.kind())
  if (dialect === 'java') {
    if (kind === 'object_creation_expression') {
      const type = node.field('type')
      const name = type?.kind() === 'type_identifier' ? type.text() : type?.find({ rule: { kind: 'type_identifier' } })?.text()
      return name ? [name, null] : null
    }
    const name = node.field('name')?.text()
    if (!name) return null
    const object = node.field('object')
    return [name, object ? qualifierOf(object, dialect) : null]
  }
  const callee = dialect === 'script' && kind === 'new_expression' ? node.field('constructor') : node.field('function')
  if (!callee) return null
  const calleeKind = String(callee.kind())
  if (calleeKind === 'identifier') return callee.text() === 'require' ? null : [callee.text(), null]
  if (calleeKind === 'member_expression') {
    const name = callee.field('property')?.text()
    return name ? [name, qualifierOf(callee.field('object'), dialect)] : null
  }
  if (calleeKind === 'attribute') {
    const name = callee.field('attribute')?.text()
    return name ? [name, qualifierOf(callee.field('object'), dialect)] : null
  }
  if (calleeKind === 'selector_expression') {
    const name = callee.field('field')?.text()
    return name ? [name, qualifierOf(callee.field('operand'), dialect)] : null
  }
  if (calleeKind === 'field_expression') {
    const name = callee.field('field')?.text()
    return name ? [name, qualifierOf(callee.field('value'), dialect)] : null
  }
  if (calleeKind === 'scoped_identifier') {
    const name = callee.field('name')?.text()
    const path = callee.field('path')
    return name ? [name, path ? qualifierOf(path, dialect) : null] : null
  }
  return null
}

class CallCollector {
  readonly list: CallFact[] = []
  private readonly seen = new Set<string>()

  collect(root: SgNode, dialect: CallDialect, offset: number): void {
    for (const node of root.findAll(CALL_RULES[dialect])) {
      if (this.list.length >= MAX_FILE_CALLS) return
      const callee = calleeOf(node, dialect)
      if (!callee) continue
      const [name, qualifier] = callee
      const line = lineOf(node) + offset
      const key = `${name}\u0000${qualifier ?? ''}\u0000${line}`
      if (this.seen.has(key)) continue
      this.seen.add(key)
      this.list.push([name, qualifier !== null && SELF_NAMES.has(qualifier) ? 'self' : qualifier, line])
    }
  }
}

const lineOf = (node: SgNode) => node.range().start.line + 1

const compact = (text: string) => text.replace(/\s+/g, '')

const unquote = (node: SgNode) => node.text().slice(1, -1)

function symbolOf(node: SgNode, name: string, kind: SymbolKind, exported: boolean, parent: string | null, offset = 0): SymbolFact {
  const { start, end } = node.range()
  return { name, kind, line: start.line + 1 + offset, endLine: end.line + 1 + offset, exported, parent }
}

// ---------- TypeScript / JavaScript / Vue ----------

const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function'])

const SCRIPT_CALLS: NapiConfig = {
  rule: { kind: 'call_expression', has: { field: 'function', any: [{ kind: 'import' }, { kind: 'identifier', regex: '^require$' }] } },
}

function scriptFacts(root: SgNode, offset: number, facts: FileFacts): void {
  const symbols: SymbolFact[] = []
  const localExports = new Set<string>()
  for (const node of root.children()) {
    switch (node.kind()) {
      case 'import_statement':
        scriptImport(node, offset, facts.imports)
        break
      case 'export_statement': {
        const source = node.field('source')
        if (source) {
          facts.imports.push({ specifier: unquote(source), line: lineOf(node) + offset, names: exportClauseNames(node), kind: 'reexport' })
          break
        }
        const declaration = node.field('declaration')
        if (declaration) {
          scriptDeclaration(declaration, true, offset, symbols)
          break
        }
        const value = node.field('value')
        if (value) {
          // 匿名的 export default function / class 记作 default
          const kind = String(value.kind())
          if (kind === 'identifier') localExports.add(value.text())
          else if (kind === 'class') scriptClass(value, value.field('name')?.text() ?? 'default', true, offset, symbols)
          else if (FUNCTION_VALUES.has(kind)) symbols.push(symbolOf(value, value.field('name')?.text() ?? 'default', 'function', true, null, offset))
          break
        }
        for (const name of exportClauseNames(node)) localExports.add(name)
        break
      }
      default:
        scriptDeclaration(node, false, offset, symbols)
    }
  }
  for (const symbol of symbols) {
    if (localExports.has(symbol.parent ?? symbol.name)) symbol.exported = true
    facts.symbols.push(symbol)
  }

  for (const call of root.findAll(SCRIPT_CALLS)) {
    // import(/* webpackChunkName: "x" */ './x') 的注释也是具名子节点
    const argument = call
      .field('arguments')
      ?.namedChildren()
      .find((child) => child.kind() !== 'comment')
    if (argument?.kind() !== 'string') continue
    const kind = call.field('function')?.kind() === 'import' ? 'dynamic' : 'require'
    facts.imports.push({ specifier: unquote(argument), line: lineOf(call) + offset, names: [], kind })
  }
}

const nameText = (node: SgNode) => (node.kind() === 'string' ? unquote(node) : node.text())

function scriptImport(node: SgNode, offset: number, imports: ImportFact[]): void {
  const line = lineOf(node) + offset
  let typeOnly = false
  let clause: SgNode | null = null
  for (const child of node.children()) {
    const kind = child.kind()
    if (kind === 'type') typeOnly = true
    else if (kind === 'import_clause') clause = child
    else if (kind === 'import_require_clause') {
      // import fs = require('fs')
      const source = child.field('source')
      if (source) imports.push({ specifier: unquote(source), line, names: [], kind: 'require' })
      return
    }
  }
  const source = node.field('source')
  if (!source) return
  const names: string[] = []
  let local: string | undefined
  let specifiers = 0
  let allTypes = true
  for (const part of clause?.children() ?? []) {
    const kind = part.kind()
    if (kind === 'identifier') {
      names.push('default')
      allTypes = false
    } else if (kind === 'namespace_import') {
      allTypes = false
      local = part.children().find((child) => child.kind() === 'identifier')?.text()
    }
    else if (kind === 'named_imports') {
      for (const specifier of part.children()) {
        if (specifier.kind() !== 'import_specifier') continue
        specifiers++
        const name = specifier.field('name')
        if (name) names.push(nameText(name))
        if (!specifier.children().some((child) => child.kind() === 'type')) allTypes = false
      }
    }
  }
  imports.push({ specifier: unquote(source), line, names, kind: typeOnly || (specifiers > 0 && allTypes) ? 'type' : 'import', ...(local ? { local } : {}) })
}

function exportClauseNames(node: SgNode): string[] {
  const clause = node.children().find((child) => child.kind() === 'export_clause')
  if (!clause) return []
  return clause.children().flatMap((specifier) => {
    const name = specifier.kind() === 'export_specifier' ? specifier.field('name') : null
    return name ? [nameText(name)] : []
  })
}

function scriptDeclaration(node: SgNode, exported: boolean, offset: number, symbols: SymbolFact[]): void {
  const simple = (kind: SymbolKind) => {
    const name = node.field('name')
    if (name) symbols.push(symbolOf(node, name.text(), kind, exported, null, offset))
  }
  switch (node.kind()) {
    case 'function_declaration':
    case 'generator_function_declaration':
    case 'function_signature': {
      const name = node.field('name')?.text()
      if (!name) return
      // 重载的几个签名和实现紧挨着，合成一个符号
      const last = symbols[symbols.length - 1]
      if (last && last.kind === 'function' && last.parent === null && last.name === name) {
        last.endLine = node.range().end.line + 1 + offset
        last.exported ||= exported
        return
      }
      symbols.push(symbolOf(node, name, 'function', exported, null, offset))
      return
    }
    case 'class_declaration':
    case 'abstract_class_declaration': {
      const name = node.field('name')?.text()
      if (name) scriptClass(node, name, exported, offset, symbols)
      return
    }
    case 'interface_declaration':
      return simple('interface')
    case 'type_alias_declaration':
      return simple('type')
    case 'enum_declaration':
      return simple('enum')
    case 'lexical_declaration':
    case 'variable_declaration':
      for (const declarator of node.children()) {
        if (declarator.kind() !== 'variable_declarator') continue
        const name = declarator.field('name')
        if (name?.kind() !== 'identifier') continue
        const value = declarator.field('value')
        const kind = value && FUNCTION_VALUES.has(String(value.kind())) ? 'function' : 'variable'
        symbols.push(symbolOf(declarator, name.text(), kind, exported, null, offset))
      }
      return
    case 'ambient_declaration':
      for (const child of node.children()) scriptDeclaration(child, exported, offset, symbols)
      return
  }
}

function scriptClass(node: SgNode, name: string, exported: boolean, offset: number, symbols: SymbolFact[]): void {
  symbols.push(symbolOf(node, name, 'class', exported, null, offset))
  for (const member of node.field('body')?.children() ?? []) {
    const kind = member.kind()
    if (kind !== 'method_definition' && kind !== 'abstract_method_signature') continue
    const method = member.field('name')
    if (method) symbols.push(symbolOf(member, nameText(method), 'method', exported, name, offset))
  }
}

// ---------- Python ----------

const PYTHON_IMPORTS: NapiConfig = { rule: { any: [{ kind: 'import_statement' }, { kind: 'import_from_statement' }] } }

const moduleOf = (node: SgNode) => (node.kind() === 'aliased_import' ? node.field('name') : node)

const pythonExported = (name: string) => !name.startsWith('_')

function pythonFacts(root: SgNode, facts: FileFacts): void {
  for (const node of root.findAll(PYTHON_IMPORTS)) {
    const line = lineOf(node)
    if (node.kind() === 'import_statement') {
      for (const name of node.fieldChildren('name')) {
        const module = moduleOf(name)
        const local = name.kind() === 'aliased_import' ? name.field('alias')?.text() : undefined
        if (module) facts.imports.push({ specifier: compact(module.text()), line, names: [], kind: 'import', ...(local ? { local } : {}) })
      }
      continue
    }
    const module = node.field('module_name')
    if (!module) continue
    const names = node.fieldChildren('name').flatMap((name) => {
      const target = moduleOf(name)
      return target ? [compact(target.text())] : []
    })
    facts.imports.push({ specifier: compact(module.text()), line, names, kind: 'import' })
  }

  for (const node of root.children()) {
    const definition = node.kind() === 'decorated_definition' ? node.field('definition') : node
    if (!definition) continue
    switch (definition.kind()) {
      case 'function_definition': {
        const name = definition.field('name')?.text()
        if (name) facts.symbols.push(symbolOf(definition, name, 'function', pythonExported(name), null))
        break
      }
      case 'class_definition': {
        const name = definition.field('name')?.text()
        if (!name) break
        facts.symbols.push(symbolOf(definition, name, 'class', pythonExported(name), null))
        for (const member of definition.field('body')?.children() ?? []) {
          const method = member.kind() === 'decorated_definition' ? member.field('definition') : member
          if (method?.kind() !== 'function_definition') continue
          const methodName = method.field('name')?.text()
          if (methodName) facts.symbols.push(symbolOf(method, methodName, 'method', pythonExported(methodName), name))
        }
        break
      }
      case 'expression_statement': {
        const assignment = definition.child(0)
        const left = assignment?.kind() === 'assignment' ? assignment.field('left') : null
        if (left?.kind() !== 'identifier') break
        const name = left.text()
        facts.symbols.push(symbolOf(definition, name, /^_*[A-Z][A-Z0-9_]*$/.test(name) ? 'constant' : 'variable', pythonExported(name), null))
        break
      }
    }
  }
}

// ---------- Go ----------

const goExported = (name: string) => /^\p{Lu}/u.test(name)

const TYPE_IDENTIFIER: NapiConfig = { rule: { kind: 'type_identifier' } }

function goFacts(root: SgNode, facts: FileFacts): void {
  const push = (node: SgNode, name: string, kind: SymbolKind, parent: string | null = null) => facts.symbols.push(symbolOf(node, name, kind, goExported(name), parent))
  for (const node of root.children()) {
    switch (node.kind()) {
      case 'package_clause':
        facts.namespace = node.children().find((child) => child.kind() === 'package_identifier')?.text() ?? null
        break
      case 'import_declaration':
        for (const child of node.children()) {
          for (const spec of child.kind() === 'import_spec_list' ? child.children() : [child]) {
            const path = spec.kind() === 'import_spec' ? spec.field('path') : null
            const local = spec.kind() === 'import_spec' ? spec.field('name')?.text() : undefined
            if (path) facts.imports.push({ specifier: unquote(path), line: lineOf(spec), names: [], kind: 'import', ...(local && local !== '_' && local !== '.' ? { local } : {}) })
          }
        }
        break
      case 'function_declaration': {
        const name = node.field('name')?.text()
        if (name) push(node, name, 'function')
        break
      }
      case 'method_declaration': {
        const name = node.field('name')?.text()
        // 接收者 *List[T] 里第一个类型名就是 List
        const receiver = node.field('receiver')?.find(TYPE_IDENTIFIER)?.text() ?? null
        if (name) push(node, name, 'method', receiver)
        break
      }
      case 'type_declaration':
        for (const spec of node.children()) {
          const kind = spec.kind()
          if (kind !== 'type_spec' && kind !== 'type_alias') continue
          const name = spec.field('name')?.text()
          if (!name) continue
          const type = kind === 'type_spec' ? spec.field('type')?.kind() : null
          push(spec, name, type === 'struct_type' ? 'struct' : type === 'interface_type' ? 'interface' : 'type')
        }
        break
      case 'const_declaration':
      case 'var_declaration': {
        const kind = node.kind() === 'const_declaration' ? 'constant' : 'variable'
        for (const child of node.children()) {
          for (const spec of child.kind() === 'var_spec_list' ? child.children() : [child]) {
            if (spec.kind() !== 'const_spec' && spec.kind() !== 'var_spec') continue
            for (const name of spec.fieldChildren('name')) if (name.kind() === 'identifier') push(spec, name.text(), kind)
          }
        }
        break
      }
    }
  }
}

// ---------- Rust ----------

const RUST_ITEMS = new Map<string, SymbolKind>([
  ['function_item', 'function'],
  ['struct_item', 'struct'],
  ['enum_item', 'enum'],
  ['trait_item', 'trait'],
  ['type_item', 'type'],
  ['const_item', 'constant'],
  ['static_item', 'constant'],
])

const RUST_PATHS = new Set(['identifier', 'scoped_identifier', 'crate', 'super', 'self', 'metavariable'])

const RUST_USES: NapiConfig = { rule: { kind: 'use_declaration' } }

const rustPublic = (node: SgNode) => node.child(0)?.kind() === 'visibility_modifier'

const joinRust = (prefix: string, path: string) => (prefix && path ? `${prefix}::${path}` : prefix || path)

function rustFacts(root: SgNode, facts: FileFacts): void {
  for (const node of root.findAll(RUST_USES)) {
    const argument = node.field('argument')
    if (argument) rustUseTree(argument, '', facts.imports)
  }
  rustItems(root, [], facts)
}

// use a::b::{c, d::e} 展开成每个叶子一条：a::b::c、a::b::d::e；{self} 指前缀本身
function rustUseTree(node: SgNode, prefix: string, imports: ImportFact[]): void {
  const kind = String(node.kind())
  switch (kind) {
    case 'scoped_use_list': {
      const path = node.field('path')
      const list = node.field('list')
      if (list) rustUseTree(list, joinRust(prefix, path ? compact(path.text()) : ''), imports)
      return
    }
    case 'use_list':
      for (const child of node.children()) rustUseTree(child, prefix, imports)
      return
    case 'use_as_clause': {
      const path = node.field('path')
      if (path) rustUseTree(path, prefix, imports)
      return
    }
    case 'use_wildcard': {
      const path = node.children().find((child) => RUST_PATHS.has(String(child.kind())))
      const specifier = joinRust(prefix, path ? compact(path.text()) : '')
      if (specifier) imports.push({ specifier, line: lineOf(node), names: [], kind: 'use' })
      return
    }
  }
  if (!RUST_PATHS.has(kind)) return
  const path = compact(node.text())
  const specifier = path === 'self' && prefix ? prefix : joinRust(prefix, path)
  imports.push({ specifier, line: lineOf(node), names: [specifier.slice(specifier.lastIndexOf(':') + 1)], kind: 'use' })
}

// 行内 mod 块里的条目照顶层处理；块里的 mod foo; 记成 外层::foo，对应 外层/foo.rs
function rustItems(container: SgNode, modPath: string[], facts: FileFacts): void {
  for (const node of container.children()) {
    const kind = String(node.kind())
    switch (kind) {
      case 'mod_item': {
        const name = node.field('name')?.text()
        if (!name) break
        facts.symbols.push(symbolOf(node, name, 'module', rustPublic(node), null))
        const body = node.field('body')
        if (body) rustItems(body, [...modPath, name], facts)
        else facts.imports.push({ specifier: [...modPath, name].join('::'), line: lineOf(node), names: [], kind: 'mod' })
        break
      }
      case 'impl_item': {
        const type = node.field('type')
        if (!type) break
        // impl<T> Trait for &'a Foo<T> 的类型名取第一个类型标识符；u32 这类内置类型没有，就用原文
        const parent = (type.find(TYPE_IDENTIFIER) ?? type).text()
        for (const member of node.field('body')?.children() ?? []) {
          if (member.kind() !== 'function_item') continue
          const name = member.field('name')?.text()
          if (name) facts.symbols.push(symbolOf(member, name, 'method', rustPublic(member), parent))
        }
        break
      }
      case 'extern_crate_declaration': {
        const name = node.field('name')?.text()
        if (name) facts.imports.push({ specifier: name, line: lineOf(node), names: [], kind: 'use' })
        break
      }
      default: {
        const symbolKind = RUST_ITEMS.get(kind)
        const name = symbolKind ? node.field('name')?.text() : undefined
        if (symbolKind && name) facts.symbols.push(symbolOf(node, name, symbolKind, rustPublic(node), null))
      }
    }
  }
}

// ---------- Java ----------

const JAVA_TYPES = new Map<string, SymbolKind>([
  ['class_declaration', 'class'],
  ['record_declaration', 'class'],
  ['enum_declaration', 'enum'],
  ['interface_declaration', 'interface'],
  ['annotation_type_declaration', 'interface'],
])

const JAVA_METHODS = new Set(['method_declaration', 'constructor_declaration', 'compact_constructor_declaration'])

const javaPath = (node: SgNode) => {
  const path = node.children().find((child) => child.kind() === 'scoped_identifier' || child.kind() === 'identifier')
  return path ? compact(path.text()) : null
}

function javaPublic(node: SgNode): boolean {
  const modifiers = node.child(0)
  return modifiers?.kind() === 'modifiers' && modifiers.children().some((child) => child.kind() === 'public')
}

function javaFacts(root: SgNode, facts: FileFacts): void {
  for (const node of root.children()) {
    const kind = String(node.kind())
    if (kind === 'package_declaration') facts.namespace = javaPath(node)
    else if (kind === 'import_declaration') {
      const path = javaPath(node)
      if (!path) continue
      const children = node.children()
      const wildcard = children.some((child) => child.kind() === 'asterisk')
      facts.imports.push({
        specifier: wildcard ? `${path}.*` : path,
        line: lineOf(node),
        names: wildcard ? [] : [path.slice(path.lastIndexOf('.') + 1)],
        kind: children.some((child) => child.kind() === 'static') ? 'static' : 'import',
      })
    } else if (JAVA_TYPES.has(kind)) {
      javaType(node, null, facts.symbols)
      // 顶层类型上的注解（判断入口和分层用）：@SpringBootApplication、@RestController、@Service…
      const modifiers = node.child(0)
      if (modifiers?.kind() === 'modifiers') {
        for (const annotation of modifiers.children()) {
          if (annotation.kind() !== 'marker_annotation' && annotation.kind() !== 'annotation') continue
          const name = annotation.field('name')?.text()
          if (name) facts.annotations = [...(facts.annotations ?? []), name.slice(name.lastIndexOf('.') + 1)]
        }
      }
    }
  }
  facts.annotations ??= []
  const refs = new Set(root.findAll(TYPE_IDENTIFIER).map((node) => node.text()))
  // Helper.call()、Helper.CONST 里的 Helper 是 identifier 不是 type_identifier：首字母大写的按类名算
  for (const node of root.findAll({ rule: { any: [{ kind: 'method_invocation' }, { kind: 'field_access' }] } })) {
    const object = node.field('object')
    if (object?.kind() === 'identifier' && /^\p{Lu}/u.test(object.text())) refs.add(object.text())
  }
  facts.typeRefs = [...refs].sort()
}

function javaType(node: SgNode, parent: string | null, symbols: SymbolFact[]): void {
  const name = node.field('name')?.text()
  const kind = JAVA_TYPES.get(String(node.kind()))
  if (!name || !kind) return
  symbols.push(symbolOf(node, name, kind, javaPublic(node), parent))
  for (const child of node.field('body')?.children() ?? []) {
    // 枚举的方法在 enum_body_declarations 里
    for (const member of child.kind() === 'enum_body_declarations' ? child.children() : [child]) {
      const memberKind = String(member.kind())
      if (JAVA_TYPES.has(memberKind)) javaType(member, name, symbols)
      else if (JAVA_METHODS.has(memberKind)) {
        const method = member.field('name')?.text()
        if (method) symbols.push(symbolOf(member, method, 'method', javaPublic(member), name))
      }
    }
  }
}
