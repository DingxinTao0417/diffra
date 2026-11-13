import '@xyflow/react/dist/style.css'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Graph, layout as runDagre } from '@dagrejs/dagre'
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react'
import { Box, CircleAlert, Ellipsis, FileCode2, Folder, Globe, Network, Package, RotateCcw, SquareDashed } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { saveLayout } from '../architecture-store'
import { useArch } from '../context'
import { drillScope, findPath, formatCount, type GraphNode, type NodeKind, type Scope, type ScopeGraph, type ScopeOptions, scopeGraph } from '../graph'
import { FileAnatomy } from './FileAnatomy'

const NODE_WIDTH = 216
const FIT_VIEW = { padding: 0.15, maxZoom: 1.2 }
const NODE_HEIGHT = 68

type Direction = 'TB' | 'LR'

interface ArchNodeData extends Record<string, unknown> {
  node: GraphNode
  dimmed: boolean
  violations: number
  share: number
  direction: Direction
}

type ArchFlowNode = Node<ArchNodeData, 'arch'>

const ICONS: Record<NodeKind, typeof Folder> = {
  project: Network,
  'external-system': Globe,
  package: Package,
  dir: Folder,
  file: FileCode2,
  outside: SquareDashed,
  external: Box,
  more: Ellipsis,
}

// 架构图：当前范围里的节点和它们之间的依赖。双击往下钻，点线看背后的 import
export function GraphView() {
  const { route } = useArch()
  if (route.scope.startsWith('file:')) return <FileAnatomy path={route.scope.slice(5)} />
  return (
    <ReactFlowProvider>
      <ScopeCanvas />
    </ReactFlowProvider>
  )
}

// 被依赖的一方在下面（或右边），箭头指向被依赖的一方
function layoutGraph(graph: ScopeGraph, direction: Direction): Map<string, { x: number; y: number }> {
  const dagre = new Graph()
  dagre.setGraph({ rankdir: direction, nodesep: 32, ranksep: 72, marginx: 24, marginy: 24 })
  dagre.setDefaultEdgeLabel(() => ({}))
  for (const node of graph.nodes) dagre.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  for (const edge of graph.edges) dagre.setEdge(edge.from, edge.to)
  runDagre(dagre)
  const positions = new Map<string, { x: number; y: number }>()
  for (const node of graph.nodes) {
    const point = dagre.node(node.id) as { x: number; y: number }
    positions.set(node.id, { x: point.x - NODE_WIDTH / 2, y: point.y - NODE_HEIGHT / 2 })
  }
  return positions
}

export const FLOW_STYLE = {
  '--xy-background-color': 'var(--background)',
  '--xy-background-pattern-color': 'var(--border)',
  '--xy-edge-stroke': 'var(--muted-foreground)',
  '--xy-edge-label-background-color': 'var(--card)',
  '--xy-edge-label-color': 'var(--foreground)',
  '--xy-minimap-background-color': 'var(--card)',
  '--xy-minimap-mask-background-color': 'color-mix(in oklab, var(--background) 70%, transparent)',
  '--xy-minimap-node-background-color': 'var(--muted)',
  '--xy-controls-button-background-color': 'var(--card)',
  '--xy-controls-button-background-color-hover': 'var(--accent)',
  '--xy-controls-button-color': 'var(--foreground)',
  '--xy-controls-button-border-color': 'var(--border)',
} as React.CSSProperties

