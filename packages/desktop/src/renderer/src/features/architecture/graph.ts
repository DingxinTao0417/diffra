import {
  type ArchitectureAnalysis,
  type ArchitectureDiagrams,
  type ArchitectureInterpretation,
  type BlockDiagram,
  componentOfPath,
  type DiagramBlock,
  diagramBlocks,
  type FileEdge,
  type FileInfo,
  type PackageInfo,
  pathMatcher,
  stronglyConnected,
} from '@diffra/core/architecture'

// 架构图的范围（scope）：
//   system         L0 系统和外部系统
//   project        L1 包（只有一个包时是它的顶层目录）
//   dir:<路径>      L2/L3 目录里的子目录和文件
//   file:<路径>     L4 文件里的符号
//   block:<图>:<方块 id>  架构图里一个方块认领的代码（从方块图双击进来）
export type Scope = 'system' | 'project' | `dir:${string}` | `file:${string}` | `block:${string}`

export type NodeKind = 'project' | 'external-system' | 'package' | 'dir' | 'file' | 'outside' | 'external' | 'more'

export interface GraphNode {
  id: string
  kind: NodeKind
  label: string
  // 完整的相对路径；外部节点是包名
  path: string
  files: number
  lines: number
  churn: number
  // 双击能不能往下钻
  drillable: boolean
  // 在这个范围里依赖它的、它依赖的节点数
  fanIn: number
  fanOut: number
  inCycle: boolean
  // 模型解读给的角色
  role: string | null
}

export interface GraphEdge {
  id: string
  from: string
  to: string
  // 背后的文件级依赖
  edges: number[]
  // import 语句条数
  count: number
  cyclic: boolean
}

export interface ScopeGraph {
  scope: Scope
  nodes: GraphNode[]
  edges: GraphEdge[]
  // 节点太多时合并掉的个数
  hidden: number
  // 每个文件在这一层归到哪个节点（范围内的），对不上的为 null
  fileNodes: Array<string | null>
}

// 一次分析建一份索引，各个视图共用
export class ArchIndex {
  readonly fileIndex = new Map<string, number>()
  readonly childDirs = new Map<string, string[]>()
  readonly dirFiles = new Map<string, number[]>()
  readonly packageByDir = new Map<string, PackageInfo>()
  readonly outgoing: number[][]
  readonly incoming: number[][]
  readonly fileFanIn: Int32Array
  readonly fileFanOut: Int32Array
  // 文件级的循环依赖：文件下标 → 所在的环（分量编号）
  readonly fileCycle = new Map<number, number>()
  readonly fileCycles: number[][]
  private readonly ownerCache = new WeakMap<BlockDiagram, Array<string | null>>()

  constructor(readonly analysis: ArchitectureAnalysis) {
    analysis.files.forEach((file, index) => {
      this.fileIndex.set(file.path, index)
      this.dirFiles.set(file.module, [...(this.dirFiles.get(file.module) ?? []), index])
    })
    for (const module of analysis.modules) {
      if (module.parent !== null) this.childDirs.set(module.parent, [...(this.childDirs.get(module.parent) ?? []), module.path])
    }
    for (const item of analysis.packages) this.packageByDir.set(item.dir, item)
    this.outgoing = analysis.files.map(() => [])
    this.incoming = analysis.files.map(() => [])
    this.fileFanIn = new Int32Array(analysis.files.length)
    this.fileFanOut = new Int32Array(analysis.files.length)
    analysis.edges.forEach((edge, index) => {
      this.outgoing[edge.from]!.push(index)
      this.incoming[edge.to]!.push(index)
      this.fileFanOut[edge.from]!++
      this.fileFanIn[edge.to]!++
    })
    const adjacency = analysis.files.map(() => [] as number[])
    for (const edge of analysis.edges) adjacency[edge.from]!.push(edge.to)
    this.fileCycles = stronglyConnected(analysis.files.length, (node) => adjacency[node]!)
    this.fileCycles.forEach((cycle, index) => {
      for (const file of cycle) this.fileCycle.set(file, index)
    })
  }

  module(path: string) {
    return this.analysis.modules.find((module) => module.path === path) ?? null
  }

  file(path: string): FileInfo | null {
    const index = this.fileIndex.get(path)
    return index === undefined ? null : this.analysis.files[index]!
  }

  // 只有一个子目录、自己没有文件的目录一路往下合并：a/b/c 显示成一个节点
  collapse(path: string): string {
    let current = path
    for (;;) {
      const children = this.childDirs.get(current) ?? []
      if (children.length !== 1 || (this.dirFiles.get(current)?.length ?? 0) > 0) return current
      current = children[0]!
    }
  }

