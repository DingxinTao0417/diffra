import type { FileFacts, ImportFact, SymbolFact, SymbolKind } from './model.js'

// 更多语言（v2 · M9）：C、C++、C#、Kotlin、Scala、PHP、Ruby、Swift、Dart 没有 ast-grep 的解析器（要加依赖），
// 按行认 import 和类、函数的声明。去掉注释、把字符串里的内容盖掉再数花括号，算出声明的范围和方法属于哪个类型。
// 认不出的写法（宏、跨好几行的签名）就少一个符号，不影响依赖。
export type LineLanguage = 'c' | 'cpp' | 'csharp' | 'kotlin' | 'scala' | 'php' | 'ruby' | 'swift' | 'dart'

const MAX_TYPE_REFS = 3000
const TYPE_KINDS = new Set<SymbolKind>(['class', 'interface', 'struct', 'enum', 'trait', 'impl', 'module'])

interface Prepared {
  // 去掉注释、保留字符串（认 import 用）
  code: string[]
  // 再把字符串内容盖成空格（数括号、认声明用）
  bare: string[]
}

// 注释和字符串：C 系的 // 和 /* */，Ruby 和 PHP 的 #，Ruby 的 =begin/=end；字符串认单双引号和反引号
function prepare(source: string, hashComments: boolean, slashComments: boolean): Prepared {
  const code: string[] = []
  const bare: string[] = []
  let inBlock = false
  let inRubyBlock = false
  for (const raw of source.split(/\r?\n/)) {
    if (hashComments && !slashComments) {
      if (/^=begin\b/.test(raw)) inRubyBlock = true
      if (inRubyBlock) {
        if (/^=end\b/.test(raw)) inRubyBlock = false
        code.push('')
        bare.push('')
        continue
      }
    }
    let kept = ''
    let blank = ''
    let quote: string | null = null
    for (let index = 0; index < raw.length; index++) {
      const char = raw[index]!
      const next = raw[index + 1]
      if (inBlock) {
        if (char === '*' && next === '/') {
          inBlock = false
          index++
        }
        continue
      }
      if (quote) {
        kept += char
        if (char === '\\') {
          kept += next ?? ''
          blank += '  '
          index++
          continue
        }
        if (char === quote) {
          quote = null
          blank += char
        } else blank += ' '
        continue
      }
      if (slashComments && char === '/' && next === '/') break
      if (slashComments && char === '/' && next === '*') {
        inBlock = true
        index++
        continue
      }
      // PHP 8 的 #[属性] 不是注释
      if (hashComments && char === '#' && next !== '[') break
      if (char === '"' || char === "'" || char === '`') quote = char
      kept += char
      blank += char
    }
    code.push(kept)
    bare.push(blank)
  }
  return { code, bare }
}

class Declarations {
  readonly symbols: SymbolFact[] = []
  private readonly stack: Array<{ symbol: SymbolFact; depth: number }> = []
  private pending: { symbol: SymbolFact; line: number } | null = null
  private depth = 0

  // 外层最近的类型（类、结构体、接口……），方法挂在它下面
  enclosingType(): string | null {
    for (let index = this.stack.length - 1; index >= 0; index--) {
      const symbol = this.stack[index]!.symbol
      if (TYPE_KINDS.has(symbol.kind)) return symbol.name
    }
    return null
  }

  get nesting(): number {
    return this.depth
  }

  declare(name: string, kind: SymbolKind, line: number, exported: boolean, parent: string | null = this.enclosingType()): SymbolFact {
    const symbol: SymbolFact = { name, kind, line, endLine: line, exported, parent }
    this.symbols.push(symbol)
    this.pending = { symbol, line }
    return symbol
  }

