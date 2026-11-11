// 架构分析的数据结构和纯函数：core 生成、保存，界面读取、聚合、对比目标架构。这里不能引入 Node 模块，界面也要用

export const ARCHITECTURE_VERSION = 1

// 深度解析（import、导出、符号）的语言；其他语言只统计文件和行数
export type SourceLanguage = 'typescript' | 'javascript' | 'vue' | 'python' | 'go' | 'rust' | 'java'

// import：普通导入；type：只导入类型；dynamic：import()；require：CommonJS；reexport：export … from；
// mod：Rust 的 mod foo;；use：Rust 的 use；static：Java 的 import static
export type ImportKind = 'import' | 'type' | 'dynamic' | 'require' | 'reexport' | 'mod' | 'use' | 'static'

export interface ImportFact {
  // 原样的导入路径：'./a'、'react'、'a.b.c'、'github.com/x/y'、'crate::a::b'、'com.x.Y'
  specifier: string
  line: number
  // 导入的名字；import * 和整模块导入为空
  names: string[]
  kind: ImportKind
}

export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'variable' | 'constant' | 'method' | 'struct' | 'trait' | 'impl' | 'module'

export interface SymbolFact {
  name: string
  kind: SymbolKind
  line: number
  endLine: number
  // 对外可见：TS/JS 的 export、Python 不以 _ 开头、Go 首字母大写、Rust pub、Java public
  exported: boolean
  // 方法所属的类、结构体、impl；顶层为 null
  parent: string | null
}

export interface FileFacts {
  language: SourceLanguage
  imports: ImportFact[]
  symbols: SymbolFact[]
  // Go 的 package 名、Java 的 package 声明；其他语言为 null
  namespace: string | null
  // Java 同一个包里的类不用 import 就能用：记下文件里出现的类型名，按同包的类名对上
  typeRefs: string[]
}

export type Ecosystem = 'npm' | 'go' | 'cargo' | 'maven' | 'gradle' | 'python' | 'none'

// 包或容器：一个 package.json、go.mod、Cargo.toml、pom.xml、build.gradle、pyproject.toml 所在的目录；不在任何包里的文件归到根目录
export interface PackageInfo {
  // 相对项目根目录的路径，根目录为 ''
  dir: string
  name: string
  ecosystem: Ecosystem
  manifest: string | null
  description: string | null
  // 入口文件（main、bin、exports、main.go、main.rs、lib.rs、__main__.py…），相对路径
  entries: string[]
  // 清单里声明的外部依赖
  dependencies: string[]
}

// 目录。只收有代码文件（直接或在子目录里）的目录
export interface ModuleInfo {
  path: string
  parent: string | null
  name: string
  // 所属包的 dir
  package: string
  files: number
  lines: number
}

export interface FileInfo {
  path: string
  // 代码语言（含只统计不解析的语言，如 'c'、'kotlin'）
  language: string
  // 深度解析过的才有符号和依赖
  parsed: boolean
  lines: number
  bytes: number
  package: string
  module: string
  symbols: SymbolFact[]
  // Go 的 package 名、Java 的 package
  namespace: string | null
  // 统计窗口内改过它的提交数
  churn: number
  // 最近几次提交在 commits 里的下标，新的在前
  commits: number[]
  entry: boolean
}

export interface EdgeImport {
  line: number
  specifier: string
  names: string[]
  kind: ImportKind
}

// 项目内文件到文件的依赖；from、to 是 files 的下标
export interface FileEdge {
  from: number
  to: number
  imports: EdgeImport[]
}

export interface ExternalUse {
  file: number
  line: number
  specifier: string
}

export interface ExternalInfo {
  name: string
  ecosystem: 'npm' | 'python' | 'go' | 'cargo' | 'java'
  // 语言自带的库：node:fs、Python 标准库、Go 标准库、Rust std、java.*
  builtin: boolean
  // 清单里声明过
  declared: boolean
  // 使用的地方，最多 MAX_EXTERNAL_USES 处；count 是总数
  uses: ExternalUse[]
  count: number
}

export interface CommitInfo {
  hash: string
  date: string
  subject: string
}