  // 有代码的包（工作区根目录的 package.json 常常没有代码）
  codePackages(): PackageInfo[] {
    return this.analysis.packages.filter((item) => this.analysis.files.some((file) => file.package === item.dir))
  }

  // L1 显示包还是目录：只有一个有代码的包时显示它下面的目录
  projectRoot(): string | null {
    const packages = this.codePackages()
    return packages.length > 1 ? null : this.collapse(packages[0]?.dir ?? '')
  }

  // 每个文件归架构图里的哪个方块（按方块认领的路径，取最具体的）
  owners(diagram: BlockDiagram): Array<string | null> {
    const cached = this.ownerCache.get(diagram)
    if (cached) return cached
    const components = diagramBlocks(diagram)
      .filter(({ block }) => block.paths.length > 0)
      .map(({ block }) => ({ id: block.id, name: block.name, layer: null, paths: block.paths }))
    const owners = this.analysis.files.map((file) => componentOfPath(components, file.path))
    this.ownerCache.set(diagram, owners)
    return owners
  }

  filesUnder(path: string): number[] {
    if (path === '') return this.analysis.files.map((_, index) => index)
    return this.analysis.files.flatMap((file, index) => (file.path.startsWith(`${path}/`) ? [index] : []))
  }
}

export const scopeOfDir = (path: string): Scope => `dir:${path}`
export const scopeOfFile = (path: string): Scope => `file:${path}`

export function parseScope(scope: string): { kind: 'system' | 'project' | 'dir' | 'file' | 'block'; path: string } {
  if (scope.startsWith('dir:')) return { kind: 'dir', path: scope.slice(4) }
  if (scope.startsWith('block:')) return { kind: 'block', path: scope.slice(6) }
  if (scope.startsWith('file:')) return { kind: 'file', path: scope.slice(5) }
  return { kind: scope === 'system' ? 'system' : 'project', path: '' }
}

// 节点 id 对应的路径和类型；双击时换成下一层的范围
export function drillScope(node: GraphNode, index: ArchIndex): Scope | null {
  if (!node.drillable) return null
  if (node.kind === 'project') return 'project'
  if (node.kind === 'package' || node.kind === 'dir') return scopeOfDir(index.collapse(node.path))
  if (node.kind === 'file') return scopeOfFile(node.path)
  if (node.kind === 'outside') {
    if (node.id.startsWith('outside:file:')) return scopeOfFile(node.path)
    if (node.id.startsWith('outside:block:')) return `block:application:${node.id.slice(14)}`
    return scopeOfDir(index.collapse(node.path))
  }
  return null
}

const lastSegments = (path: string, base: string) => (base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path)

const MAX_NODES = 120

interface Member {
  node: GraphNode
  // 这个节点包含哪些文件
  contains: (file: FileInfo, index: number) => boolean
}

function emptyNode(id: string, kind: NodeKind, label: string, path: string, drillable: boolean): GraphNode {
  return { id, kind, label, path, files: 0, lines: 0, churn: 0, drillable, fanIn: 0, fanOut: 0, inCycle: false, role: null }
}

export function findBlock(diagrams: ArchitectureDiagrams, ref: string): DiagramBlock | null {
  const [kind, id] = ref.split(':')
  const diagram = diagrams[kind as keyof ArchitectureDiagrams]
  return diagram ? (diagramBlocks(diagram).find(({ block }) => block.id === id)?.block ?? null) : null
}