function ScopeCanvas() {
  const { index, interpretation, diagrams, evaluation, layout, project, route, go } = useArch()
  const [options, setOptions] = useState<ScopeOptions>({ outside: true, externals: false, hideTypeOnly: false })
  const [direction, setDirection] = useState<Direction>('TB')
  const [pathTo, setPathTo] = useState<string | null>(null)
  const flow = useReactFlow()
  // useReactFlow 每次渲染给的对象不一样，放进依赖会让选中节点时也重新缩放
  const flowRef = useRef(flow)
  flowRef.current = flow
  const scope = route.scope as Scope
  const graph = useMemo(() => scopeGraph(index, scope, { interpretation, diagrams }, options), [index, scope, interpretation, diagrams, options])
  const automatic = useMemo(() => layoutGraph(graph, direction), [graph, direction])
  const viewKey = `${scope}|${direction}`
  const saved = layout[viewKey]

  // 违反目标架构的文件级依赖，和每个节点涉及几处
  const violating = useMemo(() => {
    const edges = new Set<string>()
    for (const violation of evaluation?.violations ?? []) for (const edge of violation.edges) if (violation.kind !== 'external') edges.add(`${edge.from}>${edge.to}`)
    return edges
  }, [evaluation])
  const violationsByNode = useMemo(() => {
    const counts = new Map<string, number>()
    for (const key of violating) {
      const [from] = key.split('>').map(Number)
      const node = graph.fileNodes[from!]
      if (node) counts.set(node, (counts.get(node) ?? 0) + 1)
    }
    return counts
  }, [violating, graph])

  const focus = route.focus && graph.nodes.some((node) => node.id === route.focus) ? route.focus : null
  const focusEdge = route.focus?.startsWith('edge:') ? route.focus.slice(5) : null
  const path = useMemo(() => {
    if (!focus || !pathTo) return null
    return findPath(graph, focus, pathTo) ?? findPath(graph, pathTo, focus)
  }, [graph, focus, pathTo])
  const neighbours = useMemo(() => {
    if (path) return new Set(path)
    if (!focus) return null
    const set = new Set([focus])
    for (const edge of graph.edges) {
      if (edge.from === focus) set.add(edge.to)
      if (edge.to === focus) set.add(edge.from)
    }
    return set
  }, [graph, focus, path])
  const pathEdges = useMemo(() => new Set(path ? path.slice(1).map((id, at) => `${path[at]}>${id}`) : []), [path])

  const maxLines = Math.max(1, ...graph.nodes.map((node) => (node.kind === 'external' ? 0 : node.lines)))
  const baseNodes = useMemo<ArchFlowNode[]>(
    () =>
      graph.nodes.map((node) => ({
        id: node.id,
        type: 'arch',
        position: saved?.[node.id] ?? automatic.get(node.id) ?? { x: 0, y: 0 },
        // 节点大小固定：React Flow 对没量过尺寸的新节点对象会先隐藏一帧，选中节点时整组换新对象，双击的第二下会点空
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        measured: { width: NODE_WIDTH, height: NODE_HEIGHT },
        selected: node.id === focus,
        data: { node, dimmed: neighbours !== null && !neighbours.has(node.id), violations: violationsByNode.get(node.id) ?? 0, share: node.lines / maxLines, direction },
      })),
    [graph, saved, automatic, focus, neighbours, violationsByNode, maxLines, direction],
  )
  const [nodes, setNodes] = useState<ArchFlowNode[]>(baseNodes)
  useEffect(() => setNodes(baseNodes), [baseNodes])

  // 换范围、换方向后让整张图进入视野；第一次显示由 fitView 属性处理，这里再动一次画面会在用户点的时候跳
  const fittedKey = useRef(`${scope}|${direction}|${JSON.stringify(options)}`)
  useEffect(() => {
    const key = `${scope}|${direction}|${JSON.stringify(options)}`
    if (fittedKey.current === key) return
    fittedKey.current = key
    const timer = setTimeout(() => void flowRef.current.fitView({ ...FIT_VIEW, duration: 200 }), 30)
    return () => clearTimeout(timer)
  }, [scope, direction, options])

  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => {
        const violation = edge.edges.some((file) => {
          const item = index.analysis.edges[file]!
          return violating.has(`${item.from}>${item.to}`)
        })
        const onPath = pathEdges.has(edge.id)
        const selected = focusEdge === edge.id
        const dimmed = neighbours !== null && !(neighbours.has(edge.from) && neighbours.has(edge.to)) && !selected
        const color = violation ? 'var(--destructive)' : edge.cyclic ? 'var(--warning)' : onPath || selected ? 'var(--foreground)' : 'var(--muted-foreground)'
        const touching = focus !== null && (edge.from === focus || edge.to === focus)
        return {
          id: edge.id,
          source: edge.from,
          target: edge.to,
          type: 'default',
          label: touching || selected || onPath ? String(edge.count) : undefined,
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color },
          style: {
            stroke: color,
            strokeWidth: Math.min(4, 1 + Math.log2(edge.count + 1) * 0.5) + (onPath || selected ? 1 : 0),
            opacity: dimmed ? 0.12 : edge.from.startsWith('external:') || edge.to.startsWith('external:') ? 0.5 : 0.85,
          },
          interactionWidth: 14,
        }
      }),
    [graph, index, violating, pathEdges, focusEdge, neighbours, focus],
  )

  const onNodesChange = (changes: NodeChange<ArchFlowNode>[]) => setNodes((current) => applyNodeChanges(changes, current))
  const savePositions = () => saveLayout(project.id, viewKey, Object.fromEntries(nodes.map((node) => [node.id, node.position])))
  const drill = (node: GraphNode) => {
    const next = drillScope(node, index)
    if (next) go({ scope: next, focus: null })
  }

  if (graph.nodes.length === 0) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">这一层没有代码</div>
  return (
    <div className="flex h-full flex-col" data-testid="architecture-graph">
      <div className="flex items-center gap-x-4 overflow-hidden border-b px-3 py-1.5 text-xs whitespace-nowrap [&>*:not(:last-child)]:shrink-0">
        <Toggle label="范围外" checked={options.outside} onChange={(outside) => setOptions((current) => ({ ...current, outside }))} />
        <Toggle label="外部包" checked={options.externals} onChange={(externals) => setOptions((current) => ({ ...current, externals }))} />
        <Toggle label="隐藏只导入类型的" checked={options.hideTypeOnly} onChange={(hideTypeOnly) => setOptions((current) => ({ ...current, hideTypeOnly }))} />
        <Button variant="ghost" size="xs" onClick={() => setDirection((current) => (current === 'TB' ? 'LR' : 'TB'))}>
          {direction === 'TB' ? '改成横向' : '改成纵向'}
        </Button>
        {saved && (
          <Button variant="ghost" size="xs" onClick={() => saveLayout(project.id, viewKey, null)}>
            <RotateCcw className="size-3" />
            重新排列
          </Button>
        )}
        {/* 一直占着位置：选中节点时工具栏不变高，画布不往下挪 */}
        <Select value={focus ? (pathTo ?? '') : ''} disabled={!focus} onValueChange={(value) => setPathTo(value || null)}>
          <SelectTrigger size="sm" className="h-7 w-52 text-xs" aria-label="依赖路径">
            <SelectValue placeholder={focus ? '查它到另一个节点的依赖路径' : '选中节点后可查依赖路径'} />
          </SelectTrigger>
          <SelectContent>
            {graph.nodes
              .filter((node) => node.id !== focus)
              .map((node) => (
                <SelectItem key={node.id} value={node.id}>
                  {node.label}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <span className="ml-auto min-w-0 truncate text-muted-foreground">
          {focus && pathTo && !path ? '两者之间没有依赖路径 · ' : ''}
          {graph.nodes.length} 个节点 · {graph.edges.length} 条依赖{graph.hidden > 0 ? ` · 小的 ${graph.hidden} 项合并了` : ''}
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        <ReactFlow<ArchFlowNode, Edge>
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onNodeDragStop={savePositions}
          onNodeClick={(_event, node) => go({ focus: node.id }, false)}
          onNodeDoubleClick={(_event, node) => drill(node.data.node)}
          onEdgeClick={(_event, edge) => go({ focus: `edge:${edge.id}` }, false)}
          onPaneClick={() => route.focus && go({ focus: null }, false)}
          nodesConnectable={false}
          zoomOnDoubleClick={false}
          minZoom={0.1}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          style={FLOW_STYLE}
          fitView
          fitViewOptions={FIT_VIEW}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
          <Controls showInteractive={false} position="bottom-right" />
          <MiniMap pannable zoomable position="top-right" nodeStrokeWidth={2} className="!border !border-border" />
        </ReactFlow>
        <Legend />
      </div>
    </div>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(value: boolean): void }) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5">
      <Switch label={label} checked={checked} onChange={onChange} />
      {label}
    </label>
  )
}

