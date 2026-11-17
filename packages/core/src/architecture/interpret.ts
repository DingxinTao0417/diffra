import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { type LanguageModelUsage, streamText, tool, ToolChoiceViolationError } from 'ai'
import { z } from 'zod'
import { rejectsToolChoice } from '../models/errors.js'
import { createLanguageModel, MODEL_CALL_HEADERS } from '../models/operations.js'
import { streamParts } from '../models/stream.js'
import type { SessionModel } from '../protocol.js'
import { IdMaker, keepPinned, verifyDiagram } from './diagrams.js'
import { topLevelGroups } from './engine.js'
import {
  ARCHITECTURE_VERSION,
  type ArchitectureAnalysis,
  type ArchitectureFlow,
  type ArchitectureInterpretation,
  type BlockDiagram,
  type CodeAnchor,
  type DiagramBlock,
  diagramBlocks,
  type DiagramKind,
  type FlowChart,
  type FlowChartEdge,
  type FlowChartGroup,
  type FlowChartNode,
  type ModuleNote,
  type TargetArchitecture,
  type TargetRule,
} from './model.js'

const TIMEOUT_MS = 180_000
const MAX_DIRS = 120
const MAX_GRAPH_MODULES = 60
const MAX_KEY_FILES = 40
const MAX_SYMBOLS_PER_FILE = 15
const MAX_EXTERNALS = 40
const README_CHARS = 4000
const MODULE_SOURCE_CHARS = 30_000
const MODULE_FILE_HEAD_LINES = 150
// 流程图带的代码：总量、单个文件的上限；文件放不下时取代码位置前后这几行
const FLOW_SOURCE_CHARS = 40_000
const FLOW_FILE_CHARS = 14_000
const FLOW_LINES_BEFORE = 30
const FLOW_LINES_AFTER = 150

export interface ModelCallResult<T> {
  value: T
  usage: LanguageModelUsage | null
}