function membersOf(index: ArchIndex, scope: Scope, diagrams: ArchitectureDiagrams): { members: Member[]; base: string | null } {
  const { kind, path } = parseScope(scope)
  if (kind === 'block') {
    // 方块只认领一个目录时和进这个目录一样；认领几处时每处一个节点
    const block = findBlock(diagrams, path)
    if (!block) return { members: [], base: null }
    // 目录，或者目录下的直接文件（dir/*）：只有这一处时就当进这个目录
    const asDir = (item: string) => (index.module(item) ? item : item.endsWith('/*') && index.module(item.slice(0, -2)) ? item.slice(0, -2) : null)
    const only = block.paths.length === 1 ? asDir(block.paths[0]!) : null
    if (only !== null) return membersOf(index, scopeOfDir(index.collapse(only)), diagrams)
    return {
      base: null,
      members: block.paths.map((item) => {
        const file = index.file(item)
        if (file) return { node: emptyNode(`file:${item}`, 'file', item.split('/').pop() ?? item, item, true), contains: (candidate: FileInfo) => candidate.path === item }
        if (index.module(item)) return { node: emptyNode(`dir:${item}`, 'dir', item, index.collapse(item), true), contains: (candidate: FileInfo) => candidate.path.startsWith(`${item}/`) }
        const match = pathMatcher(item)
        return { node: emptyNode(`glob:${item}`, 'dir', item, item, false), contains: (candidate: FileInfo) => match(candidate.path) }
      }),
    }
  }
  if (kind === 'project') {
    const root = index.projectRoot()
    if (root === null) {
      return {
        base: null,
        members: index.codePackages().map((item) => ({
          node: emptyNode(`package:${item.dir}`, 'package', item.name, item.dir, true),
          contains: (file: FileInfo) => file.package === item.dir,
        })),
      }
    }
    return membersOf(index, scopeOfDir(root), diagrams)
  }
  const members: Member[] = []
  for (const child of index.childDirs.get(path) ?? []) {
    const collapsed = index.collapse(child)
    const isPackage = index.packageByDir.has(child) && child !== ''
    members.push({
      node: emptyNode(`dir:${child}`, isPackage ? 'package' : 'dir', lastSegments(collapsed, path), collapsed, true),
      contains: (file: FileInfo) => file.path.startsWith(`${child}/`),
    })
  }
  for (const fileIndex of index.dirFiles.get(path) ?? []) {
    const file = index.analysis.files[fileIndex]!
    members.push({ node: emptyNode(`file:${file.path}`, 'file', lastSegments(file.path, path), file.path, true), contains: (_file, position) => position === fileIndex })
  }
  return { members, base: path }
}

// 范围外的文件归到哪个灰色节点：不同包的归到包；同一个包里的，归到它和范围的共同上级下面那一级目录
function outsideKey(index: ArchIndex, file: FileInfo, base: string | null): { id: string; label: string; path: string } {
  if (base === null) return { id: `outside:package:${file.package}`, label: index.packageByDir.get(file.package)?.name ?? file.package, path: file.package }
  const basePackage = index.packageByDir.get(base) ? base : (index.module(base)?.package ?? '')
  if (file.package !== basePackage) {
    const name = index.packageByDir.get(file.package)?.name ?? (file.package || '根目录')
    return { id: `outside:package:${file.package}`, label: name, path: file.package }
  }
  const baseParts = base === '' ? [] : base.split('/')
  const fileParts = file.module === '' ? [] : file.module.split('/')
  let common = 0
  while (common < baseParts.length && common < fileParts.length && baseParts[common] === fileParts[common]) common++
  const path = fileParts.slice(0, common + 1).join('/')
  if (common >= fileParts.length) return { id: `outside:file:${file.path}`, label: file.path.split('/').pop() ?? file.path, path: file.path }
  return { id: `outside:dir:${path}`, label: path.split('/').pop() ?? path, path }
}

// 画依赖图要用到的模型产出：系统那一层用解读里的外部系统；节点的角色、方块范围外的分组用应用架构图
export interface GraphSources {
  interpretation: ArchitectureInterpretation | null
  diagrams: ArchitectureDiagrams
}

export interface ScopeOptions {
  outside: boolean
  externals: boolean
  // 不画只导入类型的依赖
  hideTypeOnly: boolean
}

