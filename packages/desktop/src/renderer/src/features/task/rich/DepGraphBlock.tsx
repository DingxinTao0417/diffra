import { type KeyboardEvent, useContext, useId, useMemo, useState } from 'react'
import { Graph, layout as runDagre } from '@dagrejs/dagre'
import type { DepGraphData } from '@diffra/core/rich'
import { Network } from 'lucide-react'
import { cn } from 'cn'
import { errorMessage } from '@/lib/errors'
import { showToast } from '@/state/store'
import { AnswerContext, findProjectFile, openFilePreview } from '../answer-links'
import { BlockShell } from './BlockShell'

// 回答里的架构图（第 690 步）：dagre 排版、画成 SVG（导出的静态页里照样是图）。悬停或聚焦一个节点，和它相连的边、节点突出；
// 写了项目路径的节点点了在文件面板里打开（只有本机任务）。颜色只用令牌：节点 card、边 muted-foreground，突出的用 foreground

const NODE_MIN = 72
const NODE_MAX = 220
const PADDING = 24
// 窄窗口里图最多缩到这么多，再窄就横向滚动，字还看得清
const MIN_SCALE = 0.6

// 估算文字宽度：中日韩字符按字号算，其他按 0.6 个字号
function textWidth(text: string, size: number): number {
  let width = 0
  for (const char of text) width += char.codePointAt(0)! > 0x2e80 ? size : size * 0.6
  return width
}

function clip(text: string, size: number, max: number): string {
  if (textWidth(text, size) <= max) return text
  let result = ''
  for (const char of text) {
    if (textWidth(`${result}${char}…`, size) > max) break
    result += char
  }
  return `${result}…`
}

// 路径只显示最后两段
const shortPath = (path: string) => path.split(/[\\/]/).slice(-2).join('/')

type Laid = {
  width: number
  height: number
  nodes: Array<DepGraphData['nodes'][number] & { x: number; y: number; w: number; h: number }>
  edges: Array<DepGraphData['edges'][number] & { points: Array<{ x: number; y: number }>; labelAt: { x: number; y: number } | null }>
}

function layoutOf(data: DepGraphData): Laid {
  const graph = new Graph({ multigraph: true })
  graph.setGraph({ rankdir: data.direction, nodesep: 24, ranksep: 56, edgesep: 12, marginx: 12, marginy: 12 })
  graph.setDefaultEdgeLabel(() => ({}))
  const sizes = data.nodes.map((node) => ({
    w: Math.min(NODE_MAX, Math.max(NODE_MIN, Math.max(textWidth(node.label, 12), node.path ? textWidth(shortPath(node.path), 10) : 0) + PADDING)),
    h: node.path ? 44 : 32,
  }))
  data.nodes.forEach((node, index) => graph.setNode(node.id, { width: sizes[index]!.w, height: sizes[index]!.h }))
  data.edges.forEach((edge, index) => graph.setEdge(edge.from, edge.to, edge.label ? { label: edge.label, width: textWidth(edge.label, 11) + 8, height: 16 } : {}, String(index)))
  runDagre(graph)
  const box = graph.graph() as { width?: number; height?: number }
  return {
    width: Math.ceil(box.width ?? 0),
    height: Math.ceil(box.height ?? 0),
    nodes: data.nodes.map((node, index) => {
      const point = graph.node(node.id) as { x: number; y: number }
      return { ...node, x: point.x, y: point.y, ...sizes[index]! }
    }),
    edges: data.edges.map((edge, index) => {
      const laid = graph.edge({ v: edge.from, w: edge.to, name: String(index) }) as { points?: Array<{ x: number; y: number }>; x?: number; y?: number }
      return { ...edge, points: laid.points ?? [], labelAt: edge.label && laid.x !== undefined && laid.y !== undefined ? { x: laid.x, y: laid.y } : null }
    }),
  }
}

export default function DepGraphBlock({ data }: { data: DepGraphData }) {
  const laid = useMemo(() => layoutOf(data), [data])
  const notes = data.nodes.filter((node) => node.note)
  return (
    <BlockShell
      testId="rich-depgraph"
      kind="depgraph"
      tone="card"
      icon={<Network className="size-3.5 shrink-0" />}
      title={data.title ?? '架构图'}
      meta={<span className="shrink-0 tabular-nums">{data.nodes.length} 个节点</span>}
      expand={() => <GraphSvg data={data} laid={laid} fit={false} />}
    >
      <div className="overflow-x-auto p-2">
        <GraphSvg data={data} laid={laid} fit />
      </div>
      {notes.length > 0 && (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 border-t px-3 py-2 text-sm" data-testid="depgraph-notes">
          {notes.map((node) => (
            <div key={node.id} className="contents">
              <dt className="font-bold">{node.label}</dt>
              <dd className="min-w-0 break-words text-muted-foreground">{node.note}</dd>
            </div>
          ))}
        </dl>
      )}
    </BlockShell>
  )
}

