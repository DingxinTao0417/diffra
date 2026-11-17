import { isAbsolute, posix, relative } from 'node:path'
import { type ArchitectureAnalysis, evaluateTarget, type FileInfo, type RuntimeTrace, stronglyConnected, type TargetArchitecture } from './model.js'

// 任务里的智能体查架构图（v2 · M9）：读已有的分析结果回答，不重新分析。结果是给模型看的纯文本，有长度上限
export const QUERY_ACTIONS = ['overview', 'dependencies', 'dependents', 'symbols', 'find', 'path', 'violations', 'calls', 'callers', 'runtime'] as const
export type QueryAction = (typeof QUERY_ACTIONS)[number]

export interface QueryInput {
  action: QueryAction
  path?: string
  to?: string
  symbol?: string
}

const MAX_CHARS = 12_000
const LIST = 40

class Output {
  private readonly lines: string[] = []
  private chars = 0
  truncated = false

  add(line: string): void {
    if (this.truncated) return
    if (this.chars + line.length > MAX_CHARS) {
      this.truncated = true
      return
    }
    this.lines.push(line)
    this.chars += line.length + 1
  }

  text(): string {
    return this.lines.join('\n') + (this.truncated ? '\n…(truncated; narrow the path to see more)' : '')
  }
}

// 用户和模型给的路径：绝对路径换成相对项目根，反斜杠换正斜杠，去掉开头的 ./ 和结尾的 /
export function normalizeQueryPath(root: string, raw: string): string {
  const trimmed = raw.trim()
  const relativePath = isAbsolute(trimmed) ? relative(root, trimmed) : trimmed
  return relativePath.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '').replace(/^\.$/, '')
}

// 路径对上的文件：正好是这个文件，或者在这个目录下；空字符串是整个项目
function filesUnder(analysis: ArchitectureAnalysis, path: string): number[] {
  const exact = analysis.files.findIndex((file) => file.path === path)
  if (exact >= 0) return [exact]
  const prefix = path === '' ? '' : `${path}/`
  return analysis.files.flatMap((file, index) => (file.path.startsWith(prefix) ? [index] : []))
}

const dirOf = (path: string) => {
  const dir = posix.dirname(path)
  return dir === '.' ? '' : dir
}

const lineList = (lines: number[]) => {
  const unique = [...new Set(lines)].sort((a, b) => a - b)
  return unique.length > 5 ? `${unique.slice(0, 5).join(',')},…` : unique.join(',')
}

function notFound(analysis: ArchitectureAnalysis, path: string): string {
  const name = posix.basename(path).toLowerCase()
  const similar = name ? analysis.files.filter((file) => posix.basename(file.path).toLowerCase().includes(name)).slice(0, 8) : []
  return `No analyzed code file or directory matches "${path}".${similar.length ? ` Similar: ${similar.map((file) => file.path).join(', ')}` : ''} Paths are relative to the project root.`
}

export function runArchitectureQuery(analysis: ArchitectureAnalysis, target: TargetArchitecture | null, input: QueryInput, runtime: RuntimeTrace | null = null): string {
  const out = new Output()
  const path = normalizeQueryPath(analysis.root, input.path ?? '')
  switch (input.action) {
    case 'overview':
      overview(analysis, target, out)
      break
    case 'dependencies':
    case 'dependents': {
      const files = filesUnder(analysis, path)
      if (files.length === 0) return notFound(analysis, path)
      links(analysis, files, path, input.action === 'dependencies', out)
      break
    }
    case 'symbols': {
      const files = filesUnder(analysis, path)
      if (files.length === 0) return notFound(analysis, path)
      symbols(analysis, files, out)
      break
    }
    case 'find':
      if (!input.symbol?.trim()) return 'Give symbol: a function, class or type name (or part of it) to look up.'
      find(analysis, input.symbol.trim(), out)
      break
    case 'path': {
      const to = normalizeQueryPath(analysis.root, input.to ?? '')
      const from = filesUnder(analysis, path)
      const goal = filesUnder(analysis, to)
      if (from.length === 0) return notFound(analysis, path)
      if (goal.length === 0) return notFound(analysis, to)
      dependencyPath(analysis, from, goal, path, to, out)
      break
    }
    case 'violations':
      if (!target) return 'This project has no target architecture yet (the user can draw one on the Architecture page).'
      violations(analysis, target, out)
      break
    case 'calls':
    case 'callers':
      return calls(analysis, path, input.symbol?.trim() ?? '', input.action === 'calls')
    case 'runtime':
      if (!runtime) return 'No runtime trace yet (the user can run one on the Architecture page: it runs a command such as the tests and records which functions actually ran).'
      runtimeSummary(analysis, runtime, path, out)
      break
  }
  return out.text()
}