// 相对路径的导入没对上任何文件（拼错、生成的文件、被 .gitignore 跳过的文件）
export interface UnresolvedImport {
  file: number
  line: number
  specifier: string
}

export interface LanguageStat {
  language: string
  files: number
  lines: number
}

export interface AnalysisStats {
  files: number
  lines: number
  bytes: number
  languages: LanguageStat[]
  parsedFiles: number
  // 跳过的文件：太大、看起来是生成或压缩的、超过文件数上限、解析失败
  skipped: { tooLarge: number; generated: number; overLimit: number; failed: number }
  // 这次重新解析的文件数（其余用缓存）
  reparsed: number
}

// 依赖解析用到的项目配置，保存下来给任务里的架构检查复用
export interface ResolverConfig {
  // TS/JS 的路径别名：'@/*' → ['packages/desktop/src/renderer/src/*']，适用于 scope 目录下的文件
  aliases: Array<{ scope: string; pattern: string; targets: string[] }>
  // 工作区里的 npm 包：包名 → 目录和 exports（子路径 → 文件，都相对项目根目录）
  npmPackages: Record<string, { dir: string; exports: Record<string, string> }>
  // go.mod 的模块路径 → 目录
  goModules: Record<string, string>
  // Cargo 包名（- 换成 _）→ crate 根文件（src/lib.rs 或 src/main.rs）
  crates: Record<string, string>
  // Python 的导入根目录
  pythonRoots: string[]
}

export interface ArchitectureAnalysis {
  version: typeof ARCHITECTURE_VERSION
  projectId: string
  root: string
  analyzedAt: string
  durationMs: number
  fingerprint: string
  git: { head: string | null; branch: string | null }
  // git 改动频率统计的天数
  churnDays: number
  stats: AnalysisStats
  packages: PackageInfo[]
  modules: ModuleInfo[]
  files: FileInfo[]
  edges: FileEdge[]
  externals: ExternalInfo[]
  commits: CommitInfo[]
  unresolved: UnresolvedImport[]
  resolver: ResolverConfig
}

export const MAX_EXTERNAL_USES = 50

// ---------- 模型解读 ----------

export interface CodeAnchor {
  path: string
  line: number
  symbol: string | null
}

export interface ExternalSystem {
  name: string
  kind: string
  description: string
  // 和它打交道用到的外部包
  packages: string[]
  // 和它打交道的代码位置
  anchors: CodeAnchor[]
}

export interface FlowStep {
  // 参与者：目录或文件的相对路径，或外部系统的名字
  from: string
  to: string
  action: string
  anchor: CodeAnchor | null
}

export interface ArchitectureFlow {
  name: string
  description: string
  steps: FlowStep[]
}

export interface ModuleNote {
  generatedAt: string
  model: { provider: string; modelId: string }
  summary: string
  responsibilities: string[]
  keyFiles: Array<{ path: string; role: string }>
  risks: string[]
}

export interface ArchitectureInterpretation {
  version: typeof ARCHITECTURE_VERSION
  generatedAt: string
  model: { provider: string; modelId: string }
  // 依据的那次分析
  fingerprint: string
  summary: string
  techStack: string[]
  entryPoints: Array<{ path: string; description: string }>
  readingOrder: Array<{ path: string; reason: string }>
  externalSystems: ExternalSystem[]
  flows: ArchitectureFlow[]
  // 单个目录的解读，下钻时按需生成；键是目录路径
  notes: Record<string, ModuleNote>
  // 校验时丢掉的代码位置（文件不存在、行号越界）
  dropped: number
}

// ---------- 架构图（分层方块图） ----------

// 应用架构：模块按层摆；技术架构：框架、库、协议按层摆；系统架构：进程、部署单元和外部系统
export const DIAGRAM_KINDS = ['application', 'technology', 'system'] as const
export type DiagramKind = (typeof DIAGRAM_KINDS)[number]

// 让模型做的几样：系统简介和流程（overview），加三张架构图
export const INTERPRET_PARTS = ['overview', ...DIAGRAM_KINDS] as const
export type InterpretPart = (typeof INTERPRET_PARTS)[number]

// code：项目里的代码（按路径认领）；tech：技术或外部包；external：项目外的系统、服务、用户；store：数据存储
export type BlockKind = 'code' | 'tech' | 'external' | 'store'