function GraphSvg({ data, laid, fit }: { data: DepGraphData; laid: Laid; fit: boolean }) {
  const target = useContext(AnswerContext)
  const id = useId().replace(/:/g, '')
  const [active, setActive] = useState<string | null>(null)
  const highlighted = active ?? data.focus ?? null
  const neighbors = useMemo(() => {
    if (!highlighted) return null
    const set = new Set([highlighted])
    for (const edge of data.edges) {
      if (edge.from === highlighted) set.add(edge.to)
      if (edge.to === highlighted) set.add(edge.from)
    }
    return set
  }, [highlighted, data.edges])
  const open = async (path: string) => {
    if (!target) return
    const [, file, line] = /^(.*?)(?::(\d+))?$/.exec(path)!
    try {
      const found = await findProjectFile(target, file!)
      if (!found) return showToast(`项目里没有 ${file}`)
      openFilePreview(target.project, found.relative, line ? Number(line) : null)
    } catch (error) {
      showToast(errorMessage(error))
    }
  }
  return (
    <svg
      viewBox={`0 0 ${laid.width} ${laid.height}`}
      width={laid.width}
      height={laid.height}
      className="mx-auto block h-auto"
      style={fit ? { maxWidth: '100%', minWidth: Math.min(laid.width, laid.width * MIN_SCALE) } : undefined}
      role="group"
      aria-label={`${data.title ?? '架构图'}：${data.edges.map((edge) => `${labelOf(data, edge.from)} → ${labelOf(data, edge.to)}`).join('，') || data.nodes.map((node) => node.label).join('、')}`}
      data-testid="depgraph-svg"
    >
      <defs>
        {(['muted-foreground', 'foreground'] as const).map((color) => (
          <marker key={color} id={`${id}-${color}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={`var(--${color})`} />
          </marker>
        ))}
      </defs>
      {laid.edges.map((edge, index) => {
        const lit = highlighted !== null && (edge.from === highlighted || edge.to === highlighted)
        const dim = highlighted !== null && !lit
        const color = lit ? 'foreground' : 'muted-foreground'
        return (
          <g key={index} opacity={dim ? 0.25 : 1} data-testid="depgraph-edge" data-lit={lit ? '' : undefined}>
            <path d={edge.points.map((point, at) => `${at === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' ')} fill="none" stroke={`var(--${color})`} strokeWidth={lit ? 1.75 : 1.25} markerEnd={`url(#${id}-${color})`} />
            {edge.labelAt && (
              <text x={edge.labelAt.x} y={edge.labelAt.y + 4} fontSize={11} textAnchor="middle" fill="var(--muted-foreground)" paintOrder="stroke" stroke="var(--card)" strokeWidth={4} strokeLinejoin="round">
                {edge.label}
              </text>
            )}
          </g>
        )
      })}
      {laid.nodes.map((node) => {
        const clickable = Boolean(target && node.path)
        const lit = node.id === highlighted
        const dim = neighbors !== null && !neighbors.has(node.id)
        const activate = () => node.path && void open(node.path)
        return (
          <g
            key={node.id}
            transform={`translate(${node.x - node.w / 2},${node.y - node.h / 2})`}
            opacity={dim ? 0.45 : 1}
            className={cn('outline-none', clickable && 'cursor-pointer')}
            role={clickable ? 'button' : undefined}
            tabIndex={clickable ? 0 : undefined}
            aria-label={clickable ? `打开 ${node.path}` : undefined}
            data-testid="depgraph-node"
            data-id={node.id}
            data-lit={lit ? '' : undefined}
            onMouseEnter={() => setActive(node.id)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(node.id)}
            onBlur={() => setActive(null)}
            onClick={clickable ? activate : undefined}
            onKeyDown={
              clickable
                ? (event: KeyboardEvent) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    activate()
                  }
                : undefined
            }
          >
            <title>{[node.label, node.path, node.note].filter(Boolean).join('\n')}</title>
            <rect width={node.w} height={node.h} rx={node.kind === 'database' ? 12 : 6} fill="var(--card)" stroke={lit ? 'var(--foreground)' : 'var(--border)'} strokeWidth={lit ? 2 : 1} strokeDasharray={node.kind === 'external' ? '4 3' : undefined} />
            {node.kind === 'service' && <rect x={3} y={3} width={node.w - 6} height={node.h - 6} rx={4} fill="none" stroke="var(--border)" />}
            {node.kind === 'database' && <path d={`M1,9 Q${node.w / 2},17 ${node.w - 1},9`} fill="none" stroke="var(--border)" />}
            <text x={node.w / 2} y={node.path ? 18 : node.h / 2 + 4} fontSize={12} fontWeight={700} textAnchor="middle" fill="var(--foreground)">
              {clip(node.label, 12, node.w - 12)}
            </text>
            {node.path && (
              <text x={node.w / 2} y={33} fontSize={10} textAnchor="middle" fill="var(--muted-foreground)" textDecoration={clickable ? 'underline' : undefined}>
                {clip(shortPath(node.path), 10, node.w - 12)}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

const labelOf = (data: DepGraphData, id: string) => data.nodes.find((node) => node.id === id)?.label ?? id