// 运行时追踪：最花时间的函数、静态分析没看到的调用（动态分派、回调）；给了路径就只看这个文件或目录
function runtimeSummary(analysis: ArchitectureAnalysis, runtime: RuntimeTrace, path: string, out: Output): void {
  const inside = new Set(filesUnder(analysis, path))
  const name = (file: number) => analysis.files[file]?.path ?? `#${file}`
  out.add(`Runtime trace of \`${runtime.command}\` at ${runtime.startedAt}: exit code ${runtime.exitCode ?? 'none'}${runtime.timedOut ? ' (timed out)' : ''}, ${runtime.durationMs} ms, ${runtime.files} project files ran (${runtime.languages.join(', ') || 'no Node.js/Python profile'}). Times are ${runtime.languages.includes('node') ? 'sampled for Node.js' : 'measured'}; only what this command exercised.`)
  for (const note of runtime.notes) out.add(`Note: ${note}`)
  const functions = runtime.functions.filter((item) => inside.has(item.file))
  out.add('Hottest functions (total ms incl. callees / self ms / calls):')
  for (const item of functions.slice(0, 25)) out.add(`- ${name(item.file)} ${item.symbol}: ${item.totalMs} / ${item.selfMs}${item.calls !== null ? ` / ${item.calls}` : ''}`)
  const staticLinks = new Set((analysis.calls ?? []).map((call) => `${call.from}\u0000${call.fromSymbol}\u0000${call.to}\u0000${call.toSymbol}`))
  const dynamic = runtime.links.filter((link) => (inside.has(link.from) || inside.has(link.to)) && !staticLinks.has(`${link.from}\u0000${link.fromSymbol}\u0000${link.to}\u0000${link.toSymbol}`))
  out.add(`Calls seen at runtime but not in the static call graph (callbacks, dynamic dispatch, calls through libraries): ${dynamic.length}`)
  for (const link of dynamic.slice(0, 25)) out.add(`- ${name(link.from)} ${link.fromSymbol} → ${name(link.to)} ${link.toSymbol} (${link.ms} ms${link.calls !== null ? `, ${link.calls} calls` : ''})`)
  const ran = new Set(runtime.functions.map((item) => item.file))
  const idle = [...inside].filter((file) => analysis.files[file]!.parsed && !ran.has(file))
  if (idle.length) out.add(`${idle.length} analyzed files did not run, e.g. ${idle.slice(0, 8).map(name).join(', ')}`)
}