  // 一行的花括号：声明后面第一个 { 开它的范围，配对的 } 关上
  braces(bare: string, line: number): void {
    if (this.pending && this.pending.line < line && !/^\s*\{/.test(bare) && bare.trim() !== '') this.pending = null
    for (const char of bare) {
      if (char === '{') {
        this.depth++
        if (this.pending) {
          this.stack.push({ symbol: this.pending.symbol, depth: this.depth })
          this.pending = null
        }
      } else if (char === '}') {
        const top = this.stack[this.stack.length - 1]
        if (top && top.depth === this.depth) {
          top.symbol.endLine = line
          this.stack.pop()
        }
        this.depth = Math.max(0, this.depth - 1)
      }
    }
    if (this.pending && /;\s*$/.test(bare)) this.pending = null
  }
}

function typeRefsOf(bare: string[]): string[] {
  const refs = new Set<string>()
  for (const line of bare) {
    for (const match of line.matchAll(/\b[A-Z][A-Za-z0-9_]*\b/g)) {
      refs.add(match[0])
      if (refs.size >= MAX_TYPE_REFS) return [...refs]
    }
  }
  return [...refs]
}

const imp = (specifier: string, line: number, kind: ImportFact['kind'] = 'import', names: string[] = []): ImportFact => ({ specifier, line, names, kind })

export function lineFacts(language: LineLanguage, source: string, facts: FileFacts): void {
  switch (language) {
    case 'c':
    case 'cpp':
      return cFacts(prepare(source, false, true), facts)
    case 'csharp':
      return csharpFacts(prepare(source, false, true), facts)
    case 'kotlin':
    case 'scala':
      return jvmFacts(language, prepare(source, false, true), facts)
    case 'php':
      return phpFacts(prepare(source, true, true), facts)
    case 'ruby':
      return rubyFacts(prepare(source, true, false), facts)
    case 'swift':
      return swiftFacts(prepare(source, false, true), facts)
    case 'dart':
      return dartFacts(prepare(source, false, true), facts)
  }
}

// ---------- C / C++ ----------

const C_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'else', 'do', 'sizeof', 'case', 'catch', 'new', 'delete', 'throw', 'defined'])

function cFacts({ code, bare }: Prepared, facts: FileFacts): void {
  const declarations = new Declarations()
  code.forEach((text, index) => {
    const line = index + 1
    const include = /^\s*#\s*include\s*([<"])([^>"]+)[>"]/.exec(text)
    // 系统头文件写成 <stdio.h>，项目里的写成 "x.h"
    if (include) facts.imports.push(imp(include[1] === '<' ? `<${include[2]!.trim()}>` : include[2]!.trim(), line))
    const plain = bare[index]!
    const type = /^\s*(?:template\s*<[^>]*>\s*)?(?:typedef\s+)?(class|struct|union|enum(?:\s+class)?|namespace)\s+(?:\[\[[^\]]*\]\]\s*)?([A-Za-z_]\w*)(?!\s*;)/.exec(plain)
    if (type && !/;\s*$/.test(plain)) {
      const keyword = type[1]!
      const kind: SymbolKind = keyword === 'namespace' ? 'module' : keyword.startsWith('enum') ? 'enum' : keyword === 'class' ? 'class' : 'struct'
      declarations.declare(type[2]!, kind, line, true)
    } else {
      const fn = /^\s*(?:template\s*<[^>]*>\s*)?([\w:*&<>,\s~]*?[\w*&>])\s+\**&?([A-Za-z_~][\w:~]*)\s*\(([^;{}]*)\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:final\s*)?(\{.*)?$/.exec(plain)
      const next = bare.slice(index + 1).find((item) => item.trim() !== '')
      if (fn && !C_KEYWORDS.has(fn[2]!.split('::').pop()!) && !/^\s*(return|else|typedef)\b/.test(plain) && (fn[4] !== undefined || /^\s*\{/.test(next ?? ''))) {
        const qualified = fn[2]!.split('::')
        const name = qualified.pop()!
        const parent = qualified.length > 0 ? qualified.join('::') : declarations.enclosingType()
        declarations.declare(name, parent ? 'method' : 'function', line, !/\bstatic\b/.test(fn[1]!), parent)
      }
    }
    declarations.braces(plain, line)
  })
  facts.symbols.push(...declarations.symbols)
}

// ---------- C# ----------

function csharpFacts({ code, bare }: Prepared, facts: FileFacts): void {
  const declarations = new Declarations()
  code.forEach((text, index) => {
    const line = index + 1
    const plain = bare[index]!
    const namespace = /^\s*namespace\s+([\w.]+)/.exec(plain)
    if (namespace && facts.namespace === null) facts.namespace = namespace[1]!
    const using = /^\s*(?:global\s+)?using\s+(static\s+)?(?:(\w+)\s*=\s*)?([\w.]+)\s*;/.exec(text)
    if (using && declarations.nesting === 0) facts.imports.push(imp(using[3]!, line, using[1] || using[2] ? 'static' : 'import'))
    const type = /^\s*(?:\[[^\]]*\]\s*)*((?:(?:public|private|protected|internal|static|sealed|abstract|partial|readonly|ref|unsafe|new|file)\s+)*)(class|interface|struct|enum|record(?:\s+struct|\s+class)?)\s+(\w+)/.exec(plain)
    if (type) {
      const keyword = type[2]!
      const kind: SymbolKind = keyword === 'interface' ? 'interface' : keyword === 'enum' ? 'enum' : keyword === 'struct' || keyword === 'record struct' ? 'struct' : 'class'
      declarations.declare(type[3]!, kind, line, /\b(public|internal)\b/.test(type[1]!))
    } else if (declarations.enclosingType()) {
      const method = /^\s*(?:\[[^\]]*\]\s*)*((?:(?:public|private|protected|internal|static|virtual|override|abstract|async|sealed|extern|unsafe|new|partial)\s+)+)[\w<>[\],.?\s]+?\s+(\w+)\s*(?:<[^>]*>)?\s*\(/.exec(plain)
      if (method && !/\b(new|return)\s*$/.test(method[1]!)) declarations.declare(method[2]!, 'method', line, /\bpublic\b/.test(method[1]!))
    }
    declarations.braces(plain, line)
  })
  facts.symbols.push(...declarations.symbols)
  facts.typeRefs = typeRefsOf(bare)
}

