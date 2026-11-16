// 架构分析的数据结构和纯函数：core 生成、保存，界面读取、聚合、对比目标架构。这里不能引入 Node 模块，界面也要用

export const ARCHITECTURE_VERSION = 1

// 深度解析（import、导出、符号）的语言；其他语言只统计文件和行数
// v2 起多了按行提取的几种（见 extract-lines.ts）和 Svelte
export type SourceLanguage = 'typescript' | 'javascript' | 'vue' | 'svelte' | 'python' | 'go' | 'rust' | 'java' | 'c' | 'cpp' | 'csharp' | 'kotlin' | 'scala' | 'php' | 'ruby' | 'swift' | 'dart'

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
  // 整模块导入时本地起的名字（import * as fmt、import x as y、Go 的 import u "…"），调用图用（v2 · M9）
  local?: string
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
  // Java 顶层类型上的注解名（SpringBootApplication、RestController…），v2 的 Java 适配器加的；其他语言没有
  annotations?: string[]
  // 函数级调用图（v2 · M9）：文件里的调用处，见 CallFact；以前的缓存没有，重新解析一次
  calls?: CallFact[]
}

// 一处调用：被调的名字、前缀（a.b() 的 a；this、self 照记；看不出是什么的写 ?；没有前缀是 null）、行号。
// 谁调的不在这里记，按行号落在哪个函数的范围里算
export type CallFact = [name: string, qualifier: string | null, line: number]

// 解析出来的一条函数调用：from 文件里的 fromSymbol 调了 to 文件里的 toSymbol（方法写成 类.方法，模块顶层的调用是 (module)）
export interface CallLink {
  from: number
  fromSymbol: string
  to: number
  toSymbol: string
  lines: number[]
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
  // Java 顶层类型上的注解名（见 FileFacts.annotations）；旧的分析结果没有
  annotations?: string[]
}