export interface DiagramBlock {
  id: string
  name: string
  description: string
  kind: BlockKind
  // 认领的代码：目录前缀（packages/core/src/session）或通配符（**/*.test.ts）
  paths: string[]
  // 用到的外部包
  packages: string[]
  // 用户手改过：重新生成时原样保留
  pinned: boolean
  // 模型给的路径或包一个都对不上分析结果
  unverified: boolean
}

export interface DiagramGroup {
  id: string
  // 空名字的分组不画框
  name: string
  blocks: DiagramBlock[]
  pinned: boolean
}

export interface DiagramLayer {
  id: string
  name: string
  description: string
  groups: DiagramGroup[]
  pinned: boolean
}

// 右边竖着、跨几层的一栏：日志、配置、安全、测试这类各层都用的东西
export interface DiagramSide {
  id: string
  name: string
  description: string
  // 从哪一层到哪一层（层 id）
  from: string
  to: string
  blocks: DiagramBlock[]
  pinned: boolean
}

// 上下两层之间的箭头，标着怎么通信（IPC、HTTP、函数调用…）
export interface DiagramConnector {
  from: string
  to: string
  label: string
}

export interface BlockDiagram {
  kind: DiagramKind
  // static：分析完按包和目录直接排的；model：模型生成的
  source: 'static' | 'model'
  generatedAt: string
  model: { provider: string; modelId: string } | null
  // 依据的那次分析
  fingerprint: string
  // 下标 0 是最上层
  layers: DiagramLayer[]
  sides: DiagramSide[]
  connectors: DiagramConnector[]
  // 核对时丢掉的路径和包
  dropped: number
}

export type ArchitectureDiagrams = Partial<Record<DiagramKind, BlockDiagram>>

export function diagramBlocks(diagram: BlockDiagram): Array<{ block: DiagramBlock; layer: string | null; group: string | null; side: string | null }> {
  return [
    ...diagram.layers.flatMap((layer) => layer.groups.flatMap((group) => group.blocks.map((block) => ({ block, layer: layer.id, group: group.id, side: null })))),
    ...diagram.sides.flatMap((side) => side.blocks.map((block) => ({ block, layer: null, group: null, side: side.id }))),
  ]
}

// ---------- 目标架构 ----------

// 目标架构就是一张应用架构图加上依赖规则：带代码路径的方块是组件，层取它所在的横带；右边竖栏里的方块不分层，谁都能用
export type TargetRule =
  // 只能依赖同层或下层；strict 时只能依赖紧挨着的下一层
  | { id: string; kind: 'layers'; strict: boolean }
  | { id: string; kind: 'forbid'; from: string; to: string; note: string }
  // 层级规则的例外
  | { id: string; kind: 'allow'; from: string; to: string; note: string }
  | { id: string; kind: 'no-cycles' }
  // 某个外部包只许这些组件使用
  | { id: string; kind: 'external'; package: string; only: string[]; note: string }

export interface TargetArchitecture {
  version: typeof ARCHITECTURE_VERSION
  updatedAt: string
  diagram: BlockDiagram
  rules: TargetRule[]
  // 任务改完时检查新增的依赖，违反规则就打回
  enforceInTasks: boolean
}

export interface TargetLayer {
  id: string
  name: string
}

export interface TargetComponent {
  id: string
  name: string
  layer: string | null
  paths: string[]
}

const partsCache = new WeakMap<TargetArchitecture, { layers: TargetLayer[]; components: TargetComponent[] }>()

// 规则判断用的扁平视图：项目外的系统不算组件
export function targetParts(target: TargetArchitecture): { layers: TargetLayer[]; components: TargetComponent[] } {
  const cached = partsCache.get(target)
  if (cached) return cached
  const parts = {
    layers: target.diagram.layers.map((layer) => ({ id: layer.id, name: layer.name })),
    components: diagramBlocks(target.diagram)
      .filter(({ block }) => block.kind !== 'external')
      .map(({ block, layer }) => ({ id: block.id, name: block.name, layer, paths: block.paths })),
  }
  partsCache.set(target, parts)
  return parts
}

// ---------- 项目列表 ----------