// ---------- Kotlin / Scala ----------

function jvmFacts(language: 'kotlin' | 'scala', { code, bare }: Prepared, facts: FileFacts): void {
  const declarations = new Declarations()
  code.forEach((text, index) => {
    const line = index + 1
    const plain = bare[index]!
    const pkg = /^\s*package\s+([\w.]+)/.exec(plain)
    if (pkg && facts.namespace === null) facts.namespace = pkg[1]!
    const imported = /^\s*import\s+(\w+(?:\.\w+)*)(?:\.\{([^}]*)\})?(\.\*|\._)?/.exec(text)
    if (imported) {
      const base = imported[1]!
      if (imported[2] !== undefined) {
        for (const part of imported[2].split(',')) {
          const name = part.trim().split(/\s*(?:=>|as)\s*/)[0]!
          facts.imports.push(imp(name === '_' || name === '*' ? `${base}.*` : `${base}.${name}`, line))
        }
      } else facts.imports.push(imp(imported[3] ? `${base}.*` : base, line))
    }
    if (language === 'kotlin') {
      const type = /^\s*((?:(?:public|private|internal|protected|open|abstract|sealed|data|enum|annotation|inner|value|inline|expect|actual|fun)\s+)*)(class|interface|object)\s+(\w+)/.exec(plain)
      if (type && !/\bcompanion\s+object\b/.test(plain)) declarations.declare(type[3]!, type[2] === 'interface' ? 'interface' : type[1]!.includes('enum') ? 'enum' : 'class', line, !/\b(private|internal)\b/.test(type[1]!))
      else {
        const fn = /^\s*((?:(?:public|private|internal|protected|open|override|abstract|suspend|inline|operator|infix|tailrec|external|actual|expect)\s+)*)fun\s+(?:<[^>]*>\s*)?(?:[\w.<>?]+\.)?(\w+)\s*\(/.exec(plain)
        if (fn) {
          const parent = declarations.enclosingType()
          declarations.declare(fn[2]!, parent ? 'method' : 'function', line, !/\bprivate\b/.test(fn[1]!), parent)
        }
      }
    } else {
      const type = /^\s*((?:(?:private|protected|final|sealed|abstract|implicit|case|open)\s+)*)(class|trait|object|enum)\s+(\w+)/.exec(plain)
      if (type) declarations.declare(type[3]!, type[2] === 'trait' ? 'trait' : type[2] === 'enum' ? 'enum' : 'class', line, !/\bprivate\b/.test(type[1]!))
      else {
        const fn = /^\s*((?:(?:override|private|protected|final|implicit|inline)\s+)*)def\s+(\w+)/.exec(plain)
        if (fn) {
          const parent = declarations.enclosingType()
          declarations.declare(fn[2]!, parent ? 'method' : 'function', line, !/\bprivate\b/.test(fn[1]!), parent)
        }
      }
    }
    declarations.braces(plain, line)
  })
  facts.symbols.push(...declarations.symbols)
  facts.typeRefs = typeRefsOf(bare)
}