function Legend() {
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 flex flex-col gap-1 rounded-md border bg-card/90 px-2.5 py-2 text-xs text-muted-foreground">
      <span>箭头指向被依赖的一方 · 单击选中 · 双击进入</span>
      <span className="flex items-center gap-3">
        <span className="flex items-center gap-1">
          <span className="h-0.5 w-4 bg-warning" />
          循环依赖
        </span>
        <span className="flex items-center gap-1">
          <span className="h-0.5 w-4 bg-destructive" />
          违反目标架构
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2.5 rounded-sm border border-dashed border-muted-foreground" />
          范围外
        </span>
      </span>
    </div>
  )
}

const ArchNode = memo(function ArchNode({ data, selected }: NodeProps<ArchFlowNode>) {
  const { node, dimmed, violations, share, direction } = data
  const Icon = ICONS[node.kind]
  const faint = node.kind === 'outside' || node.kind === 'external' || node.kind === 'more'
  const detail =
    node.kind === 'external'
      ? `${node.files} 处使用`
      : node.kind === 'external-system'
        ? (node.role ?? '外部系统')
        : node.kind === 'more'
          ? `${node.files} 个文件`
          : // 范围外的节点只代表依赖指向的那一片代码，不统计它的规模
            node.kind === 'outside'
            ? `范围外 · ${node.fanIn + node.fanOut} 条依赖`
            : `${formatCount(node.files)} 文件 · ${formatCount(node.lines)} 行`
  return (
    <div
      className={cn(
        'flex flex-col justify-center gap-0.5 overflow-hidden rounded-lg border bg-card px-3 text-left transition-opacity',
        faint && 'border-dashed bg-muted/50 text-muted-foreground',
        node.kind === 'package' && 'border-foreground/30',
        selected && 'ring-2 ring-ring',
        dimmed && 'opacity-30',
      )}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
      title={node.path || node.label}
      data-testid="architecture-node"
    >
      <Handle type="target" position={direction === 'TB' ? Position.Top : Position.Left} isConnectable={false} className="!size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent" />
      <div className="flex min-w-0 items-center gap-1.5">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm">{node.label}</span>
        {node.inCycle && <CircleAlert className="size-3.5 shrink-0 text-warning" aria-label="在循环依赖里" />}
        {violations > 0 && <span className="shrink-0 rounded-sm bg-destructive px-1 text-xs text-destructive-foreground tabular-nums">{violations}</span>}
      </div>
      <div className="truncate text-xs text-muted-foreground">{node.role ? `${node.role} · ${detail}` : detail}</div>
      {!faint && node.kind !== 'external-system' && (
        <div className="mt-0.5 h-0.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-foreground/30" style={{ width: `${Math.max(2, share * 100)}%` }} />
        </div>
      )}
      <Handle type="source" position={direction === 'TB' ? Position.Bottom : Position.Right} isConnectable={false} className="!size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent" />
    </div>
  )
})

const NODE_TYPES = { arch: ArchNode }