export interface EdgeImport {
  line: number
  specifier: string
  names: string[]
  kind: ImportKind
  local?: string
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

// 外部包的来源；v2 起多了 C/C++（native）、C#（nuget）、PHP（composer）、Ruby（gem）、Swift、Dart（pub）
export type ExternalEcosystem = 'npm' | 'python' | 'go' | 'cargo' | 'java' | 'native' | 'nuget' | 'composer' | 'gem' | 'swift' | 'pub'

export interface ExternalInfo {
  name: string
  ecosystem: ExternalEcosystem
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
  // 函数级调用图（v2 · M9）：静态解析出来的、项目里函数之间的调用。以前的分析结果没有
  calls?: CallLink[]
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

// 流程图（第 696 步）：一条流程里的控制逻辑（判断、循环、提前结束），按需让模型读这条流程经过的代码画
export type FlowChartNodeKind = 'start' | 'end' | 'action' | 'decision'

export interface FlowChartNode {
  id: string
  kind: FlowChartNodeKind
  label: string
  // 一行补充说明，可以为空
  detail: string
  // 所在的框（循环、阶段）；null 在最外面
  group: string | null
  anchor: CodeAnchor | null
}

export interface FlowChartEdge {
  from: string
  to: string
  // 判断的分支写「是 / 否」或简短条件；普通连线为空
  label: string
}

export interface FlowChartGroup {
  id: string
  label: string
  parent: string | null
}

export interface FlowChart {
  generatedAt: string
  model: { provider: string; modelId: string }
  nodes: FlowChartNode[]
  edges: FlowChartEdge[]
  groups: FlowChartGroup[]
  // 流程讲解：按阅读顺序，每条说的是哪几个节点
  notes: Array<{ text: string; nodes: string[] }>
  // 校验时去掉的节点、连线和代码位置
  dropped: number
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
  // 流程图，按需生成；键是流程名。旧的解读文件里没有
  charts?: Record<string, FlowChart>
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
  // v2 · M9：打开着这个项目时，代码一改就自动重新分析（默认关，只提示过期）
  autoRefresh?: boolean
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
  // v2 · M9 监听文件变化：代码在分析之后改了（stale），或者监听不了（watchError）。带这两个字段的不是分析进度
  stale?: boolean
  watchError?: string
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

// ---------- Java 分层（v2 的 Java 适配器）：按包名和类上的注解判断每个包在哪一层，查下层反过来依赖上层 ----------

export type JavaLayer = 'web' | 'service' | 'data' | 'model' | 'config' | 'common'

export const JAVA_LAYER_NAMES: Record<JavaLayer, string> = { web: '接口层', service: '业务层', data: '数据访问层', model: '领域模型', config: '配置', common: '通用' }

// 从上到下；配置、通用是竖栏，谁都能用，不参与上下判断
export const JAVA_LAYER_ORDER: JavaLayer[] = ['web', 'service', 'data', 'model']

const JAVA_LAYER_WORDS: Array<[JavaLayer, RegExp]> = [
  ['web', /^(controller|controllers|web|api|rest|resource|resources|endpoint|endpoints|handler|handlers|interfaces|facade|gateway)$/],
  ['service', /^(service|services|application|usecase|usecases|biz|business|manager|logic)$/],
  ['data', /^(repository|repositories|repo|dao|daos|mapper|mappers|persistence|infrastructure|infra|db|store|storage)$/],
  ['model', /^(entity|entities|model|models|domain|dto|dtos|vo|vos|po|pojo|bean|beans|bo|dataobject|enums?)$/],
  ['config', /^(config|configs|configuration|conf|settings|properties)$/],
  ['common', /^(util|utils|common|support|helper|helpers|constant|constants|exception|exceptions|shared|tool|tools)$/],
]

const JAVA_LAYER_ANNOTATIONS: Array<[JavaLayer, RegExp]> = [
  ['web', /^(RestController|Controller|ControllerAdvice|RestControllerAdvice|Path|WebServlet)$/],
  ['service', /^Service$/],
  ['data', /^(Repository|Mapper|Dao)$/],
  ['model', /^(Entity|Table|Embeddable|Document|Data|Value)$/],
  ['config', /^(Configuration|ConfigurationProperties|EnableWebSecurity)$/],
]

// 标着这些注解的类是程序入口（另外 public static void main 也算）
export const JAVA_APP_ANNOTATIONS = /^(SpringBootApplication|QuarkusMain|MicronautApplication)$/

export interface JavaPackageView {
  // 完整包名 com.acme.shop.service
  name: string
  // 去掉公共前缀之后的名字（service）；就是公共前缀那个包时是它的最后一段
  short: string
  // analysis.files 的下标
  files: number[]
  layer: JavaLayer | null
  // 判断依据：包名，还是类上的注解
  by: 'name' | 'annotation' | null
  test: boolean
  // 依赖的项目内其他包和引用次数，多的在前
  dependsOn: Array<{ name: string; count: number }>
}

export interface JavaLayerViolation {
  from: string
  to: string
  fromLayer: JavaLayer
  toLayer: JavaLayer
  message: string
  // 最多几处，到文件和行
  edges: Array<{ file: string; line: number; specifier: string }>
}

export interface JavaLayout {
  // 主代码包名的公共前缀（com.acme.shop），没有公共前缀是空串
  prefix: string
  packages: JavaPackageView[]
  violations: JavaLayerViolation[]
}

const MAX_VIOLATION_EDGES = 5

function javaLayerOf(short: string, annotations: string[][]): { layer: JavaLayer | null; by: JavaPackageView['by'] } {
  for (const segment of short.toLowerCase().split('.')) {
    const match = JAVA_LAYER_WORDS.find(([, words]) => words.test(segment))
    if (match) return { layer: match[0], by: 'name' }
  }
  const votes = new Map<JavaLayer, number>()
  for (const list of annotations) {
    for (const annotation of list) {
      const match = JAVA_LAYER_ANNOTATIONS.find(([, pattern]) => pattern.test(annotation))
      if (match) votes.set(match[0], (votes.get(match[0]) ?? 0) + 1)
    }
  }
  const best = [...votes].sort((a, b) => b[1] - a[1])[0]
  return best ? { layer: best[0], by: 'annotation' } : { layer: null, by: null }
}

// Java 为主的项目（解析过的代码文件一半以上是 Java）才有；包按 package 声明分，测试代码（src/test 下）单独算
export function javaLayout(analysis: Pick<ArchitectureAnalysis, 'files' | 'edges'>): JavaLayout | null {
  const parsed = analysis.files.filter((file) => file.parsed).length
  const javaFiles = analysis.files.flatMap((file, index) => (file.language === 'java' && file.parsed && file.namespace ? [index] : []))
  if (javaFiles.length < 2 || javaFiles.length * 2 < parsed) return null
  const isTest = (path: string) => /(^|\/)src\/test\//.test(path)
  const keyOf = (index: number) => {
    const file = analysis.files[index]!
    return `${isTest(file.path) ? 'test:' : ''}${file.namespace}`
  }
  const groups = new Map<string, number[]>()
  for (const index of javaFiles) groups.set(keyOf(index), [...(groups.get(keyOf(index)) ?? []), index])
  const mainNames = [...groups.keys()].filter((key) => !key.startsWith('test:'))
  // 公共前缀按段算；只有一个包时前缀是它的上一级，免得名字是空的
  let prefix = (mainNames[0] ?? '').split('.')
  for (const name of mainNames.slice(1)) {
    const parts = name.split('.')
    let at = 0
    while (at < prefix.length && at < parts.length && prefix[at] === parts[at]) at++
    prefix = prefix.slice(0, at)
  }
  if (mainNames.length === 1) prefix = prefix.slice(0, -1)
  const prefixText = prefix.join('.')
  const shortOf = (name: string) => (prefixText && name.startsWith(`${prefixText}.`) ? name.slice(prefixText.length + 1) : name === prefixText ? (name.split('.').at(-1) ?? name) : name)
  const counts = new Map<string, Map<string, number>>()
  const examples = new Map<string, JavaLayerViolation['edges']>()
  for (const edge of analysis.edges) {
    const from = analysis.files[edge.from]!
    const to = analysis.files[edge.to]!
    if (from.language !== 'java' || to.language !== 'java' || !from.namespace || !to.namespace) continue
    const fromKey = keyOf(edge.from)
    const toKey = keyOf(edge.to)
    if (fromKey === toKey || !groups.has(fromKey) || !groups.has(toKey)) continue
    const row = counts.get(fromKey) ?? new Map<string, number>()
    row.set(toKey, (row.get(toKey) ?? 0) + 1)
    counts.set(fromKey, row)
    const list = examples.get(`${fromKey}>${toKey}`) ?? []
    if (list.length < MAX_VIOLATION_EDGES) list.push({ file: from.path, line: edge.imports[0]?.line ?? 1, specifier: edge.imports[0]?.specifier ?? to.path })
    examples.set(`${fromKey}>${toKey}`, list)
  }
  const packages: JavaPackageView[] = [...groups].map(([key, files]) => {
    const test = key.startsWith('test:')
    const name = test ? key.slice(5) : key
    const short = shortOf(name)
    const { layer, by } = test ? { layer: null, by: null } : javaLayerOf(short, files.map((index) => analysis.files[index]!.annotations ?? []))
    const dependsOn = [...(counts.get(key) ?? [])].map(([target, count]) => ({ name: target.replace(/^test:/, ''), count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    return { name, short, files, layer, by, test, dependsOn }
  })
  packages.sort((a, b) => Number(a.test) - Number(b.test) || a.name.localeCompare(b.name))
  const rank = (layer: JavaLayer | null) => (layer ? JAVA_LAYER_ORDER.indexOf(layer) : -1)
  const violations: JavaLayerViolation[] = []
  for (const from of packages) {
    if (from.test || rank(from.layer) < 0) continue
    for (const target of from.dependsOn) {
      const to = packages.find((item) => !item.test && item.name === target.name)
      if (!to || rank(to.layer) < 0 || rank(from.layer) <= rank(to.layer)) continue
      violations.push({
        from: from.name,
        to: to.name,
        fromLayer: from.layer!,
        toLayer: to.layer!,
        message: `${JAVA_LAYER_NAMES[from.layer!]}的 ${from.short} 反过来依赖${JAVA_LAYER_NAMES[to.layer!]}的 ${to.short}`,
        edges: examples.get(`${from.name}>${to.name}`) ?? [],
      })
    }
  }
  return { prefix: prefixText, packages, violations }
}