export function scopeGraph(index: ArchIndex, scope: Scope, sources: GraphSources, options: ScopeOptions): ScopeGraph {
  const { analysis } = index
  if (scope === 'system') return systemGraph(index, sources.interpretation)
  const { members, base } = membersOf(index, scope, sources.diagrams)
  const application = sources.diagrams.application ?? null
  const owners = application ? index.owners(application) : null
  const blockName = (id: string) => (application ? (diagramBlocks(application).find(({ block }) => block.id === id)?.block.name ?? id) : id)
  const memberOfFile = new Int32Array(analysis.files.length).fill(-1)
  analysis.files.forEach((file, fileIndex) => {
    const position = members.findIndex((member) => member.contains(file, fileIndex))
    memberOfFile[fileIndex] = position
    if (position < 0) return
    const node = members[position]!.node
    node.files++
    node.lines += file.lines
    node.churn += file.churn
  })
  // 节点太多：按代码行数留前面的，其余并成一个「其余」节点
  let hidden = 0
  if (members.length > MAX_NODES) {
    const order = members.map((member, position) => ({ position, lines: member.node.lines })).sort((a, b) => b.lines - a.lines)
    const keep = new Set(order.slice(0, MAX_NODES - 1).map((item) => item.position))
    const more = emptyNode('more', 'more', '', base ?? '', false)
    const remap = new Map<number, number>()
    const kept: Member[] = []
    members.forEach((member, position) => {
      if (keep.has(position)) {
        remap.set(position, kept.length)
        kept.push(member)
      } else {
        hidden++
        more.files += member.node.files
        more.lines += member.node.lines
      }
    })
    const morePosition = kept.length
    kept.push({ node: more, contains: () => false })
    more.label = `其余 ${hidden} 项`
    for (let fileIndex = 0; fileIndex < memberOfFile.length; fileIndex++) {
      const position = memberOfFile[fileIndex]!
      if (position >= 0) memberOfFile[fileIndex] = remap.get(position) ?? morePosition
    }
    members.splice(0, members.length, ...kept)
  }

  const nodes = new Map<string, GraphNode>(members.map((member) => [member.node.id, member.node]))
  const edgeMap = new Map<string, GraphEdge>()
  const addEdge = (from: string, to: string, edgeIndex: number, imports: number) => {
    const id = `${from}>${to}`
    const edge = edgeMap.get(id) ?? { id, from, to, edges: [], count: 0, cyclic: false }
    edge.edges.push(edgeIndex)
    edge.count += imports
    edgeMap.set(id, edge)
  }
  const nodeIdOf = (fileIndex: number): string | null => {
    const position = memberOfFile[fileIndex]!
    if (position >= 0) return members[position]!.node.id
    if (!options.outside) return null
    const file = analysis.files[fileIndex]!
    // 方块范围外的代码按应用架构图的方块分组
    const owner = scope.startsWith('block:') ? (owners?.[fileIndex] ?? null) : null
    const key = owner ? { id: `outside:block:${owner}`, label: blockName(owner), path: '' } : outsideKey(index, file, base)
    if (!nodes.has(key.id)) nodes.set(key.id, emptyNode(key.id, 'outside', key.label, key.path, true))
    return key.id
  }
  analysis.edges.forEach((edge: FileEdge, edgeIndex) => {
    if (options.hideTypeOnly && edge.imports.every((item) => item.kind === 'type')) return
    const fromInside = memberOfFile[edge.from]! >= 0
    const toInside = memberOfFile[edge.to]! >= 0
    if (!fromInside && !toInside) return
    const from = nodeIdOf(edge.from)
    const to = nodeIdOf(edge.to)
    if (!from || !to || from === to) return
    addEdge(from, to, edgeIndex, edge.imports.length)
  })
  if (options.externals) {
    for (const external of analysis.externals) {
      if (external.builtin) continue
      const users = new Set<string>()
      for (const use of external.uses) {
        const position = memberOfFile[use.file]!
        if (position >= 0) users.add(members[position]!.node.id)
      }
      if (users.size === 0) continue
      const id = `external:${external.ecosystem}:${external.name}`
      nodes.set(id, { ...emptyNode(id, 'external', external.name, external.name, false), files: external.count })
      for (const user of users) {
        const edgeId = `${user}>${id}`
        edgeMap.set(edgeId, { id: edgeId, from: user, to: id, edges: [], count: external.uses.filter((use) => members[memberOfFile[use.file]!]?.node.id === user).length, cyclic: false })
      }
    }
  }

  const edges = [...edgeMap.values()]
  for (const edge of edges) {
    nodes.get(edge.from)!.fanOut++
    nodes.get(edge.to)!.fanIn++
  }
  // 范围内节点之间的环
  const inner = members.map((member) => member.node.id)
  const position = new Map(inner.map((id, at) => [id, at]))
  const adjacency = inner.map(() => [] as number[])
  for (const edge of edges) {
    const from = position.get(edge.from)
    const to = position.get(edge.to)
    if (from !== undefined && to !== undefined) adjacency[from]!.push(to)
  }
  const component = new Map<string, number>()
  stronglyConnected(inner.length, (node) => adjacency[node]!).forEach((cycle, at) => {
    for (const node of cycle) {
      component.set(inner[node]!, at)
      nodes.get(inner[node]!)!.inCycle = true
    }
  })
  for (const edge of edges) {
    const from = component.get(edge.from)
    edge.cyclic = from !== undefined && from === component.get(edge.to)
  }
  // 节点正好是应用架构图里某个方块认领的路径：标上方块名
  if (application) {
    const roles = new Map(diagramBlocks(application).flatMap(({ block }) => block.paths.map((path) => [path, block.name] as const)))
    for (const node of nodes.values()) node.role = roles.get(node.path) ?? null
  }
  const fileNodes = Array.from(memberOfFile, (position) => (position >= 0 ? members[position]!.node.id : null))
  return { scope, nodes: [...nodes.values()], edges, hidden, fileNodes }
}

