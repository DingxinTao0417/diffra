import { type BlockDiagram, type BlockKind, type DiagramBlock, diagramBlocks, type DiagramGroup, type DiagramLayer, type DiagramSide } from '@diffra/core/architecture'
import type { ArchIndex } from '../graph'

export interface BlockOverlay {
  files: number
  lines: number
  // 技术方块：它列的外部包在代码里被导入的次数
  uses: number
  violations: number
  // 目标架构里还没有代码的方块
  planned: boolean
}

// 方块上显示的数字：代码方块按认领的文件算，技术方块按外部包的导入次数算
export function blockOverlays(index: ArchIndex, diagram: BlockDiagram): Map<string, BlockOverlay> {
  const owners = index.owners(diagram)
  const result = new Map<string, BlockOverlay>()
  for (const { block } of diagramBlocks(diagram)) result.set(block.id, { files: 0, lines: 0, uses: 0, violations: 0, planned: false })
  owners.forEach((owner, at) => {
    const overlay = owner ? result.get(owner) : undefined
    if (!overlay) return
    overlay.files++
    overlay.lines += index.analysis.files[at]!.lines
  })
  const usage = new Map(index.analysis.externals.map((external) => [external.name, external.count]))
  for (const { block } of diagramBlocks(diagram)) {
    const overlay = result.get(block.id)!
    overlay.uses = block.packages.reduce((sum, name) => sum + (usage.get(name) ?? 0), 0)
    overlay.planned = block.kind === 'code' && block.paths.length > 0 && overlay.files === 0
  }
  return result
}

// 方块之间的依赖：文件级依赖映射到认领它们的方块，键是「起点>终点」，值是文件级依赖条数
export function blockLinks(index: ArchIndex, diagram: BlockDiagram): Map<string, number> {
  const owners = index.owners(diagram)
  const links = new Map<string, number>()
  for (const edge of index.analysis.edges) {
    const from = owners[edge.from]
    const to = owners[edge.to]
    if (!from || !to || from === to) continue
    const key = `${from}>${to}`
    links.set(key, (links.get(key) ?? 0) + 1)
  }
  return links
}

export function relatedBlocks(links: Map<string, number>, id: string): { uses: Set<string>; usedBy: Set<string> } {
  const uses = new Set<string>()
  const usedBy = new Set<string>()
  for (const key of links.keys()) {
    const [from, to] = key.split('>') as [string, string]
    if (from === id) uses.add(to)
    if (to === id) usedBy.add(from)
  }
  return { uses, usedBy }
}

export function findBlockIn(diagram: BlockDiagram, id: string): DiagramBlock | null {
  return diagramBlocks(diagram).find(({ block }) => block.id === id)?.block ?? null
}

export function blockPlace(diagram: BlockDiagram, id: string): { layer: DiagramLayer | null; group: DiagramGroup | null; side: DiagramSide | null } {
  const place = diagramBlocks(diagram).find(({ block }) => block.id === id)
  return {
    layer: diagram.layers.find((layer) => layer.id === place?.layer) ?? null,
    group: diagram.layers.flatMap((layer) => layer.groups).find((group) => group.id === place?.group) ?? null,
    side: diagram.sides.find((side) => side.id === place?.side) ?? null,
  }
}

// ---------- 编辑：都返回新的图；改过的方块、分组、层、竖栏标成手改（pinned），重新生成时保留 ----------

