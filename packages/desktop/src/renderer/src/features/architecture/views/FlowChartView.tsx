import { type KeyboardEvent, useId, useMemo, useRef, useState } from 'react'
import { Graph, layout as runDagre } from '@dagrejs/dagre'
import type { FlowChart, FlowChartNode } from '@diffra/core/architecture'
import { LoaderCircle, RefreshCw, Sparkles, Workflow } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { formatTime } from '@/lib/format'
import { useArch } from '../context'
import { svgFont, textWidth, wrapText } from './svg-text'

// 流程图（第 698 步）：模型读这条流程经过的代码画的控制流程，dagre 排版画成 SVG。
// 动作是方框、判断是菱形、开始结束是圆角条，循环和阶段用虚线框圈起来；右边是流程讲解，悬停一条突出它说的节点；点有代码位置的节点看代码。颜色只用令牌

const LABEL_SIZE = 12
const DETAIL_SIZE = 11
const LINE = 16
const DETAIL_LINE = 14
// 节点里一行字最宽多少，再长就折行
const TEXT_MAX = 176

type Point = { x: number; y: number }
type LaidNode = FlowChartNode & { x: number; y: number; w: number; h: number; lines: string[]; details: string[] }
type LaidGroup = { id: string; label: string; x: number; y: number; w: number; h: number; depth: number }
type Laid = {
  width: number
  height: number
  nodes: LaidNode[]
  edges: Array<FlowChart['edges'][number] & { points: Point[]; labelAt: Point | null }>
  groups: LaidGroup[]
}

function layoutOf(chart: FlowChart): Laid {
  const labelFont = svgFont(LABEL_SIZE, true)
  const detailFont = svgFont(DETAIL_SIZE)
  const graph = new Graph({ compound: true, multigraph: true })
  graph.setGraph({ rankdir: 'TB', nodesep: 28, ranksep: 40, edgesep: 16, marginx: 20, marginy: 24 })
  graph.setDefaultEdgeLabel(() => ({}))
  for (const group of chart.groups) graph.setNode(`g:${group.id}`, {})
  for (const group of chart.groups) if (group.parent) graph.setParent(`g:${group.id}`, `g:${group.parent}`)
  const nodes = chart.nodes.map((node) => {
    const lines = wrapText(node.label, TEXT_MAX, labelFont)
    const details = node.detail ? wrapText(node.detail, TEXT_MAX, detailFont) : []
    const textW = Math.max(...lines.map((line) => textWidth(line, labelFont)), ...details.map((line) => textWidth(line, detailFont)))
    const textH = lines.length * LINE + details.length * DETAIL_LINE
    // 菱形里能放字的地方只有中间一块，同样的字要大一圈
    const w = node.kind === 'decision' ? Math.max(120, textW * 1.6 + 24) : Math.max(node.kind === 'action' ? 120 : 96, textW + 28)
    const h = node.kind === 'decision' ? Math.max(64, textH * 1.8 + 16) : textH + 20
    return { ...node, lines, details, x: 0, y: 0, w: Math.ceil(w), h: Math.ceil(h) }
  })
  for (const node of nodes) {
    graph.setNode(`n:${node.id}`, { width: node.w, height: node.h })
    if (node.group) graph.setParent(`n:${node.id}`, `g:${node.group}`)
  }
  const edgeFont = svgFont(DETAIL_SIZE)
  chart.edges.forEach((edge, index) =>
    graph.setEdge(`n:${edge.from}`, `n:${edge.to}`, edge.label ? { label: edge.label, width: textWidth(edge.label, edgeFont) + 10, height: 16 } : {}, String(index)),
  )
  runDagre(graph)
  const box = graph.graph() as { width?: number; height?: number }
  const parents = new Map(chart.groups.map((group) => [group.id, group.parent]))
  const depth = (id: string) => {
    let count = 0
    for (let at = parents.get(id) ?? null; at !== null; at = parents.get(at) ?? null) count++
    return count
  }
  return {
    width: Math.ceil(box.width ?? 0),
    height: Math.ceil(box.height ?? 0),
    nodes: nodes.map((node) => {
      const point = graph.node(`n:${node.id}`) as Point
      return { ...node, x: point.x, y: point.y }
    }),
    edges: chart.edges.map((edge, index) => {
      const laid = graph.edge({ v: `n:${edge.from}`, w: `n:${edge.to}`, name: String(index) }) as { points?: Point[]; x?: number; y?: number }
      return { ...edge, points: laid.points ?? [], labelAt: edge.label && laid.x !== undefined && laid.y !== undefined ? { x: laid.x, y: laid.y } : null }
    }),
    // 外层的框先画，里层的盖在上面
    groups: chart.groups
      .map((group) => {
        const laid = graph.node(`g:${group.id}`) as { x: number; y: number; width: number; height: number }
        return { id: group.id, label: group.label, x: laid.x - laid.width / 2, y: laid.y - laid.height / 2, w: laid.width, h: laid.height, depth: depth(group.id) }
      })
      .sort((a, b) => a.depth - b.depth),
  }
}