export interface ArchitectureProject {
  id: string
  path: string
  name: string
  addedAt: string
}

// 卡片上的缩略图：应用架构图每层的方块名
export interface ArchitectureThumbnail {
  layers: Array<{ name: string; blocks: string[] }>
}

export interface AnalysisDigest {
  analyzedAt: string
  durationMs: number
  fingerprint: string
  files: number
  lines: number
  languages: LanguageStat[]
  packages: number
  modules: number
  cycles: number
}

export interface ArchitectureProjectSummary extends ArchitectureProject {
  analysis: AnalysisDigest | null
  thumbnail: ArchitectureThumbnail | null
  interpretedAt: string | null
  // 目标架构的对比结果；没有目标架构为 null
  target: { violations: number; gaps: number } | null
  exists: boolean
}

export type AnalysisPhase = 'listing' | 'manifests' | 'parsing' | 'resolving' | 'history' | 'saving' | 'interpreting'

export interface AnalysisProgress {
  projectId: string
  phase: AnalysisPhase
  done: number
  total: number
  startedAt: string
}

// core 推给客户端的进度；progress 为 null 时表示这次分析或解读结束了，outcome 说明怎么结束的
export interface ArchitectureEvent {
  projectId: string
  progress: AnalysisProgress | null
  outcome?: 'done' | 'cancelled' | 'failed'
  error?: string
}

// 打开一个项目时一次取回的全部数据
export interface ArchitectureBundle {
  project: ArchitectureProject
  analysis: ArchitectureAnalysis | null
  interpretation: ArchitectureInterpretation | null
  diagrams: ArchitectureDiagrams
  target: TargetArchitecture | null
  layout: ArchitectureLayout
}

// 手动拖过的节点位置：键是视图（画布所在的范围），值是节点 id → 坐标
export type ArchitectureLayout = Record<string, Record<string, { x: number; y: number }>>

// ---------- 纯函数 ----------

// 强连通分量（Tarjan，迭代写法，不怕深递归）；只返回含两个以上节点或自环的分量
export function stronglyConnected(count: number, neighbors: (node: number) => Iterable<number>): number[][] {
  const index = new Int32Array(count).fill(-1)
  const low = new Int32Array(count)
  const onStack = new Uint8Array(count)
  const stack: number[] = []
  const result: number[][] = []
  let next = 0
  for (let start = 0; start < count; start++) {
    if (index[start] !== -1) continue
    const work: Array<{ node: number; iterator: Iterator<number> }> = [{ node: start, iterator: neighbors(start)[Symbol.iterator]() }]
    index[start] = low[start] = next++
    stack.push(start)
    onStack[start] = 1
    const selfLoop = new Set<number>()
    while (work.length > 0) {
      const frame = work[work.length - 1]!
      const step = frame.iterator.next()
      if (!step.done) {
        const target = step.value
        if (target === frame.node) selfLoop.add(target)
        if (index[target] === -1) {
          index[target] = low[target] = next++
          stack.push(target)
          onStack[target] = 1
          work.push({ node: target, iterator: neighbors(target)[Symbol.iterator]() })
        } else if (onStack[target]) low[frame.node] = Math.min(low[frame.node]!, index[target]!)
        continue
      }
      work.pop()
      const parent = work[work.length - 1]
      if (parent) low[parent.node] = Math.min(low[parent.node]!, low[frame.node]!)
      if (low[frame.node] === index[frame.node]) {
        const component: number[] = []
        let member: number
        do {
          member = stack.pop()!
          onStack[member] = 0
          component.push(member)
        } while (member !== frame.node)
        if (component.length > 1 || selfLoop.has(frame.node)) result.push(component.reverse())
      }
    }
  }
  return result
}

const GLOB_CHARS = /[*?[]/

function globToRegExp(pattern: string): RegExp {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // **/ 匹配零或多层目录
        if (pattern[i + 2] === '/') {
          source += '(?:.*/)?'
          i += 2
        } else {
          source += '.*'
          i += 1
        }
      } else source += '[^/]*'
    } else if (char === '?') source += '[^/]'
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

const patternCache = new Map<string, (path: string) => boolean>()