// 和提示词优化一样：走流式接口，强制只调一个提交工具；服务不接受强制时改用 auto（系统提示词里也要求了调它）
async function submitOnce<T>(model: SessionModel, system: string, prompt: string, toolName: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<ModelCallResult<T>> {
  const languageModel = createLanguageModel(model.endpoint, model.modelId, model.reasoningEffort, model.maxOutputTokens)
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const ask = async (toolChoice: 'auto' | { type: 'tool'; toolName: string }) => {
    const attempt = new AbortController()
    const result = streamText({
      model: languageModel,
      system,
      prompt,
      tools: { [toolName]: tool({ description: 'Submit the result.', inputSchema: schema }) },
      toolChoice,
      maxRetries: 1,
      abortSignal: AbortSignal.any([...(signal ? [signal] : []), timeout, attempt.signal]),
      headers: MODEL_CALL_HEADERS,
    })
    let input: unknown
    let usage: LanguageModelUsage | null = null
    try {
      for await (const part of streamParts(result.fullStream, () => attempt.abort())) {
        if (part.type === 'tool-call' && part.toolName === toolName) input = part.input
        if (part.type === 'finish-step') usage = part.usage
      }
    } catch (error) {
      // 模型只回了文字、没调提交工具：和没交结果一样说
      if (!ToolChoiceViolationError.isInstance(error)) throw error
    }
    return { input, usage }
  }
  const { input, usage } = await ask({ type: 'tool', toolName }).catch((error: unknown) => {
    if (rejectsToolChoice(error)) return ask('auto')
    throw error
  })
  if (input === undefined) throw new Error('模型没有交回结果')
  return { value: schema.parse(input), usage }
}

// ---------- 交给模型的摘要 ----------

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

// 目录级的依赖：每个文件归到最近的、在 dirs 里的上级目录
function moduleGraph(analysis: ArchitectureAnalysis, dirs: string[]): Array<{ from: string; to: string; count: number }> {
  const sorted = [...dirs].sort((a, b) => b.length - a.length)
  const owner = analysis.files.map((file) => sorted.find((dir) => dir === '' || file.path.startsWith(`${dir}/`)) ?? null)
  const counts = new Map<string, number>()
  for (const edge of analysis.edges) {
    const from = owner[edge.from]
    const to = owner[edge.to]
    if (from === null || from === undefined || to === null || to === undefined || from === to) continue
    const key = `${from}\u0000${to}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts].map(([key, count]) => {
    const [from, to] = key.split('\u0000')
    return { from: from!, to: to!, count }
  })
}

// 选一层合适粒度的目录：顶层结构的每一组往下展开一级，按代码行数取前 MAX_GRAPH_MODULES 个
function keyModules(analysis: ArchitectureAnalysis): string[] {
  const groups = topLevelGroups(analysis)
  const dirs = new Set<string>()
  for (const group of groups) {
    const dir = group.id.replace(/^(package|dir):/, '')
    const children = analysis.modules.filter((module) => module.parent === dir && module.lines > 0)
    if (children.length === 0 || children.length > 12) dirs.add(dir)
    else for (const child of children) dirs.add(child.path)
  }
  return [...dirs]
    .sort((a, b) => (analysis.modules.find((module) => module.path === b)?.lines ?? 0) - (analysis.modules.find((module) => module.path === a)?.lines ?? 0))
    .slice(0, MAX_GRAPH_MODULES)
}

async function readmeExcerpt(root: string, files: readonly string[]): Promise<string> {
  const candidates = ['README.md', 'readme.md', 'README.zh-CN.md', 'README', 'AGENTS.md', 'CLAUDE.md']
  const parts: string[] = []
  for (const name of candidates) {
    const text = await readFile(join(root, name), 'utf8').catch(() => null)
    if (text) parts.push(`--- ${name} ---\n${clip(text.trim(), README_CHARS)}`)
    if (parts.length >= 2) break
  }
  const docs = files.filter((path) => /^docs?\/[^/]+\.md$/i.test(path)).slice(0, 20)
  if (docs.length > 0) parts.push(`Docs: ${docs.join(', ')}`)
  return parts.join('\n\n')
}

export async function architectureDigest(analysis: ArchitectureAnalysis): Promise<string> {
  const lines: string[] = []
  lines.push(`Project root: ${posix.basename(analysis.root.replace(/\\/g, '/'))}`)
  lines.push(`Size: ${analysis.stats.files} code files, ${analysis.stats.lines} lines. Languages: ${analysis.stats.languages.map((item) => `${item.language} ${item.files} files/${item.lines} lines`).join(', ')}`)
  lines.push('', 'Packages (manifests):')
  for (const item of analysis.packages) {
    const deps = item.dependencies.slice(0, 30).join(', ')
    lines.push(`- ${item.dir || '.'} [${item.ecosystem}] name=${item.name}${item.description ? ` — ${clip(item.description, 200)}` : ''}${item.entries.length ? `; entries: ${item.entries.join(', ')}` : ''}${deps ? `; declared deps: ${deps}` : ''}`)
  }

  const dirs = [...analysis.modules].filter((module) => module.path !== '').sort((a, b) => b.lines - a.lines).slice(0, MAX_DIRS)
  lines.push('', `Directories (largest ${dirs.length}; path: files/lines):`)
  for (const module of [...dirs].sort((a, b) => (a.path < b.path ? -1 : 1))) lines.push(`- ${module.path}/: ${module.files}/${module.lines}`)

  const modules = keyModules(analysis)
  lines.push('', 'Internal dependencies between key directories (from -> to: import count):')
  for (const link of moduleGraph(analysis, modules).sort((a, b) => b.count - a.count).slice(0, 200)) lines.push(`- ${link.from || '.'} -> ${link.to || '.'}: ${link.count}`)

  const fanIn = new Map<number, number>()
  for (const edge of analysis.edges) fanIn.set(edge.to, (fanIn.get(edge.to) ?? 0) + 1)
  const keyFiles = new Set<number>()
  analysis.files.forEach((file, index) => {
    if (file.entry) keyFiles.add(index)
  })
  for (const [index] of [...fanIn].sort((a, b) => b[1] - a[1]).slice(0, 25)) keyFiles.add(index)
  for (const index of analysis.files.map((_, index) => index).sort((a, b) => analysis.files[b]!.churn - analysis.files[a]!.churn).slice(0, 10)) keyFiles.add(index)
  lines.push('', 'Key files (entry points, most depended on, most changed) with top-level symbols "name(kind)@line":')
  for (const index of [...keyFiles].slice(0, MAX_KEY_FILES)) {
    const file = analysis.files[index]!
    const symbols = file.symbols.filter((symbol) => symbol.parent === null).slice(0, MAX_SYMBOLS_PER_FILE).map((symbol) => `${symbol.name}(${symbol.kind})@${symbol.line}`)
    lines.push(`- ${file.path} [${file.lines} lines${file.entry ? ', entry' : ''}, used by ${fanIn.get(index) ?? 0}, ${file.churn} commits]: ${symbols.join(' ')}`)
  }

  const externals = analysis.externals.filter((item) => !item.builtin).slice(0, MAX_EXTERNALS)
  lines.push('', 'Most used external packages (name: import count; example locations):')
  for (const external of externals) {
    const examples = external.uses.slice(0, 3).map((use) => `${analysis.files[use.file]?.path}:${use.line}`)
    lines.push(`- ${external.name} [${external.ecosystem}]: ${external.count}; ${examples.join(', ')}`)
  }
  const builtins = analysis.externals.filter((item) => item.builtin).slice(0, 25)
  if (builtins.length > 0) lines.push(`Runtime/standard library modules used: ${builtins.map((item) => `${item.name}(${item.count})`).join(', ')}`)

  const docs = await readmeExcerpt(analysis.root, analysis.files.map((file) => file.path))
  if (docs) lines.push('', 'Project documents:', docs)
  return lines.join('\n')
}

// ---------- 校验模型给的路径和代码位置 ----------

class PathIndex {
  private readonly files = new Map<string, number>()
  private readonly dirs = new Set<string>()
  dropped = 0

  constructor(private readonly analysis: ArchitectureAnalysis) {
    analysis.files.forEach((file, index) => this.files.set(file.path, index))
    for (const module of analysis.modules) this.dirs.add(module.path)
  }

  normalize(path: string): string {
    return path.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').replace(/:\d+$/, '')
  }

  // 目录或文件；对不上返回 null
  path(raw: string): string | null {
    const path = this.normalize(raw)
    if (path === '.' || path === '') return ''
    if (this.files.has(path) || this.dirs.has(path)) return path
    return null
  }

  // 必须对上的路径（入口、阅读顺序、模块说明）：对不上算丢掉一处
  required(raw: string): string | null {
    const path = this.path(raw)
    if (path === null) this.dropped++
    return path
  }

  anchor(raw: { path: string; line: number; symbol?: string | null | undefined } | null | undefined): CodeAnchor | null {
    if (!raw) return null
    const path = this.normalize(raw.path)
    const index = this.files.get(path)
    if (index === undefined) {
      this.dropped++
      return null
    }
    const file = this.analysis.files[index]!
    const symbolName = raw.symbol?.trim() || null
    const symbol = symbolName ? file.symbols.find((item) => item.name === symbolName || `${item.parent}.${item.name}` === symbolName) : undefined
    if (symbol) return { path, line: symbol.line, symbol: symbolName }
    if (!Number.isInteger(raw.line) || raw.line < 1 || raw.line > Math.max(file.lines, 1)) {
      this.dropped++
      return null
    }
    return { path, line: raw.line, symbol: null }
  }

}

const anchorSchema = z.object({
  path: z.string().describe('File path exactly as listed in the digest'),
  line: z.number().int().describe('1-based line'),
  symbol: z.string().nullable().optional().describe('Symbol name at that location, if any (preferred: the line is corrected from it)'),
})

const interpretationSchema = z.object({
  summary: z.string().describe('3-6 short paragraphs in Simplified Chinese: what the system does, how it is structured, how the parts talk to each other'),
  techStack: z.array(z.string()).max(20),
  entryPoints: z.array(z.object({ path: z.string(), description: z.string() })).max(12),
  readingOrder: z.array(z.object({ path: z.string(), reason: z.string() })).max(8).describe('Where a new developer should start reading, in order'),
  externalSystems: z
    .array(
      z.object({
        name: z.string(),
        kind: z.string().describe('e.g. 模型服务, 数据库, 浏览器, 操作系统, 文件系统, 第三方服务, 更新服务器'),
        description: z.string(),
        packages: z.array(z.string()).describe('External packages used to talk to it'),
        anchors: z.array(anchorSchema).max(5),
      }),
    )
    .max(15),
  flows: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        steps: z
          .array(
            z.object({
              from: z.string().describe('Directory/file path from the digest, or an external system name'),
              to: z.string(),
              action: z.string().describe('What happens, in Chinese, one line'),
              anchor: anchorSchema.nullable(),
            }),
          )
          .max(14),
      }),
    )
    .max(6)
    .describe('The most important runtime flows end to end'),
})

const INTERPRET_SYSTEM = [
  'You are a software architect. You get a digest of a codebase produced by static analysis (manifests, directory sizes, import graph between directories, key files with symbols and line numbers, external packages, docs).',
  'Explain its architecture for the developer who owns it. Write all prose in Simplified Chinese; keep code identifiers and paths as they are.',
  '- Every path you give must be copied exactly from the digest (directories without trailing slash). Never invent paths.',
  '- Code anchors must point at a file from the digest; prefer giving the symbol name listed for that file, its line is taken from the digest. If unsure about a location, use null instead of guessing.',
  '- Flows: pick the few flows that matter most for understanding the system (e.g. a user action through UI, process boundaries, to external services and back). Steps go between directories or external systems.',
  '- Be concrete and specific to this codebase; no generic advice.',
  '- Call submit_architecture exactly once.',
].join('\n')

export async function interpretArchitecture(
  analysis: ArchitectureAnalysis,
  model: SessionModel,
  previousNotes: ArchitectureInterpretation['notes'],
  signal?: AbortSignal,
): Promise<ModelCallResult<ArchitectureInterpretation>> {
  const digest = await architectureDigest(analysis)
  const { value, usage } = await submitOnce(model, INTERPRET_SYSTEM, `Codebase digest:\n${digest}`, 'submit_architecture', interpretationSchema, signal)
  const index = new PathIndex(analysis)
  const interpretation: ArchitectureInterpretation = {
    version: ARCHITECTURE_VERSION,
    generatedAt: new Date().toISOString(),
    model: { provider: model.provider?.name ?? model.endpoint.baseUrl, modelId: model.modelId },
    fingerprint: analysis.fingerprint,
    summary: value.summary.trim(),
    techStack: value.techStack,
    entryPoints: value.entryPoints.flatMap((item) => {
      const path = index.required(item.path)
      return path === null ? [] : [{ path, description: item.description }]
    }),
    readingOrder: value.readingOrder.flatMap((item) => {
      const path = index.required(item.path)
      return path === null ? [] : [{ path, reason: item.reason }]
    }),
    externalSystems: value.externalSystems.map((system) => ({
      name: system.name,
      kind: system.kind,
      description: system.description,
      packages: system.packages.filter((name) => analysis.externals.some((external) => external.name === name)),
      anchors: system.anchors.flatMap((anchor) => index.anchor(anchor) ?? []),
    })),
    flows: value.flows.map((flow) => ({
      name: flow.name,
      description: flow.description,
      steps: flow.steps.map((step) => ({
        from: index.path(step.from) ?? step.from.trim(),
        to: index.path(step.to) ?? step.to.trim(),
        action: step.action,
        anchor: index.anchor(step.anchor),
      })),
    })),
    // 重新解读时保留还对得上的单目录解读
    notes: Object.fromEntries(Object.entries(previousNotes).filter(([path]) => index.path(path) !== null)),
    dropped: 0,
  }
  interpretation.dropped = index.dropped
  return { value: interpretation, usage }
}

// ---------- 单个目录的解读 ----------

const moduleNoteSchema = z.object({
  summary: z.string().describe('2-4 short paragraphs in Simplified Chinese'),
  responsibilities: z.array(z.string()).max(8),
  keyFiles: z.array(z.object({ path: z.string(), role: z.string() })).max(10),
  risks: z.array(z.string()).max(6).describe('Concrete structural problems or risks visible in this module (coupling, cycles, oversized files, mixed responsibilities). Empty if none.'),
})

const MODULE_SYSTEM = [
  'You are a software architect explaining one directory of a codebase to its owner. You get its files with symbols, its dependencies inside and outside, and the beginning of its key files.',
  'Write all prose in Simplified Chinese; keep identifiers and paths unchanged. Paths must be copied from the input. Be specific to this code.',
  'Call submit_module exactly once.',
].join('\n')

export async function interpretModule(analysis: ArchitectureAnalysis, modulePath: string, model: SessionModel, signal?: AbortSignal): Promise<ModelCallResult<ModuleNote>> {
  const inside = (path: string) => modulePath === '' || path === modulePath || path.startsWith(`${modulePath}/`)
  const members = analysis.files.map((file, index) => ({ file, index })).filter(({ file }) => inside(file.path))
  if (members.length === 0) throw new Error(`「${modulePath || '.'}」下没有代码文件`)
  const memberSet = new Set(members.map(({ index }) => index))
  const lines: string[] = [`Directory: ${modulePath || '.'} (${members.length} files)`, '', 'Files with top-level symbols:']
  for (const { file } of members.slice(0, 150)) {
    lines.push(`- ${file.path} [${file.lines} lines, ${file.churn} commits]: ${file.symbols.filter((symbol) => symbol.parent === null).slice(0, 12).map((symbol) => `${symbol.name}(${symbol.kind})`).join(' ')}`)
  }
  const outgoing = new Map<string, number>()
  const incoming = new Map<string, number>()
  const internal: string[] = []
  for (const edge of analysis.edges) {
    const fromInside = memberSet.has(edge.from)
    const toInside = memberSet.has(edge.to)
    if (fromInside && toInside) internal.push(`${analysis.files[edge.from]!.path} -> ${analysis.files[edge.to]!.path}`)
    else if (fromInside) outgoing.set(analysis.files[edge.to]!.module, (outgoing.get(analysis.files[edge.to]!.module) ?? 0) + 1)
    else if (toInside) incoming.set(analysis.files[edge.from]!.module, (incoming.get(analysis.files[edge.from]!.module) ?? 0) + 1)
  }
  lines.push('', 'Imports inside the directory:', ...internal.slice(0, 150).map((item) => `- ${item}`))
  lines.push('', 'Depends on (directory: count):', ...[...outgoing].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([dir, count]) => `- ${dir}: ${count}`))
  lines.push('', 'Used by (directory: count):', ...[...incoming].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([dir, count]) => `- ${dir}: ${count}`))
  const externals = analysis.externals.filter((external) => external.uses.some((use) => memberSet.has(use.file))).slice(0, 30)
  lines.push('', `External packages: ${externals.map((item) => item.name).join(', ')}`)

  // 被依赖最多、最大的几个文件带上开头的代码
  const fanIn = new Map<number, number>()
  for (const edge of analysis.edges) if (memberSet.has(edge.to)) fanIn.set(edge.to, (fanIn.get(edge.to) ?? 0) + 1)
  const featured = [...members].sort((a, b) => (fanIn.get(b.index) ?? 0) - (fanIn.get(a.index) ?? 0) || b.file.lines - a.file.lines).slice(0, 8)
  let budget = MODULE_SOURCE_CHARS
  for (const { file } of featured) {
    if (budget <= 0) break
    const text = await readFile(join(analysis.root, file.path), 'utf8').catch(() => null)
    if (text === null) continue
    const head = clip(text.split('\n').slice(0, MODULE_FILE_HEAD_LINES).join('\n'), Math.min(budget, 8000))
    budget -= head.length
    lines.push('', `--- ${file.path} (first lines) ---`, head)
  }

  const { value, usage } = await submitOnce(model, MODULE_SYSTEM, lines.join('\n'), 'submit_module', moduleNoteSchema, signal)
  const index = new PathIndex(analysis)
  return {
    value: {
      generatedAt: new Date().toISOString(),
      model: { provider: model.provider?.name ?? model.endpoint.baseUrl, modelId: model.modelId },
      summary: value.summary.trim(),
      responsibilities: value.responsibilities,
      keyFiles: value.keyFiles.flatMap((item) => {
        const path = index.required(item.path)
        return path === null ? [] : [{ path, role: item.role }]
      }),
      risks: value.risks,
    },
    usage,
  }
}

// ---------- 流程图 ----------

const flowChartSchema = z.object({
  groups: z
    .array(
      z.object({
        id: z.string(),
        label: z.string().describe('Short Chinese name of the loop or phase, e.g. 外层循环、内层循环、结束门禁'),
        parent: z.string().nullable().describe('id of the enclosing group; null at top level'),
      }),
    )
    .max(10),
  nodes: z
    .array(
      z.object({
        id: z.string(),
        kind: z.enum(['start', 'end', 'action', 'decision']),
        label: z.string().describe('Short label in Simplified Chinese (at most ~16 characters); a decision is a question ending with ？'),
        detail: z.string().describe('Optional extra line, e.g. what is checked or loaded; empty string if none'),
        group: z.string().nullable().describe('id of the innermost group this node is in; null if none'),
        anchor: anchorSchema.nullable(),
      }),
    )
    .min(2)
    .max(40),
  edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().describe('是 / 否 or a short condition for edges leaving a decision; empty otherwise') })).max(80),
  notes: z.array(z.object({ text: z.string().describe('One or two sentences in Simplified Chinese'), nodes: z.array(z.string()).max(8).describe('ids of the nodes it explains') })).max(12),
})

const FLOWCHART_SYSTEM = [
  'You draw a control-flow chart (流程图) of one runtime flow of a codebase for the developer who owns it, the kind seen in Chinese tech articles: rectangles for actions, diamonds for decisions with 是/否 branches, arrows going back up to form loops, dashed boxes around loops or phases (e.g. 外层循环、内层循环、结束门禁), and a numbered explanation (流程讲解) beside it.',
  'You get the flow (its steps across modules) and source excerpts with line numbers. Write labels and explanations in Simplified Chinese; keep code identifiers as they are.',
  '- Draw the real control flow from the code: loops, branches, early exits, retries, queues, waits. Never invent steps the code does not have; leave out trivial plumbing.',
  '- 6-30 nodes. Exactly one start node; one or more end nodes (e.g. one per way it can finish). Labels are short (at most ~16 characters). A decision is a question ending with ？ with at least two outgoing edges labeled 是/否 or a short condition.',
  '- A loop is an edge back to an earlier node. Put the nodes of each loop or phase in a group; groups may nest (parent). Give each node the innermost group it is in, or null.',
  '- Anchors: the file and line in the excerpts where that step happens; prefer giving the symbol name (the line is corrected from the symbol list). Use null if unsure.',
  '- notes: 4-9 explanations in reading order, each one or two sentences, listing the ids of the nodes it explains.',
  '- Call submit_flowchart exactly once.',
].join('\n')

// 交给模型的：流程的各步，加上各步代码位置所在的文件（放不下就取位置前后几行），带行号和符号表
async function flowChartPrompt(analysis: ArchitectureAnalysis, flow: ArchitectureFlow): Promise<string> {
  const lines = [`Flow: ${flow.name}`, flow.description, '', 'Steps (from -> to: what happens [code location]):']
  flow.steps.forEach((step, at) => {
    const anchor = step.anchor ? ` [${step.anchor.path}:${step.anchor.line}${step.anchor.symbol ? ` ${step.anchor.symbol}` : ''}]` : ''
    lines.push(`${at + 1}. ${step.from} -> ${step.to}: ${step.action}${anchor}`)
  })
  const files = new Map(analysis.files.map((file) => [file.path, file]))
  const targets = new Map<string, number[]>()
  const add = (path: string, line: number) => files.has(path) && targets.set(path, [...(targets.get(path) ?? []), line])
  for (const step of flow.steps) {
    if (step.anchor) add(step.anchor.path, step.anchor.line)
    for (const name of [step.from, step.to]) if (!step.anchor || step.anchor.path !== name) add(name, 1)
  }
  if (targets.size === 0) throw new Error('这条流程没有对得上的代码位置，先重新解读一遍')
  let budget = FLOW_SOURCE_CHARS
  for (const [path, at] of targets) {
    if (budget <= 0) break
    const text = await readFile(join(analysis.root, path), 'utf8').catch(() => null)
    if (text === null) continue
    const source = text.split('\n')
    const numbered = (from: number, to: number) => source.slice(from - 1, to).map((line, offset) => `${from + offset}| ${line}`).join('\n')
    const limit = Math.min(budget, FLOW_FILE_CHARS)
    let excerpt: string
    if (text.length <= limit) excerpt = numbered(1, source.length)
    else {
      // 几个位置前后的行合成几段，重叠的并起来
      const ranges: Array<[number, number]> = []
      for (const line of [...at].sort((a, b) => a - b)) {
        const from = Math.max(1, line - FLOW_LINES_BEFORE)
        const to = Math.min(source.length, line + FLOW_LINES_AFTER)
        const last = ranges.at(-1)
        if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to)
        else ranges.push([from, to])
      }
      excerpt = ranges.map(([from, to]) => numbered(from, to)).join('\n…\n')
    }
    excerpt = clip(excerpt, limit)
    budget -= excerpt.length
    const symbols = files.get(path)!.symbols.slice(0, 60).map((symbol) => `${symbol.parent ? `${symbol.parent}.` : ''}${symbol.name}@${symbol.line}`)
    lines.push('', `--- ${path} ---`, `Symbols: ${symbols.join(' ')}`, excerpt)
  }
  return lines.join('\n')
}

// 模型画的图逐条核对：重复或空的 id、对不上的连线去掉，框的上级对不上或绕成圈放到最外面，没有节点的框不画，代码位置按解析结果改正
function verifyFlowChart(input: z.infer<typeof flowChartSchema>, index: PathIndex, model: SessionModel): FlowChart {
  let dropped = 0
  const groups: FlowChartGroup[] = []
  for (const group of input.groups) {
    const id = group.id.trim()
    if (!id || groups.some((item) => item.id === id)) {
      dropped++
      continue
    }
    groups.push({ id, label: clip(group.label.trim(), 30), parent: group.parent?.trim() || null })
  }
  const byId = new Map(groups.map((group) => [group.id, group]))
  for (const group of groups) if (group.parent !== null && !byId.has(group.parent)) group.parent = null
  for (const group of groups) {
    const seen = new Set<string>()
    for (let at = group.parent; at !== null && !seen.has(at); at = byId.get(at)!.parent) {
      if (at === group.id) {
        group.parent = null
        break
      }
      seen.add(at)
    }
  }

  const nodes: FlowChartNode[] = []
  for (const node of input.nodes) {
    const id = node.id.trim()
    if (!id || nodes.some((item) => item.id === id)) {
      dropped++
      continue
    }
    const group = node.group?.trim() || null
    nodes.push({ id, kind: node.kind, label: clip(node.label.trim(), 40), detail: clip(node.detail.trim(), 120), group: group !== null && byId.has(group) ? group : null, anchor: index.anchor(node.anchor) })
  }
  const ids = new Set(nodes.map((node) => node.id))

  const edges: FlowChartEdge[] = []
  const seenEdges = new Set<string>()
  for (const edge of input.edges) {
    const from = edge.from.trim()
    const to = edge.to.trim()
    const label = clip(edge.label.trim(), 20)
    const key = `${from}\u0000${to}\u0000${label}`
    if (!ids.has(from) || !ids.has(to) || seenEdges.has(key)) {
      dropped++
      continue
    }
    seenEdges.add(key)
    edges.push({ from, to, label })
  }
  if (nodes.length < 2 || edges.length === 0) throw new Error('模型画的流程图对不上（节点或连线太少），重新画一次或换个模型')

  const used = new Set<string>()
  for (const node of nodes) for (let at = node.group; at !== null && !used.has(at); at = byId.get(at)!.parent) used.add(at)
  return {
    generatedAt: new Date().toISOString(),
    model: { provider: model.provider?.name ?? model.endpoint.baseUrl, modelId: model.modelId },
    nodes,
    edges,
    groups: groups.filter((group) => used.has(group.id)),
    notes: input.notes.flatMap((note) => {
      const text = clip(note.text.trim(), 300)
      return text ? [{ text, nodes: [...new Set(note.nodes.map((id) => id.trim()))].filter((id) => ids.has(id)) }] : []
    }),
    dropped: dropped + index.dropped,
  }
}

export async function generateFlowChart(analysis: ArchitectureAnalysis, flow: ArchitectureFlow, model: SessionModel, signal?: AbortSignal): Promise<ModelCallResult<FlowChart>> {
  const prompt = await flowChartPrompt(analysis, flow)
  const { value, usage } = await submitOnce(model, FLOWCHART_SYSTEM, prompt, 'submit_flowchart', flowChartSchema, signal)
  return { value: verifyFlowChart(value, new PathIndex(analysis), model), usage }
}

// ---------- 架构图（分层方块图） ----------

const blockSchema = z.object({
  name: z.string().describe('Short name shown in the box, Chinese preferred, 2-10 characters'),
  description: z.string().describe('One sentence in Simplified Chinese'),
  kind: z.enum(['code', 'tech', 'external', 'store']).describe('code: code in this project; tech: a technology/library; external: a system, service or user outside the project; store: a data store'),
  paths: z.array(z.string()).max(12).describe('For code blocks: directory or file paths copied from the digest that this block owns (no trailing slash). Empty for others.'),
  packages: z.array(z.string()).max(20).describe('External package names from the digest this block is about or uses. Empty if none.'),
})

const diagramSchema = z.object({
  layers: z
    .array(
      z.object({
        name: z.string().describe('Layer name in Simplified Chinese, e.g. 表现层'),
        description: z.string(),
        groups: z.array(z.object({ name: z.string().describe('Group title; empty string for an untitled group'), blocks: z.array(blockSchema).min(1).max(16) })).min(1).max(8),
      }),
    )
    .min(2)
    .max(9)
    .describe('Top (closest to the user) first'),
  sides: z
    .array(z.object({ name: z.string(), description: z.string(), fromLayer: z.string().describe('Name of the first layer it spans'), toLayer: z.string().describe('Name of the last layer it spans'), blocks: z.array(blockSchema).min(1).max(10) }))
    .max(3)
    .describe('Vertical columns on the right for concerns that cut across layers'),
  connectors: z.array(z.object({ from: z.string().describe('Upper layer name'), to: z.string().describe('Lower layer name'), label: z.string().describe('How they talk, e.g. IPC、HTTP/REST、函数调用、ACP（stdio）') })).max(10),
})

type DiagramInput = z.infer<typeof diagramSchema>

const DIAGRAM_COMMON = [
  'Draw a layered block diagram (分层方块图) of this codebase, the kind used in Chinese architecture documents: horizontal layers stacked top to bottom, each holding titled groups of small boxes, arrows between adjacent layers labeled with how they communicate, and up to 3 vertical columns on the right for cross-cutting concerns.',
  'Write names and descriptions in Simplified Chinese; keep code identifiers, package names and paths as they are. Box names are short (2-10 characters).',
  '- Copy every path exactly from the digest (directories without trailing slash). Never invent paths or package names. A block may own several paths.',
  '- Be specific to this codebase; no generic boxes that the code does not have.',
  '- Call submit_diagram exactly once.',
]

const DIAGRAM_SYSTEMS: Record<DiagramKind, string> = {
  application: [
    'This is the 应用架构图 (application architecture). Layers go from what the user touches down to shared foundations, e.g. 表现层 / 交互层, 应用层（进程入口、编排、IPC）, 服务层 / 业务层, 核心 / 领域层, 基础层 / 通用层, 数据与存储. Use the layers that actually fit this project (3-7).',
    "Blocks are the application's modules (kind code) and own code paths; group them by package, process or feature area. Put data stores (kind store) and outside systems (kind external) in the bottom layers only if the code clearly uses them.",
    'Cover all significant code: every large directory in the digest should belong to some block. Cross-cutting columns: e.g. 安全检查、日志与用量、配置、测试 when the code has them.',
    'Connectors: the real mechanism between layers (e.g. React 组件调用、IPC（contextBridge）、ACP（stdio 子进程）、HTTP).',
  ].join('\n'),
  technology: [
    'This is the 技术架构图 (technology architecture). Layers group technologies by role, e.g. 界面技术, 应用框架与运行时, 通信与协议, 模型与 AI, 数据与存储, 通用库, 语言与运行时. Use what the project actually uses.',
    'Blocks are technologies (kind tech) and list the packages they correspond to; a block can merge related packages (e.g. one block for several @ai-sdk/* providers). Languages and runtimes can be blocks without packages.',
    'A right column for 构建与测试 / 工程化 (build, test, packaging, CI) when present. Connectors: protocols or formats used between layers if meaningful, otherwise leave the label empty.',
  ].join('\n'),
  system: [
    'This is the 系统架构图 (system architecture): what runs where. Layers e.g. 用户与客户端, 进程 / 应用（each process, service or deployment unit, with the code paths of its entry and modules）, 外部服务（model APIs, databases, update servers, browsers, OS facilities）, 基础设施 / 存储（files on disk, caches）.',
    'Use the build and packaging configuration below to find separate processes and entry points. Outside systems are kind external with the packages used to reach them. Connectors carry real protocols (IPC、stdio、HTTPS、native messaging、SQL…).',
    'A right column for 运维与发布 (packaging, updates, CI) or 安全 when present.',
  ].join('\n'),
}

// 系统架构图要知道有几个进程、怎么打包：带上构建和部署配置的开头
async function buildConfigExcerpt(analysis: ArchitectureAnalysis): Promise<string> {
  const pattern = /(^|\/)(electron\.vite\.config|vite\.config|electron-builder\.config|webpack\.config|next\.config|nuxt\.config|tauri\.conf|docker-compose|Dockerfile|Procfile|serverless|app\.yaml|fly\.toml|vercel\.json|netlify\.toml)[^/]*$/i
  const candidates = [...analysis.files.map((file) => file.path), ...analysis.packages.flatMap((item) => (item.manifest ? [item.manifest] : []))].filter((path) => pattern.test(path) || /(^|\/)package\.json$/.test(path))
  const parts: string[] = []
  let budget = 8000
  for (const path of [...new Set(candidates)].slice(0, 12)) {
    if (budget <= 0) break
    const text = await readFile(join(analysis.root, path), 'utf8').catch(() => null)
    if (text === null) continue
    const excerpt = clip(text, Math.min(budget, 2500))
    budget -= excerpt.length
    parts.push(`--- ${path} ---\n${excerpt}`)
  }
  return parts.join('\n')
}

function pinnedSummary(previous: BlockDiagram | null | undefined): string {
  if (!previous) return ''
  const lines: string[] = []
  for (const layer of previous.layers) {
    for (const group of layer.groups) for (const item of group.blocks) if (item.pinned) lines.push(`- 「${item.name}」in layer 「${layer.name}」${group.name ? ` group 「${group.name}」` : ''}: ${item.paths.join(', ') || item.packages.join(', ')}`)
  }
  for (const side of previous.sides) for (const item of side.blocks) if (item.pinned) lines.push(`- 「${item.name}」in the right column 「${side.name}」`)
  return lines.length > 0 ? `\nThe owner fixed these boxes by hand; keep them where they are and do not repeat their paths in other boxes:\n${lines.join('\n')}` : ''
}

// 模型给的图转成带 id 的结构；层名对不上的竖栏和连线丢掉
function toDiagram(kind: DiagramKind, input: DiagramInput, model: SessionModel | null, fingerprint: string, reuse?: BlockDiagram | null): BlockDiagram {
  const ids = new IdMaker()
  const previousBlocks = reuse ? diagramBlocks(reuse).map(({ block }) => block) : []
  for (const item of previousBlocks) ids.reserve(item.id)
  for (const layer of reuse?.layers ?? []) ids.reserve(layer.id)
  // 沿用旧图里同名的 id，目标架构的规则和逐条对比才对得上
  const used = new Set<string>()
  const blockId = (name: string) => {
    const reused = previousBlocks.find((item) => item.name === name && !used.has(item.id))?.id
    const id = reused ?? ids.next('block')
    used.add(id)
    return id
  }
  const toBlock = (item: z.infer<typeof blockSchema>): DiagramBlock => ({
    id: blockId(item.name.trim()),
    name: item.name.trim(),
    description: item.description.trim(),
    kind: item.kind,
    paths: item.paths.map((path) => path.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')).filter(Boolean),
    packages: item.packages.map((name) => name.trim()).filter(Boolean),
    pinned: false,
    unverified: false,
  })
  const layers = input.layers.map((layer) => ({
    id: reuse?.layers.find((item) => item.name === layer.name.trim())?.id ?? ids.next('layer'),
    name: layer.name.trim(),
    description: layer.description.trim(),
    groups: layer.groups.map((group) => ({ id: ids.next('group'), name: group.name.trim(), blocks: group.blocks.map(toBlock), pinned: false })),
    pinned: false,
  }))
  const layerId = (name: string) => layers.find((layer) => layer.name === name.trim())?.id ?? null
  const sides = input.sides.flatMap((side) => {
    const from = layerId(side.fromLayer) ?? layers[0]?.id
    const to = layerId(side.toLayer) ?? layers[layers.length - 1]?.id
    return from && to ? [{ id: ids.next('side'), name: side.name.trim(), description: side.description.trim(), from, to, blocks: side.blocks.map(toBlock), pinned: false }] : []
  })
  const connectors = input.connectors.flatMap((connector) => {
    const from = layerId(connector.from)
    const to = layerId(connector.to)
    return from && to && from !== to ? [{ from, to, label: connector.label.trim() }] : []
  })
  return {
    kind,
    source: 'model',
    generatedAt: new Date().toISOString(),
    model: model ? { provider: model.provider?.name ?? model.endpoint.baseUrl, modelId: model.modelId } : null,
    fingerprint,
    layers,
    sides,
    connectors,
    dropped: 0,
  }
}

// 生成一张架构图：模型按摘要画，路径和外部包逐条核对，用户手改过的方块原样留下
export async function generateDiagram(
  analysis: ArchitectureAnalysis,
  kind: DiagramKind,
  model: SessionModel,
  previous: BlockDiagram | null | undefined,
  signal?: AbortSignal,
): Promise<ModelCallResult<BlockDiagram>> {
  const parts = [`Codebase digest:\n${await architectureDigest(analysis)}`]
  if (kind === 'system') {
    const config = await buildConfigExcerpt(analysis)
    if (config) parts.push('', 'Build and packaging configuration:', config)
  }
  if (kind === 'technology') {
    parts.push('', `All external packages (name [ecosystem]: imports): ${analysis.externals.slice(0, 150).map((item) => `${item.name} [${item.ecosystem}${item.builtin ? ', builtin' : ''}]: ${item.count}`).join('; ')}`)
  }
  const system = [...DIAGRAM_COMMON, DIAGRAM_SYSTEMS[kind]].join('\n')
  const { value, usage } = await submitOnce(model, system, `${parts.join('\n')}${pinnedSummary(previous)}`, 'submit_diagram', diagramSchema, signal)
  const diagram = keepPinned(previous, verifyDiagram(analysis, toDiagram(kind, value, model, analysis.fingerprint, previous)))
  return { value: diagram, usage }
}

// ---------- 让模型提目标架构 ----------

const proposalSchema = z.object({
  diagram: diagramSchema.describe('The target application architecture as a layered block diagram. Code blocks own the paths their code should live in (existing paths from the digest, or new directories for planned blocks).'),
  layered: z.boolean().describe('Enforce: blocks may only depend on blocks in the same or lower layers (right-hand columns are usable from anywhere)'),
  strictLayers: z.boolean().describe('Only the directly lower layer (rarely wanted)'),
  noCycles: z.boolean(),
  forbid: z.array(z.object({ from: z.string(), to: z.string(), note: z.string() })).max(30).describe('Block names'),
  allow: z.array(z.object({ from: z.string(), to: z.string(), note: z.string() })).max(30).describe('Exceptions to the layer rule, block names'),
  externals: z.array(z.object({ package: z.string(), only: z.array(z.string()).describe('Block names'), note: z.string() })).max(20),
  rationale: z.string().describe('Why this target, what changes compared to today, in Simplified Chinese'),
})

const TARGET_SYSTEM = [
  'You are a software architect. Propose the target application architecture for this codebase as a layered block diagram plus dependency rules.',
  "Base it on the real structure in the digest; keep what already works, fix what is tangled. Follow the owner's principles when given. Write names, descriptions and notes in Simplified Chinese.",
  '- Every code block owns code by path prefixes or globs relative to the project root. Use real paths from the digest; only planned blocks (new code to be written) may use new directories.',
  '- If a current target exists, improve it rather than starting over, and keep the names of blocks that stay.',
  '- Call submit_target exactly once.',
].join('\n')

function describeTarget(target: TargetArchitecture): string {
  const name = (id: string) => diagramBlocks(target.diagram).find(({ block }) => block.id === id)?.block.name ?? id
  const lines = ['Current target architecture (layers top first):']
  for (const layer of target.diagram.layers) {
    lines.push(`Layer 「${layer.name}」:`)
    for (const group of layer.groups) for (const item of group.blocks) lines.push(`- ${group.name ? `[${group.name}] ` : ''}${item.name}: ${item.paths.join(', ') || '(planned)'} — ${item.description}`)
  }
  for (const side of target.diagram.sides) lines.push(`Right column 「${side.name}」: ${side.blocks.map((item) => `${item.name} (${item.paths.join(', ')})`).join('; ')}`)
  lines.push(`Rules: ${target.rules.map((rule) => (rule.kind === 'forbid' || rule.kind === 'allow' ? `${rule.kind} ${name(rule.from)} -> ${name(rule.to)}` : rule.kind === 'external' ? `${rule.package} only in ${rule.only.map(name).join(', ')}` : rule.kind)).join('; ') || 'none'}`)
  return lines.join('\n')
}

let ruleCounter = 0
const newRuleId = () => `rule-${Date.now().toString(36)}-${++ruleCounter}`

export async function proposeTarget(
  analysis: ArchitectureAnalysis,
  current: TargetArchitecture | null,
  principles: string,
  model: SessionModel,
  signal?: AbortSignal,
): Promise<ModelCallResult<{ target: TargetArchitecture; rationale: string }>> {
  const parts = [`Codebase digest:\n${await architectureDigest(analysis)}`]
  if (current) parts.push('', describeTarget(current))
  if (principles.trim()) parts.push('', `Owner's principles:\n${principles.trim()}`)
  const { value, usage } = await submitOnce(model, TARGET_SYSTEM, parts.join('\n'), 'submit_target', proposalSchema, signal)
  // 目标里的方块可以是计划中的：不按现状删路径
  const diagram = toDiagram('application', value.diagram, model, analysis.fingerprint, current?.diagram)
  const byName = new Map(diagramBlocks(diagram).map(({ block }) => [block.name, block.id]))
  const rules: TargetRule[] = []
  const existingId = (kind: TargetRule['kind']) => current?.rules.find((rule) => rule.kind === kind)?.id ?? newRuleId()
  if (value.layered) rules.push({ id: existingId('layers'), kind: 'layers', strict: value.strictLayers })
  if (value.noCycles) rules.push({ id: existingId('no-cycles'), kind: 'no-cycles' })
  for (const kind of ['forbid', 'allow'] as const) {
    for (const item of value[kind]) {
      const from = byName.get(item.from)
      const to = byName.get(item.to)
      if (from && to) rules.push({ id: newRuleId(), kind, from, to, note: item.note })
    }
  }
  for (const item of value.externals) {
    const only = item.only.flatMap((name) => byName.get(name) ?? [])
    if (only.length > 0) rules.push({ id: newRuleId(), kind: 'external', package: item.package, only, note: item.note })
  }
  return { value: { target: { version: ARCHITECTURE_VERSION, updatedAt: new Date().toISOString(), diagram, rules }, rationale: value.rationale }, usage }
}