export function FlowChartView({ name, chart, drawing, onDraw }: { name: string; chart: FlowChart | undefined; drawing: boolean; onDraw(): void }) {
  if (!chart) {
    return (
      <EmptyState
        icon={Workflow}
        title="还没有流程图"
        description="让模型读这条流程经过的代码，画出里面的判断、循环和提前结束；每个节点的代码位置都会和解析结果核对。"
      >
        <Button size="sm" disabled={drawing} onClick={onDraw}>
          {drawing ? <LoaderCircle className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
          {drawing ? '正在读代码画图…' : '让模型画流程图'}
        </Button>
      </EmptyState>
    )
  }
  return (
    <div className="space-y-3" data-testid="architecture-flowchart">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          {chart.model.modelId} · {formatTime(chart.generatedAt)} 画的
        </span>
        {chart.dropped > 0 && <span data-testid="flowchart-dropped">有 {chart.dropped} 处对不上代码，已去掉</span>}
        <Button variant="ghost" size="xs" className="ml-auto" disabled={drawing} onClick={onDraw}>
          {drawing ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          {drawing ? '正在重画…' : '重新画'}
        </Button>
      </div>
      <Chart name={name} chart={chart} />
    </div>
  )
}

function Chart({ name, chart }: { name: string; chart: FlowChart }) {
  const { peek } = useArch()
  const id = useId().replace(/:/g, '')
  const laid = useMemo(() => layoutOf(chart), [chart])
  const area = useRef<HTMLDivElement | null>(null)
  // 悬停节点时突出它自己，悬停讲解时突出它说的那几个
  const [active, setActive] = useState<ReadonlySet<string> | null>(null)
  const lit = (nodeId: string) => active === null || active.has(nodeId)
  const point = (note: { nodes: string[] }) => {
    setActive(new Set(note.nodes))
    const first = note.nodes[0]
    if (first) area.current?.querySelector(`[data-node="${CSS.escape(first)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  return (
    <div className="flex flex-col gap-4 @3xl:flex-row @3xl:items-start">
      <div ref={area} className="min-w-0 flex-1 overflow-auto rounded-lg border bg-background">
        <svg width={laid.width} height={laid.height} className="mx-auto block" role="group" aria-label={`${name}的流程图`}>
          <defs>
            {(['muted-foreground', 'foreground'] as const).map((color) => (
              <marker key={color} id={`${id}-${color}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill={`var(--${color})`} />
              </marker>
            ))}
          </defs>
          {laid.groups.map((group) => (
            <g key={group.id} data-testid="flowchart-group">
              <rect x={group.x} y={group.y} width={group.w} height={group.h} rx={12} fill="var(--muted)" fillOpacity={0.3} stroke="var(--border)" strokeDasharray="5 4" />
              <GroupTag group={group} />
            </g>
          ))}
          {laid.edges.map((edge, index) => {
            const on = active !== null && active.has(edge.from) && active.has(edge.to)
            const color = on ? 'foreground' : 'muted-foreground'
            return (
              <g key={index} opacity={active !== null && !on ? 0.3 : 1} data-testid="flowchart-edge">
                <path d={edge.points.map((at, step) => `${step === 0 ? 'M' : 'L'}${at.x},${at.y}`).join(' ')} fill="none" stroke={`var(--${color})`} strokeWidth={on ? 1.75 : 1.25} markerEnd={`url(#${id}-${color})`} />
                {edge.labelAt && (
                  <text x={edge.labelAt.x} y={edge.labelAt.y + 4} fontSize={DETAIL_SIZE} textAnchor="middle" fill="var(--muted-foreground)" paintOrder="stroke" stroke="var(--background)" strokeWidth={4} strokeLinejoin="round">
                    {edge.label}
                  </text>
                )}
              </g>
            )
          })}
          {laid.nodes.map((node) => (
            <ChartNode
              key={node.id}
              node={node}
              dim={!lit(node.id)}
              strong={active !== null && active.has(node.id)}
              onHover={(on) => setActive(on ? new Set([node.id]) : null)}
              onOpen={node.anchor ? () => peek(node.anchor!.path, node.anchor!.line) : undefined}
            />
          ))}
        </svg>
      </div>
      {chart.notes.length > 0 && (
        <ol className="space-y-1.5 @3xl:w-72 @3xl:shrink-0" aria-label="流程讲解" data-testid="flowchart-notes">
          {chart.notes.map((note, at) => (
            <li key={at}>
              <button
                type="button"
                className="flex w-full gap-2.5 rounded-lg border px-3 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent"
                onMouseEnter={() => setActive(new Set(note.nodes))}
                onMouseLeave={() => setActive(null)}
                onFocus={() => point(note)}
                onBlur={() => setActive(null)}
                onClick={() => point(note)}
              >
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold tabular-nums">{at + 1}</span>
                <span className="min-w-0 flex-1">{note.text}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function GroupTag({ group }: { group: LaidGroup }) {
  const font = svgFont(DETAIL_SIZE, true)
  const width = textWidth(group.label, font) + 16
  return (
    <g transform={`translate(${group.x + 12},${group.y - 10})`}>
      <rect width={width} height={20} rx={10} fill="var(--card)" stroke="var(--border)" />
      <text x={width / 2} y={14} fontSize={DETAIL_SIZE} fontWeight={700} textAnchor="middle" fill="var(--muted-foreground)">
        {group.label}
      </text>
    </g>
  )
}

function ChartNode({ node, dim, strong, onHover, onOpen }: { node: LaidNode; dim: boolean; strong: boolean; onHover(on: boolean): void; onOpen?: () => void }) {
  const stroke = strong ? 'var(--foreground)' : 'var(--border)'
  const fill = node.kind === 'start' || node.kind === 'end' ? 'var(--muted)' : 'var(--card)'
  const textH = node.lines.length * LINE + node.details.length * DETAIL_LINE
  const top = (node.h - textH) / 2
  const where = node.anchor ? `${node.anchor.path}:${node.anchor.line}` : null
  return (
    <g
      transform={`translate(${node.x - node.w / 2},${node.y - node.h / 2})`}
      opacity={dim ? 0.35 : 1}
      className={cn('outline-none', onOpen && 'cursor-pointer')}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      aria-label={onOpen ? `${node.label}：看代码 ${where}` : undefined}
      data-testid="flowchart-node"
      data-node={node.id}
      data-kind={node.kind}
      data-dim={dim ? '' : undefined}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
      onClick={onOpen}
      onKeyDown={
        onOpen
          ? (event: KeyboardEvent) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              onOpen()
            }
          : undefined
      }
    >
      <title>{[node.label, node.detail, where].filter(Boolean).join('\n')}</title>
      {node.kind === 'decision' ? (
        <polygon points={`${node.w / 2},0 ${node.w},${node.h / 2} ${node.w / 2},${node.h} 0,${node.h / 2}`} fill={fill} stroke={stroke} strokeWidth={strong ? 2 : 1.25} />
      ) : (
        <rect width={node.w} height={node.h} rx={node.kind === 'action' ? 8 : node.h / 2} fill={fill} stroke={stroke} strokeWidth={strong ? 2 : 1} />
      )}
      <text textAnchor="middle" fill="var(--foreground)">
        {node.lines.map((line, at) => (
          <tspan key={`l${at}`} x={node.w / 2} y={top + at * LINE + 12} fontSize={LABEL_SIZE} fontWeight={700}>
            {line}
          </tspan>
        ))}
        {node.details.map((line, at) => (
          <tspan key={`d${at}`} x={node.w / 2} y={top + node.lines.length * LINE + at * DETAIL_LINE + 11} fontSize={DETAIL_SIZE} fill="var(--muted-foreground)">
            {line}
          </tspan>
        ))}
      </text>
    </g>
  )
}