function overview(analysis: ArchitectureAnalysis, target: TargetArchitecture | null, out: Output): void {
  const { stats } = analysis
  out.add(`Project ${analysis.root}, analyzed ${analysis.analyzedAt}${analysis.git.branch ? ` on branch ${analysis.git.branch}` : ''}. Code changed after that is not reflected.`)
  out.add(`${stats.files} code files, ${stats.lines} lines. Languages: ${stats.languages.map((item) => `${item.language} ${item.files} files/${item.lines} lines`).join('; ')}`)
  if (analysis.packages.length > 0) {
    out.add('Packages:')
    for (const item of analysis.packages.slice(0, LIST)) out.add(`- ${item.name} (${item.dir || '.'}, ${item.ecosystem})${item.entries.length ? ` entries: ${item.entries.slice(0, 4).join(', ')}` : ''}`)
  }
  // 顶层往下两级目录，按行数排，带它依赖的其他目录
  const depth = Math.min(2, Math.max(1, ...analysis.modules.map((module) => module.path.split('/').length)))
  const modules = analysis.modules.filter((module) => module.path !== '' && module.path.split('/').length <= depth).sort((a, b) => b.lines - a.lines)
  const moduleOf = (file: FileInfo) => file.path.split('/').slice(0, depth).join('/')
  const uses = new Map<string, Map<string, number>>()
  for (const edge of analysis.edges) {
    const from = moduleOf(analysis.files[edge.from]!)
    const to = moduleOf(analysis.files[edge.to]!)
    if (from === to) continue
    const targets = uses.get(from) ?? new Map<string, number>()
    targets.set(to, (targets.get(to) ?? 0) + 1)
    uses.set(from, targets)
  }
  out.add(`Directories (by lines, with the directories they import from):`)
  for (const module of modules.slice(0, LIST)) {
    const targets = [...(uses.get(module.path) ?? new Map<string, number>())].sort((a, b) => b[1] - a[1]).slice(0, 8)
    out.add(`- ${module.path}: ${module.files} files, ${module.lines} lines${targets.length ? ` → ${targets.map(([name, count]) => `${name} (${count})`).join(', ')}` : ''}`)
  }
  const cycles = fileCycles(analysis)
  out.add(cycles.length ? `${cycles.length} import cycles between files, e.g.: ${cycles.slice(0, 3).map((cycle) => cycle.slice(0, 6).map((index) => analysis.files[index]!.path).join(' → ')).join(' | ')}` : 'No import cycles between files.')
  const externals = analysis.externals.filter((item) => !item.builtin).slice(0, 20)
  if (externals.length) out.add(`Most used external packages: ${externals.map((item) => `${item.name} (${item.count})`).join(', ')}`)
  if (analysis.calls) out.add(`Function call graph: ${analysis.calls.length} resolved call links. Use action calls/callers with path and symbol.`)
  if (target) {
    const evaluation = evaluateTarget(analysis, target)
    out.add(`Target architecture: ${target.rules.length} rules, ${evaluation.violations.length} violated. Use action violations for details.`)
  } else out.add('No target architecture.')
}

function fileCycles(analysis: ArchitectureAnalysis): number[][] {
  const neighbors = new Map<number, number[]>()
  for (const edge of analysis.edges) neighbors.set(edge.from, [...(neighbors.get(edge.from) ?? []), edge.to])
  return stronglyConnected(analysis.files.length, (node) => neighbors.get(node) ?? []).filter((component) => component.length > 1)
}