export const newId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 9)}`

const mapBlocks = (diagram: BlockDiagram, change: (blocks: DiagramBlock[], where: { group?: DiagramGroup; side?: DiagramSide }) => DiagramBlock[]): BlockDiagram => ({
  ...diagram,
  layers: diagram.layers.map((layer) => ({ ...layer, groups: layer.groups.map((group) => ({ ...group, blocks: change(group.blocks, { group }) })) })),
  sides: diagram.sides.map((side) => ({ ...side, blocks: change(side.blocks, { side }) })),
})

export function updateBlock(diagram: BlockDiagram, id: string, change: Partial<Omit<DiagramBlock, 'id'>>): BlockDiagram {
  return mapBlocks(diagram, (blocks) => blocks.map((item) => (item.id === id ? { ...item, ...change, pinned: true, unverified: false } : item)))
}

export function removeBlock(diagram: BlockDiagram, id: string): BlockDiagram {
  return mapBlocks(diagram, (blocks) => blocks.filter((item) => item.id !== id))
}

// 移到某个分组或竖栏的末尾（before 给了就插在那个方块前面）
export function moveBlock(diagram: BlockDiagram, id: string, target: { group?: string; side?: string; before?: string }): BlockDiagram {
  const moving = findBlockIn(diagram, id)
  if (!moving || target.before === id) return diagram
  const pinned = { ...moving, pinned: true }
  const insert = (blocks: DiagramBlock[]) => {
    const at = target.before ? blocks.findIndex((item) => item.id === target.before) : -1
    return at < 0 ? [...blocks, pinned] : [...blocks.slice(0, at), pinned, ...blocks.slice(at)]
  }
  return mapBlocks(removeBlock(diagram, id), (blocks, where) => ((where.group && where.group.id === target.group) || (where.side && where.side.id === target.side) ? insert(blocks) : blocks))
}

export function addBlock(diagram: BlockDiagram, target: { group?: string; side?: string }, kind: BlockKind): { diagram: BlockDiagram; id: string } {
  const id = newId('block')
  const created: DiagramBlock = { id, name: '新方块', description: '', kind, paths: [], packages: [], pinned: true, unverified: false }
  return { diagram: mapBlocks(diagram, (blocks, where) => ((where.group && where.group.id === target.group) || (where.side && where.side.id === target.side) ? [...blocks, created] : blocks)), id }
}

export function updateLayer(diagram: BlockDiagram, id: string, change: Partial<Pick<DiagramLayer, 'name' | 'description'>>): BlockDiagram {
  return { ...diagram, layers: diagram.layers.map((layer) => (layer.id === id ? { ...layer, ...change, pinned: true } : layer)) }
}

export function addLayer(diagram: BlockDiagram, at: number): BlockDiagram {
  const layer: DiagramLayer = { id: newId('layer'), name: '新的层', description: '', groups: [{ id: newId('group'), name: '', blocks: [], pinned: true }], pinned: true }
  const layers = [...diagram.layers.slice(0, at), layer, ...diagram.layers.slice(at)]
  return withConnectors({ ...diagram, layers })
}

// 只删空的层；它上下的连线一起重排
export function removeLayer(diagram: BlockDiagram, id: string): BlockDiagram {
  const layers = diagram.layers.filter((layer) => layer.id !== id)
  const ids = new Set(layers.map((layer) => layer.id))
  const sides = diagram.sides.map((side) => ({ ...side, from: ids.has(side.from) ? side.from : (layers[0]?.id ?? side.from), to: ids.has(side.to) ? side.to : (layers[layers.length - 1]?.id ?? side.to) }))
  return withConnectors({ ...diagram, layers, sides })
}

export function moveLayer(diagram: BlockDiagram, id: string, step: -1 | 1): BlockDiagram {
  const at = diagram.layers.findIndex((layer) => layer.id === id)
  const target = at + step
  if (at < 0 || target < 0 || target >= diagram.layers.length) return diagram
  const layers = [...diagram.layers]
  const [layer] = layers.splice(at, 1)
  layers.splice(target, 0, { ...layer!, pinned: true })
  return withConnectors({ ...diagram, layers })
}

// 相邻两层之间各有一条连线；原来有标签的留着
function withConnectors(diagram: BlockDiagram): BlockDiagram {
  const connectors = diagram.layers.slice(0, -1).map((layer, at) => {
    const next = diagram.layers[at + 1]!
    return diagram.connectors.find((item) => item.from === layer.id && item.to === next.id) ?? { from: layer.id, to: next.id, label: '' }
  })
  return { ...diagram, connectors }
}

export function setConnectorLabel(diagram: BlockDiagram, from: string, to: string, label: string): BlockDiagram {
  const exists = diagram.connectors.some((item) => item.from === from && item.to === to)
  return { ...diagram, connectors: exists ? diagram.connectors.map((item) => (item.from === from && item.to === to ? { ...item, label } : item)) : [...diagram.connectors, { from, to, label }] }
}

export function addGroup(diagram: BlockDiagram, layerId: string): BlockDiagram {
  return { ...diagram, layers: diagram.layers.map((layer) => (layer.id === layerId ? { ...layer, groups: [...layer.groups, { id: newId('group'), name: '新分组', blocks: [], pinned: true }] } : layer)) }
}

export function updateGroup(diagram: BlockDiagram, id: string, name: string): BlockDiagram {
  return { ...diagram, layers: diagram.layers.map((layer) => ({ ...layer, groups: layer.groups.map((group) => (group.id === id ? { ...group, name, pinned: true } : group)) })) }
}

// 删分组：里面的方块挪到同层的第一个别的分组（没有就留一个无标题分组）
export function removeGroup(diagram: BlockDiagram, id: string): BlockDiagram {
  return {
    ...diagram,
    layers: diagram.layers.map((layer) => {
      const group = layer.groups.find((item) => item.id === id)
      if (!group) return layer
      const rest = layer.groups.filter((item) => item.id !== id)
      if (group.blocks.length === 0) return { ...layer, groups: rest }
      if (rest.length === 0) return { ...layer, groups: [{ ...group, name: '', pinned: true }] }
      return { ...layer, groups: rest.map((item, at) => (at === 0 ? { ...item, blocks: [...item.blocks, ...group.blocks], pinned: true } : item)) }
    }),
  }
}

export function addSide(diagram: BlockDiagram): BlockDiagram {
  const first = diagram.layers[0]?.id
  const last = diagram.layers[diagram.layers.length - 1]?.id
  if (!first || !last) return diagram
  return { ...diagram, sides: [...diagram.sides, { id: newId('side'), name: '新竖栏', description: '', from: first, to: last, blocks: [], pinned: true }] }
}

export function updateSide(diagram: BlockDiagram, id: string, change: Partial<Pick<DiagramSide, 'name' | 'description' | 'from' | 'to'>>): BlockDiagram {
  return { ...diagram, sides: diagram.sides.map((side) => (side.id === id ? { ...side, ...change, pinned: true } : side)) }
}

export function removeSide(diagram: BlockDiagram, id: string): BlockDiagram {
  return { ...diagram, sides: diagram.sides.filter((side) => side.id !== id) }
}

export function emptyDiagram(kind: BlockDiagram['kind']): BlockDiagram {
  const layers: DiagramLayer[] = ['界面', '业务', '基础'].map((name) => ({ id: newId('layer'), name, description: '', groups: [{ id: newId('group'), name: '', blocks: [], pinned: true }], pinned: true }))
  return withConnectors({ kind, source: 'model', generatedAt: new Date().toISOString(), model: null, fingerprint: '', layers, sides: [], connectors: [], dropped: 0 })
}