function systemGraph(index: ArchIndex, interpretation: ArchitectureInterpretation | null): ScopeGraph {
  const { analysis } = index
  const project: GraphNode = {
    ...emptyNode('project', 'project', analysis.root.replace(/\\/g, '/').split('/').pop() ?? '项目', '', true),
    files: analysis.stats.files,
    lines: analysis.stats.lines,
  }
  const nodes: GraphNode[] = [project]
  const edges: GraphEdge[] = []
  if (interpretation && interpretation.externalSystems.length > 0) {
    for (const system of interpretation.externalSystems) {
      const id = `system:${system.name}`
      nodes.push({ ...emptyNode(id, 'external-system', system.name, system.name, false), role: system.kind })
      edges.push({ id: `project>${id}`, from: 'project', to: id, edges: [], count: system.packages.length, cyclic: false })
    }
  } else {
    // 还没有模型解读：用最常用的外部包代替外部系统
    for (const external of analysis.externals.filter((item) => !item.builtin).slice(0, 12)) {
      const id = `external:${external.ecosystem}:${external.name}`
      nodes.push({ ...emptyNode(id, 'external', external.name, external.name, false), files: external.count })
      edges.push({ id: `project>${id}`, from: 'project', to: id, edges: [], count: external.count, cyclic: false })
    }
  }
  return { scope: 'system', nodes, edges, hidden: 0, fileNodes: analysis.files.map(() => 'project') }
}

// 分层：被依赖的在下面。环缩成一点后按最长路径排；返回节点 id → 第几层（0 是最上层）
export function rankLayers(graph: Pick<ScopeGraph, 'nodes' | 'edges'>): Map<string, number> {
  const ids = graph.nodes.map((node) => node.id)
  const position = new Map(ids.map((id, at) => [id, at]))
  const adjacency = ids.map(() => [] as number[])
  for (const edge of graph.edges) {
    const from = position.get(edge.from)
    const to = position.get(edge.to)
    if (from !== undefined && to !== undefined && from !== to) adjacency[from]!.push(to)
  }
  const group = ids.map((_, at) => at)
  for (const cycle of stronglyConnected(ids.length, (node) => adjacency[node]!)) for (const node of cycle) group[node] = cycle[0]!
  const rank = new Map<number, number>()
  const visiting = new Set<number>()
  // 一个节点的层 = 依赖它的节点里最深的那层 + 1；用记忆化的深度优先求前驱最长路径
  const predecessors = ids.map(() => [] as number[])
  adjacency.forEach((targets, from) => {
    for (const to of targets) if (group[from] !== group[to]) predecessors[group[to]!]!.push(group[from]!)
  })
  const depth = (node: number): number => {
    const known = rank.get(node)
    if (known !== undefined) return known
    if (visiting.has(node)) return 0
    visiting.add(node)
    let value = 0
    for (const parent of predecessors[node]!) value = Math.max(value, depth(parent) + 1)
    visiting.delete(node)
    rank.set(node, value)
    return value
  }
  return new Map(ids.map((id, at) => [id, depth(group[at]!)]))
}

export interface Hotspot {
  file: number
  score: number
}

// 热点：规模 × 改动频率 × 耦合度，各自取对数压一压，免得一个超大文件压过一切
export function hotspots(index: ArchIndex, files: readonly number[]): Hotspot[] {
  return files
    .map((file) => {
      const info = index.analysis.files[file]!
      const coupling = index.fileFanIn[file]! + index.fileFanOut[file]!
      const score = Math.log2(info.lines + 1) * Math.log2(info.churn + 2) * Math.log2(coupling + 2)
      return { file, score }
    })
    .sort((a, b) => b.score - a.score)
}

// 两个节点之间的依赖路径（广度优先，最短的一条）
export function findPath(graph: Pick<ScopeGraph, 'edges'>, from: string, to: string): string[] | null {
  const next = new Map<string, string[]>()
  for (const edge of graph.edges) next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to])
  const previous = new Map<string, string>([[from, from]])
  const queue = [from]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (current === to) break
    for (const target of next.get(current) ?? []) {
      if (previous.has(target)) continue
      previous.set(target, current)
      queue.push(target)
    }
  }
  if (!previous.has(to)) return null
  const path = [to]
  while (path[0] !== from) path.unshift(previous.get(path[0]!)!)
  return path
}

export function formatCount(value: number): string {
  if (value >= 10_000) return `${(value / 10_000).toFixed(value >= 100_000 ? 0 : 1)} 万`
  return value.toLocaleString('zh-CN')
}