function links(analysis: ArchitectureAnalysis, files: number[], path: string, outgoing: boolean, out: Output): void {
  const inside = new Set(files)
  const single = files.length === 1 && analysis.files[files[0]!]!.path === path
  const label = single ? path : `${path || 'the project'}/ (${files.length} files)`
  // 目录：只算进出这个目录的依赖，按对面的文件归到它所在目录
  const found = analysis.edges.filter((edge) => (outgoing ? inside.has(edge.from) && !inside.has(edge.to) : inside.has(edge.to) && !inside.has(edge.from)))
  if (single) {
    out.add(outgoing ? `${label} imports ${found.length} project files:` : `${found.length} project files import ${label}:`)
    for (const edge of found.slice(0, LIST * 2)) {
      const other = analysis.files[outgoing ? edge.to : edge.from]!.path
      const names = [...new Set(edge.imports.flatMap((item) => item.names))].slice(0, 8)
      const lines = lineList(edge.imports.map((item) => item.line))
      out.add(`- ${outgoing ? `${other} (line ${lines})` : `${other}:${lines}`}${names.length ? ` names: ${names.join(', ')}` : ''}`)
    }
  } else {
    const byDir = new Map<string, Array<{ edge: (typeof found)[number]; other: string }>>()
    for (const edge of found) {
      const other = analysis.files[outgoing ? edge.to : edge.from]!.path
      const list = byDir.get(dirOf(other)) ?? []
      list.push({ edge, other })
      byDir.set(dirOf(other), list)
    }
    out.add(outgoing ? `${label} imports from ${byDir.size} other directories:` : `${byDir.size} other directories import ${label}:`)
    for (const [dir, items] of [...byDir].sort((a, b) => b[1].length - a[1].length).slice(0, LIST)) {
      const sample = items.slice(0, 3).map(({ edge }) => `${analysis.files[edge.from]!.path}:${edge.imports[0]?.line ?? 1} → ${analysis.files[edge.to]!.path}`)
      out.add(`- ${dir || '.'}: ${items.length} file links, e.g. ${sample.join('; ')}`)
    }
  }
  if (outgoing) {
    const externals = analysis.externals.filter((item) => item.uses.some((use) => inside.has(use.file)))
    if (externals.length) out.add(`External packages used: ${externals.slice(0, LIST).map((item) => `${item.name}${item.builtin ? ' (builtin)' : ''}`).join(', ')}${externals.some((item) => item.uses.length >= 50) ? ' (use lists are capped, may be incomplete)' : ''}`)
  }
}

function symbols(analysis: ArchitectureAnalysis, files: number[], out: Output): void {
  for (const index of files.slice(0, LIST * 3)) {
    const file = analysis.files[index]!
    if (!file.parsed) {
      out.add(`${file.path} (${file.language}, ${file.lines} lines): not parsed for symbols`)
      continue
    }
    const shown = files.length === 1 ? file.symbols : file.symbols.filter((symbol) => symbol.exported)
    out.add(`${file.path} (${file.language}, ${file.lines} lines${file.entry ? ', entry point' : ''})${files.length > 1 ? ' exported:' : ':'}`)
    for (const symbol of shown.slice(0, files.length === 1 ? 200 : 15)) out.add(`  ${symbol.kind} ${symbol.parent ? `${symbol.parent}.` : ''}${symbol.name} lines ${symbol.line}-${symbol.endLine}${symbol.exported ? ' exported' : ''}`)
  }
  if (files.length > LIST * 3) out.add(`…and ${files.length - LIST * 3} more files; narrow the path.`)
}

function find(analysis: ArchitectureAnalysis, query: string, out: Output): void {
  const lower = query.toLowerCase()
  const hits: Array<{ rank: number; text: string }> = []
  for (const file of analysis.files) {
    for (const symbol of file.symbols) {
      const name = symbol.name.toLowerCase()
      const rank = name === lower ? 0 : name.startsWith(lower) ? 1 : name.includes(lower) ? 2 : -1
      if (rank >= 0) hits.push({ rank, text: `${file.path}:${symbol.line} ${symbol.kind} ${symbol.parent ? `${symbol.parent}.` : ''}${symbol.name}${symbol.exported ? ' (exported)' : ''}` })
    }
  }
  if (hits.length === 0) {
    out.add(`No symbol named like "${query}". Symbols are only extracted for ${[...new Set(analysis.files.filter((file) => file.parsed).map((file) => file.language))].join(', ') || 'no'} files.`)
    return
  }
  hits.sort((a, b) => a.rank - b.rank)
  for (const hit of hits.slice(0, 60)) out.add(hit.text)
  if (hits.length > 60) out.add(`…${hits.length - 60} more`)
}

