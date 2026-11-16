import { posix } from 'node:path'
import type { CallFact, CallLink, FileEdge, FileInfo, SourceLanguage, SymbolFact } from './model.js'

// 函数级调用图（v2 · M9）：把每个文件里的调用处对到项目里定义的函数和方法。只按静态能看出来的对：
// 本文件里的函数、import 进来的名字、命名空间或模块前缀（ns.f、pkg.F、mod.f）、类名前缀（Class.m）、this/self 调本类的方法、
// Go 同一个包里别的文件的函数。通过变量、回调、继承、接口分派的调用对不上，不猜。
export const MAX_CALL_LINKS = 100_000
const MODULE_SCOPE = '(module)'

export interface CallSource {
  language: SourceLanguage
  calls: CallFact[]
}

interface FileIndex {
  topLevel: Map<string, string>
  methods: Map<string, string>
  callables: SymbolFact[]
}

const qualified = (symbol: SymbolFact) => (symbol.parent ? `${symbol.parent}.${symbol.name}` : symbol.name)
const CALLABLE = new Set(['function', 'method', 'class', 'struct', 'variable', 'constant'])

function indexFile(file: FileInfo): FileIndex {
  const topLevel = new Map<string, string>()
  const methods = new Map<string, string>()
  for (const symbol of file.symbols) {
    if (!CALLABLE.has(symbol.kind) && symbol.kind !== 'impl') continue
    if (symbol.parent) methods.set(`${symbol.parent}.${symbol.name}`, qualified(symbol))
    else if (!topLevel.has(symbol.name)) topLevel.set(symbol.name, symbol.name)
  }
  // 按范围从小到大排，找包住某一行的函数时先碰到最里面的
  const callables = file.symbols.filter((symbol) => symbol.kind === 'function' || symbol.kind === 'method').sort((a, b) => a.endLine - a.line - (b.endLine - b.line))
  return { topLevel, methods, callables }
}

const stem = (path: string) => posix.basename(path).replace(/\.[^.]+$/, '')

// tick：大仓库里分片跑，每个文件之后让一次（见 engine 的 slicer）
export async function resolveCalls(files: FileInfo[], sources: Array<CallSource | null>, edges: FileEdge[], tick: () => Promise<void> = async () => {}): Promise<CallLink[]> {
  const indexes = files.map(indexFile)
  const outgoing = new Map<number, FileEdge[]>()
  for (const edge of edges) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge])
  // Go：同一个目录、同一个 package 名的文件互相直接调
  const goPackages = new Map<string, number[]>()
  files.forEach((file, index) => {
    if (sources[index]?.language !== 'go') return
    const key = `${posix.dirname(file.path)}\u0000${file.namespace ?? ''}`
    goPackages.set(key, [...(goPackages.get(key) ?? []), index])
  })

  const links = new Map<string, CallLink>()
  const add = (from: number, fromSymbol: string, to: number, toSymbol: string, line: number) => {
    if (from === to && fromSymbol === toSymbol) return
    const key = `${from}\u0000${fromSymbol}\u0000${to}\u0000${toSymbol}`
    const existing = links.get(key)
    if (existing) {
      if (!existing.lines.includes(line) && existing.lines.length < 20) existing.lines.push(line)
      return
    }
    if (links.size >= MAX_CALL_LINKS) return
    links.set(key, { from, fromSymbol, to, toSymbol, lines: [line] })
  }

  for (let from = 0; from < files.length; from++) {
    const source = sources[from]
    if (!source || source.calls.length === 0) continue
    await tick()
    const file = files[from]!
    const own = indexes[from]!
    // import 进来的名字 → 文件；按文件名、Go 的包名、Java 的类名、Python 的模块名当前缀能对上的文件
    const imported = new Map<string, number[]>()
    const prefixes = new Map<string, number[]>()
    const push = (map: Map<string, number[]>, key: string, value: number) => {
      const list = map.get(key) ?? []
      if (!list.includes(value)) list.push(value)
      map.set(key, list)
    }
    for (const edge of outgoing.get(from) ?? []) {
      const target = files[edge.to]!
      push(prefixes, stem(target.path), edge.to)
      if (target.namespace) push(prefixes, target.namespace.split(/[./]/).pop()!, edge.to)
      for (const item of edge.imports) {
        for (const name of item.names) push(imported, name, edge.to)
        if (item.local) push(prefixes, item.local, edge.to)
        const last = item.specifier.split(/[./:]+/).filter(Boolean).pop()
        if (last) push(prefixes, last, edge.to)
      }
    }
    const samePackage = source.language === 'go' ? (goPackages.get(`${posix.dirname(file.path)}\u0000${file.namespace ?? ''}`) ?? []).filter((index) => index !== from) : []

    for (const [name, qualifier, line] of source.calls) {
      const caller = own.callables.find((symbol) => symbol.line <= line && line <= symbol.endLine)
      const fromSymbol = caller ? qualified(caller) : MODULE_SCOPE
      const callerClass = caller?.parent ?? null
      if (qualifier === '?') continue
      if (qualifier === 'self') {
        if (callerClass) {
          const method = own.methods.get(`${callerClass}.${name}`)
          if (method) add(from, fromSymbol, from, method, line)
        }
        continue
      }
      if (qualifier === null) {
        // Java 里不带前缀调的是本类的方法
        const sameClass = callerClass ? own.methods.get(`${callerClass}.${name}`) : undefined
        if (sameClass && source.language === 'java') {
          add(from, fromSymbol, from, sameClass, line)
          continue
        }
        const local = own.topLevel.get(name)
        if (local) {
          add(from, fromSymbol, from, local, line)
          continue
        }
        let found = false
        for (const target of imported.get(name) ?? []) {
          const symbol = indexes[target]!.topLevel.get(name)
          if (symbol) {
            add(from, fromSymbol, target, symbol, line)
            found = true
          }
        }
        if (found) continue
        // Java 的 new Foo()、Go 同包的函数
        for (const target of [...(prefixes.get(name) ?? []), ...samePackage]) {
          const symbol = indexes[target]!.topLevel.get(name)
          if (symbol) add(from, fromSymbol, target, symbol, line)
        }
        continue
      }
      // 带前缀：本文件的类、import 进来的类（静态方法）、命名空间或模块
      const ownMethod = own.methods.get(`${qualifier}.${name}`)
      if (ownMethod) {
        add(from, fromSymbol, from, ownMethod, line)
        continue
      }
      for (const target of new Set([...(imported.get(qualifier) ?? []), ...(prefixes.get(qualifier) ?? [])])) {
        const index = indexes[target]!
        const symbol = index.methods.get(`${qualifier}.${name}`) ?? index.topLevel.get(name)
        if (symbol) add(from, fromSymbol, target, symbol, line)
      }
    }
  }
  return [...links.values()].sort((a, b) => a.from - b.from || a.to - b.to || (a.fromSymbol < b.fromSymbol ? -1 : 1))
}