// ---------- PHP ----------

function phpFacts({ code, bare }: Prepared, facts: FileFacts): void {
  const declarations = new Declarations()
  code.forEach((text, index) => {
    const line = index + 1
    const plain = bare[index]!
    const namespace = /^\s*namespace\s+([\w\\]+)\s*[;{]/.exec(plain)
    if (namespace && facts.namespace === null) facts.namespace = namespace[1]!
    // 类里面的 use 是用 trait，不是导入
    const use = declarations.enclosingType() ? null : /^\s*use\s+(?:function\s+|const\s+)?([\w\\]+?)\\?(?:\{([^}]*)\})?\s*(?:as\s+\w+)?\s*(,[^;]*)?;/.exec(plain)
    if (use) {
      const base = use[1]!.replace(/^\\/, '')
      if (use[2] !== undefined) for (const part of use[2].split(',')) facts.imports.push(imp(`${base}\\${part.trim().split(/\s+as\s+/)[0]}`, line))
      else {
        facts.imports.push(imp(base, line))
        for (const more of (use[3] ?? '').split(',').slice(1)) {
          const name = more.trim().split(/\s+as\s+/)[0]!.replace(/^\\/, '')
          if (name) facts.imports.push(imp(name, line))
        }
      }
    }
    for (const match of text.matchAll(/\b(?:require|include)(?:_once)?\s*\(?\s*(__DIR__\s*\.\s*)?(['"])([^'"]+\.php)\2/g)) {
      const path = match[3]!
      facts.imports.push(imp(match[1] ? `.${path.startsWith('/') ? '' : '/'}${path}` : path, line, 'require'))
    }
    const type = /^\s*(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+(\w+)/.exec(plain)
    if (type) declarations.declare(type[2]!, type[1] === 'interface' ? 'interface' : type[1] === 'trait' ? 'trait' : type[1] === 'enum' ? 'enum' : 'class', line, true)
    else {
      const fn = /^\s*((?:(?:public|private|protected|static|abstract|final)\s+)*)function\s+&?\s*(\w+)\s*\(/.exec(plain)
      if (fn) {
        const parent = declarations.enclosingType()
        declarations.declare(fn[2]!, parent ? 'method' : 'function', line, !/\b(private|protected)\b/.test(fn[1]!), parent)
      }
    }
    declarations.braces(plain, line)
  })
  facts.symbols.push(...declarations.symbols)
  facts.typeRefs = typeRefsOf(bare)
}

// ---------- Ruby ----------

// Ruby 用 end 收尾：声明的范围到同样缩进的 end
function rubyFacts({ code, bare }: Prepared, facts: FileFacts): void {
  const open: Array<{ symbol: SymbolFact; indent: number }> = []
  code.forEach((text, index) => {
    const line = index + 1
    const plain = bare[index]!
    const indent = /^\s*/.exec(plain)![0].length
    if (plain.trim() !== '') {
      while (open.length > 0 && indent <= open[open.length - 1]!.indent && /^\s*end\b/.test(plain)) {
        const top = open.pop()!
        if (indent === top.indent) {
          top.symbol.endLine = line
          break
        }
      }
    }
    const required = /^\s*(require_relative|require)\s*\(?\s*['"]([^'"]+)['"]/.exec(text)
    if (required) facts.imports.push(imp(required[1] === 'require_relative' ? `./${required[2]!.replace(/^\.\//, '')}` : required[2]!, line, 'require'))
    const type = /^\s*(class|module)\s+([A-Z][\w:]*)/.exec(plain)
    const parent = [...open].reverse().find((item) => item.symbol.kind === 'class' || item.symbol.kind === 'module')?.symbol.name ?? null
    if (type && !/^\s*class\s*<</.test(plain)) {
      const symbol: SymbolFact = { name: type[2]!.split('::').pop()!, kind: type[1] === 'module' ? 'module' : 'class', line, endLine: line, exported: true, parent }
      facts.symbols.push(symbol)
      open.push({ symbol, indent })
      return
    }
    const fn = /^\s*def\s+(self\.)?([\w?!=]+)/.exec(plain)
    if (fn) {
      const symbol: SymbolFact = { name: fn[2]!, kind: parent ? 'method' : 'function', line, endLine: line, exported: true, parent }
      facts.symbols.push(symbol)
      // 一行写完的 def x = 1、def x; end 不开范围
      if (!/\bend\s*$/.test(plain) && !/^\s*def\s+[\w?!=.]+(\([^)]*\))?\s*=/.test(plain)) open.push({ symbol, indent })
    }
  })
}

// ---------- Swift ----------

function swiftFacts({ code, bare }: Prepared, facts: FileFacts): void {
  const declarations = new Declarations()
  code.forEach((text, index) => {
    const line = index + 1
    const plain = bare[index]!
    const imported = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*import\s+(?:(?:class|struct|enum|protocol|func|var|let|typealias)\s+)?([\w.]+)/.exec(plain)
    if (imported) facts.imports.push(imp(imported[1]!.split('.')[0]!, line))
    const type = /^\s*((?:(?:public|private|internal|fileprivate|open|final|indirect|@\w+)\s+)*)(class|struct|enum|protocol|actor|extension)\s+(\w+)/.exec(plain)
    if (type && !/^\s*class\s+(func|var|let)\b/.test(plain)) {
      const keyword = type[2]!
      const kind: SymbolKind = keyword === 'protocol' ? 'interface' : keyword === 'enum' ? 'enum' : keyword === 'struct' ? 'struct' : keyword === 'extension' ? 'impl' : 'class'
      declarations.declare(type[3]!, kind, line, !/\b(private|fileprivate)\b/.test(type[1]!))
    } else {
      const fn = /^\s*((?:(?:public|private|internal|fileprivate|open|static|class|override|final|mutating|nonmutating|@\w+)\s+)*)func\s+(\w+)/.exec(plain)
      if (fn) {
        const parent = declarations.enclosingType()
        declarations.declare(fn[2]!, parent ? 'method' : 'function', line, !/\b(private|fileprivate)\b/.test(fn[1]!), parent)
      }
    }
    declarations.braces(plain, line)
  })
  facts.symbols.push(...declarations.symbols)
  facts.typeRefs = typeRefsOf(bare)
}

// ---------- Dart ----------

const DART_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'else', 'catch', 'assert', 'super', 'this'])

function dartFacts({ code, bare }: Prepared, facts: FileFacts): void {
  const declarations = new Declarations()
  code.forEach((text, index) => {
    const line = index + 1
    const plain = bare[index]!
    const directive = /^\s*(import|export|part)\s+['"]([^'"]+)['"]/.exec(text)
    if (directive && !/^\s*part\s+of\b/.test(text)) facts.imports.push(imp(directive[2]!, line, directive[1] === 'export' ? 'reexport' : 'import'))
    const type = /^\s*(?:(?:abstract|sealed|base|final|interface|mixin)\s+)*(class|mixin|enum|extension|typedef)\s+(\w+)/.exec(plain)
    if (type) {
      const keyword = type[1]!
      declarations.declare(type[2]!, keyword === 'enum' ? 'enum' : keyword === 'extension' ? 'impl' : keyword === 'typedef' ? 'type' : 'class', line, !type[2]!.startsWith('_'))
    } else {
      const fn = /^\s*(?:(?:static|external|factory|@\w+)\s+)*(?:[\w<>?,\s]+\s+)?(\w+)\s*\([^;]*\)\s*(?:async\*?\s*|sync\*\s*)?(?:\{|=>)/.exec(plain)
      if (fn && !DART_KEYWORDS.has(fn[1]!)) {
        const parent = declarations.enclosingType()
        declarations.declare(fn[1]!, parent ? 'method' : 'function', line, !fn[1]!.startsWith('_'), parent)
      }
    }
    declarations.braces(plain, line)
  })
  facts.symbols.push(...declarations.symbols)
  facts.typeRefs = typeRefsOf(bare)
}