// 广度优先找一条最短的依赖链：from 里任何一个文件 → to 里任何一个文件
function dependencyPath(analysis: ArchitectureAnalysis, from: number[], goal: number[], fromLabel: string, toLabel: string, out: Output): void {
  const targets = new Set(goal)
  const outgoing = new Map<number, Array<{ to: number; line: number }>>()
  for (const edge of analysis.edges) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), { to: edge.to, line: edge.imports[0]?.line ?? 1 }])
  const previous = new Map<number, { from: number; line: number } | null>()
  const queue = [...from]
  for (const start of from) previous.set(start, null)
  let found: number | null = null
  while (queue.length > 0 && found === null) {
    const node = queue.shift()!
    if (targets.has(node) && !from.includes(node)) {
      found = node
      break
    }
    for (const next of outgoing.get(node) ?? []) {
      if (previous.has(next.to)) continue
      previous.set(next.to, { from: node, line: next.line })
      queue.push(next.to)
    }
  }
  if (found === null) {
    out.add(`${fromLabel || 'the project'} does not depend on ${toLabel} (directly or indirectly) through project imports.`)
    return
  }
  const chain: string[] = []
  let node: number | null = found
  while (node !== null) {
    const step: { from: number; line: number } | null = previous.get(node) ?? null
    chain.unshift(step ? `${analysis.files[step.from]!.path}:${step.line} imports ${analysis.files[node]!.path}` : '')
    node = step?.from ?? null
  }
  out.add(`Shortest dependency path (${chain.filter(Boolean).length} steps):`)
  for (const step of chain.filter(Boolean)) out.add(`- ${step}`)
}

function violations(analysis: ArchitectureAnalysis, target: TargetArchitecture, out: Output): void {
  const evaluation = evaluateTarget(analysis, target)
  out.add(`Target architecture rules: ${target.rules.length}.`)
  if (evaluation.violations.length === 0) out.add('No violations in the analyzed code.')
  for (const violation of evaluation.violations.slice(0, LIST)) {
    out.add(`- ${violation.message} (${violation.edges.length} imports)`)
    for (const edge of violation.edges.slice(0, 5)) out.add(`  ${analysis.files[edge.from]!.path}:${edge.line} → ${analysis.files[edge.to]?.path ?? edge.specifier}`)
  }
  if (evaluation.planned.length) out.add(`Planned components without code yet: ${evaluation.planned.join(', ')}`)
  if (evaluation.unassigned.length) out.add(`${evaluation.unassigned.length} code files are not claimed by any component, e.g. ${evaluation.unassigned.slice(0, 5).map((index) => analysis.files[index]!.path).join(', ')}`)
}

// 函数级调用图（见 analysis.calls）：一个函数调了谁、谁调了它
function calls(analysis: ArchitectureAnalysis, path: string, symbol: string, outgoing: boolean): string {
  if (!analysis.calls) return 'The function call graph is not available for this analysis (re-analyze the project on the Architecture page).'
  if (!symbol) return 'Give path (the file) and symbol (the function or method name, Class.method for methods).'
  const file = analysis.files.findIndex((item) => item.path === path)
  if (file < 0) return notFound(analysis, path)
  const matches = (owner: number, name: string) => owner === file && (name === symbol || name.endsWith(`.${symbol}`))
  const found = analysis.calls.filter((call) => (outgoing ? matches(call.from, call.fromSymbol) : matches(call.to, call.toSymbol)))
  if (found.length === 0) {
    const defined = analysis.files[file]!.symbols.some((item) => item.name === symbol || `${item.parent}.${item.name}` === symbol)
    return defined
      ? `${outgoing ? `${symbol} calls no other project function that could be resolved statically` : `No resolved callers of ${symbol} in the project`} (dynamic dispatch, callbacks and calls through variables are not tracked).`
      : `${path} has no function or method named ${symbol}. Use action symbols to list them.`
  }
  const out = new Output()
  out.add(outgoing ? `${path} ${symbol} calls:` : `Callers of ${path} ${symbol}:`)
  for (const call of found.slice(0, LIST * 2)) {
    const other = outgoing ? `${analysis.files[call.to]!.path} ${call.toSymbol}` : `${analysis.files[call.from]!.path} ${call.fromSymbol}`
    out.add(`- ${other} (call at ${analysis.files[call.from]!.path}:${lineList(call.lines)})`)
  }
  return out.text()
}