// 组件认领代码的路径：不带通配符的是目录前缀或文件；带通配符的按 glob 匹配
export function pathMatcher(pattern: string): (path: string) => boolean {
  const cached = patternCache.get(pattern)
  if (cached) return cached
  const normalized = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  let matcher: (path: string) => boolean
  if (normalized === '' || normalized === '**') matcher = () => true
  else if (!GLOB_CHARS.test(normalized)) matcher = (path) => path === normalized || path.startsWith(`${normalized}/`)
  else {
    const regexp = globToRegExp(normalized)
    matcher = (path) => regexp.test(path)
  }
  if (patternCache.size > 500) patternCache.clear()
  patternCache.set(pattern, matcher)
  return matcher
}

// 文件归哪个组件：多个组件都认领时取匹配最具体的：通配符前面的固定部分越长越具体，一样长时不带通配符的优先
export function componentOfPath(components: readonly TargetComponent[], path: string): string | null {
  let best: { id: string; score: number } | null = null
  for (const component of components) {
    for (const pattern of component.paths) {
      if (!pathMatcher(pattern)(path)) continue
      const glob = pattern.search(GLOB_CHARS)
      const score = glob < 0 ? pattern.length * 2 + 1 : glob * 2
      if (!best || score > best.score) best = { id: component.id, score }
    }
  }
  return best?.id ?? null
}

export interface DependencyLink {
  from: string
  to: string
}

export interface ViolationEdge {
  from: number
  to: number
  line: number
  specifier: string
}

export interface TargetViolation {
  ruleId: string
  kind: 'layers' | 'forbid' | 'cycle' | 'external'
  from: string
  // 组件 id；外部包规则是包名
  to: string
  message: string
  edges: ViolationEdge[]
}

export interface TargetEvaluation {
  // 每个文件归哪个组件，和 analysis.files 一一对应
  componentOfFile: Array<string | null>
  violations: TargetViolation[]
  // 没被任何组件认领的代码文件
  unassigned: number[]
  // 计划了但还没有代码的组件
  planned: string[]
  // 组件之间的依赖（现状），带文件级依赖条数
  links: Array<DependencyLink & { count: number }>
}

// 组件 from 依赖 to 是否被规则允许；返回违反的规则
export function linkViolation(target: TargetArchitecture, from: string, to: string): { ruleId: string; kind: 'layers' | 'forbid'; message: string } | null {
  if (from === to) return null
  const name = (id: string) => targetParts(target).components.find((component) => component.id === id)?.name ?? id
  for (const rule of target.rules) {
    if (rule.kind === 'forbid' && rule.from === from && rule.to === to) {
      return { ruleId: rule.id, kind: 'forbid', message: `「${name(from)}」不许依赖「${name(to)}」${rule.note ? `：${rule.note}` : ''}` }
    }
  }
  const allowed = target.rules.some((rule) => rule.kind === 'allow' && rule.from === from && rule.to === to)
  const layers = target.rules.find((rule) => rule.kind === 'layers')
  if (!layers || allowed) return null
  const layerIndex = (id: string) => {
    const layer = targetParts(target).components.find((component) => component.id === id)?.layer
    return layer ? targetParts(target).layers.findIndex((item) => item.id === layer) : -1
  }
  const fromLayer = layerIndex(from)
  const toLayer = layerIndex(to)
  if (fromLayer < 0 || toLayer < 0) return null
  const layerName = (index: number) => targetParts(target).layers[index]?.name ?? ''
  if (toLayer < fromLayer) {
    return { ruleId: layers.id, kind: 'layers', message: `下层「${layerName(fromLayer)}」的「${name(from)}」反向依赖上层「${layerName(toLayer)}」的「${name(to)}」` }
  }
  if (layers.strict && toLayer > fromLayer + 1) {
    return { ruleId: layers.id, kind: 'layers', message: `「${name(from)}」越过「${layerName(fromLayer + 1)}」直接依赖「${layerName(toLayer)}」的「${name(to)}」` }
  }
  return null
}

