import { type DiagramKind, pathMatcher } from '@diffra/core/architecture'
import { type ArchitectureContextValue, diagramOf } from './context'
import { findBlockIn } from './diagram/diagram-model'
import type { ArchIndex } from './graph'

// 选中的东西：节点 id（和 graph.ts 一致）或者 edge:<起点 id>><终点 id>
export type Selection =
  | { kind: 'dir'; path: string }
  | { kind: 'package'; dir: string }
  | { kind: 'file'; path: string }
  | { kind: 'external'; ecosystem: string; name: string }
  | { kind: 'system'; name: string }
  | { kind: 'project' }
  | { kind: 'edge'; from: string; to: string }
  | { kind: 'block'; diagram: DiagramKind | 'target'; id: string }
  // 方块认领路径里的通配符
  | { kind: 'glob'; pattern: string }

export function parseSelection(id: string): Selection | null {
  if (id.startsWith('edge:')) {
    const rest = id.slice(5)
    // 节点 id 里可能有 >（不会：路径里不允许），按第一个 > 分开
    const split = rest.indexOf('>')
    return split < 0 ? null : { kind: 'edge', from: rest.slice(0, split), to: rest.slice(split + 1) }
  }
  const plain = id.replace(/^outside:/, '')
  if (plain.startsWith('block:')) {
    const rest = plain.slice(6)
    // outside:block:<id> 是应用架构图里的方块
    if (id.startsWith('outside:')) return { kind: 'block', diagram: 'application', id: rest }
    const split = rest.indexOf(':')
    return split < 0 ? null : { kind: 'block', diagram: rest.slice(0, split) as DiagramKind | 'target', id: rest.slice(split + 1) }
  }
  if (plain.startsWith('glob:')) return { kind: 'glob', pattern: plain.slice(5) }
  if (plain === 'project') return { kind: 'project' }
  if (plain.startsWith('dir:')) return { kind: 'dir', path: plain.slice(4) }
  if (plain.startsWith('package:')) return { kind: 'package', dir: plain.slice(8) }
  if (plain.startsWith('file:')) return { kind: 'file', path: plain.slice(5) }
  if (plain.startsWith('system:')) return { kind: 'system', name: plain.slice(7) }
  if (plain.startsWith('external:')) {
    const [ecosystem, ...name] = plain.slice(9).split(':')
    return { kind: 'external', ecosystem: ecosystem ?? '', name: name.join(':') }
  }
  return null
}

// 节点包含哪些文件（文件下标）
export function filesOf(index: ArchIndex, id: string, context: Pick<ArchitectureContextValue, 'diagrams' | 'target' | 'draft'>): number[] {
  const selection = parseSelection(id)
  if (!selection) return []
  switch (selection.kind) {
    case 'project':
      return index.filesUnder('')
    case 'dir':
      return index.filesUnder(selection.path)
    case 'package':
      return index.analysis.files.flatMap((file, at) => (file.package === selection.dir ? [at] : []))
    case 'block': {
      const diagram = diagramOf(context, selection.diagram)
      if (!diagram || !findBlockIn(diagram, selection.id)) return []
      return index.owners(diagram).flatMap((owner, at) => (owner === selection.id ? [at] : []))
    }
    case 'glob': {
      const match = pathMatcher(selection.pattern)
      return index.analysis.files.flatMap((file, at) => (match(file.path) ? [at] : []))
    }
    case 'file': {
      const at = index.fileIndex.get(selection.path)
      return at === undefined ? [] : [at]
    }
    default:
      return []
  }
}

// 两组文件之间的文件级依赖（edges 的下标）
export function edgesBetween(index: ArchIndex, from: readonly number[], to: readonly number[]): number[] {
  const targets = new Set(to)
  const result: number[] = []
  for (const file of from) for (const edge of index.outgoing[file]!) if (targets.has(index.analysis.edges[edge]!.to)) result.push(edge)
  return result
}

// 一组文件对外依赖或被依赖的目录，按依赖条数排
export function neighbourDirs(index: ArchIndex, files: readonly number[], direction: 'out' | 'in'): Array<{ dir: string; count: number }> {
  const inside = new Set(files)
  const counts = new Map<string, number>()
  for (const file of files) {
    for (const edgeIndex of direction === 'out' ? index.outgoing[file]! : index.incoming[file]!) {
      const edge = index.analysis.edges[edgeIndex]!
      const other = direction === 'out' ? edge.to : edge.from
      if (inside.has(other)) continue
      const dir = index.analysis.files[other]!.module
      counts.set(dir, (counts.get(dir) ?? 0) + 1)
    }
  }
  return [...counts].map(([dir, count]) => ({ dir, count })).sort((a, b) => b.count - a.count)
}