// 现状对比目标架构：每条文件依赖映射到组件之间，按规则找出违规；再列出没认领的代码和还没有代码的组件
export function evaluateTarget(analysis: Pick<ArchitectureAnalysis, 'files' | 'edges' | 'externals'>, target: TargetArchitecture): TargetEvaluation {
  const componentOfFile = analysis.files.map((file) => componentOfPath(targetParts(target).components, file.path))
  const violations = new Map<string, TargetViolation>()
  const links = new Map<string, DependencyLink & { count: number }>()
  for (const edge of analysis.edges) {
    const from = componentOfFile[edge.from]
    const to = componentOfFile[edge.to]
    if (!from || !to || from === to) continue
    const key = `${from}\u0000${to}`
    const link = links.get(key) ?? { from, to, count: 0 }
    link.count++
    links.set(key, link)
    const violation = linkViolation(target, from, to)
    if (!violation) continue
    const entry = violations.get(key) ?? { ruleId: violation.ruleId, kind: violation.kind, from, to, message: violation.message, edges: [] }
    const first = edge.imports[0]
    entry.edges.push({ from: edge.from, to: edge.to, line: first?.line ?? 1, specifier: first?.specifier ?? '' })
    violations.set(key, entry)
  }

  const result = [...violations.values()]
  const noCycles = target.rules.find((rule) => rule.kind === 'no-cycles')
  if (noCycles) {
    const ids = targetParts(target).components.map((component) => component.id)
    const position = new Map(ids.map((id, index) => [id, index]))
    const adjacency = ids.map(() => new Set<number>())
    for (const link of links.values()) adjacency[position.get(link.from)!]?.add(position.get(link.to)!)
    for (const cycle of stronglyConnected(ids.length, (node) => adjacency[node]!)) {
      const members = new Set(cycle.map((index) => ids[index]!))
      const names = cycle.map((index) => targetParts(target).components[index]!.name)
      const edges: ViolationEdge[] = []
      for (const edge of analysis.edges) {
        const from = componentOfFile[edge.from]
        const to = componentOfFile[edge.to]
        if (from && to && from !== to && members.has(from) && members.has(to)) edges.push({ from: edge.from, to: edge.to, line: edge.imports[0]?.line ?? 1, specifier: edge.imports[0]?.specifier ?? '' })
      }
      result.push({ ruleId: noCycles.id, kind: 'cycle', from: ids[cycle[0]!]!, to: ids[cycle[cycle.length - 1]!]!, message: `组件之间循环依赖：${names.join(' → ')} → ${names[0]}`, edges })
    }
  }

  for (const rule of target.rules) {
    if (rule.kind !== 'external') continue
    const external = analysis.externals.find((item) => item.name === rule.package)
    if (!external) continue
    const offenders = new Map<string, ViolationEdge[]>()
    for (const use of external.uses) {
      const component = componentOfFile[use.file] ?? null
      if (component && rule.only.includes(component)) continue
      const key = component ?? ''
      offenders.set(key, [...(offenders.get(key) ?? []), { from: use.file, to: use.file, line: use.line, specifier: use.specifier }])
    }
    for (const [component, edges] of offenders) {
      const name = targetParts(target).components.find((item) => item.id === component)?.name ?? '未归属的代码'
      result.push({ ruleId: rule.id, kind: 'external', from: component, to: rule.package, message: `「${name}」用了只许${rule.only.map((id) => `「${targetParts(target).components.find((item) => item.id === id)?.name ?? id}」`).join('、')}使用的「${rule.package}」${rule.note ? `：${rule.note}` : ''}`, edges })
    }
  }

  const unassigned: number[] = []
  const used = new Set<string>()
  componentOfFile.forEach((component, index) => {
    if (component) used.add(component)
    else unassigned.push(index)
  })
  const planned = targetParts(target).components.filter((component) => !used.has(component.id)).map((component) => component.id)
  return { componentOfFile, violations: result, unassigned, planned, links: [...links.values()] }
}

// 差距条数：违规的依赖对、没认领的代码（按目录算一处）、还没有代码的组件
export function targetGapCount(analysis: Pick<ArchitectureAnalysis, 'files'>, evaluation: TargetEvaluation): { violations: number; gaps: number } {
  const unassignedDirs = new Set(evaluation.unassigned.map((index) => analysis.files[index]!.module))
  return { violations: evaluation.violations.length, gaps: evaluation.violations.length + unassignedDirs.size + evaluation.planned.length }
}
