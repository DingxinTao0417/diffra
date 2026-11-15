import { useContext, useMemo, useState } from 'react'
import { Flame, Gauge } from 'lucide-react'
import { cn } from 'cn'
import { formatBytes } from '@/lib/format'
import { AnswerContext, openFilePreview, useProjectFile } from '../answer-links'

// 第 665 步：性能分析的输出——Lighthouse 的 JSON 报告（分数、关键指标、请求瀑布图）和 Chrome 的 CPU profile（火焰图）。
// 只认结构，认不出就照原样显示

export interface LighthouseReport {
  url: string | null
  categories: Array<{ id: string; title: string; score: number | null }>
  metrics: Array<{ title: string; value: string; score: number | null }>
  requests: Array<{ url: string; start: number; end: number; size: number | null; type: string | null; status: number | null }>
}

interface ProfileNode {
  id: number
  name: string
  url: string
  line: number
  self: number
  total: number
  children: ProfileNode[]
}

export type PerfData = { kind: 'lighthouse'; report: LighthouseReport } | { kind: 'profile'; root: ProfileNode; duration: number }

const METRICS = ['first-contentful-paint', 'largest-contentful-paint', 'total-blocking-time', 'cumulative-layout-shift', 'speed-index', 'interactive']
const MAX_REQUESTS = 60
const MAX_DEPTH = 40

type Json = Record<string, unknown>
const object = (value: unknown): Json | null => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null)
const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

export function parsePerf(text: string): PerfData | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || trimmed.length > 30_000_000) return null
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return null
  }
  const root = object(value)
  if (!root) return null
  if (typeof root.lighthouseVersion === 'string' && object(root.categories)) return { kind: 'lighthouse', report: lighthouse(root) }
  if (Array.isArray(root.nodes) && Array.isArray(root.samples)) return profile(root)
  return null
}

function lighthouse(root: Json): LighthouseReport {
  const audits = object(root.audits) ?? {}
  const categories = Object.entries(object(root.categories) ?? {}).map(([id, raw]) => {
    const category = object(raw) ?? {}
    return { id, title: String(category.title ?? id), score: number(category.score) }
  })
  const metrics = METRICS.flatMap((id) => {
    const audit = object(audits[id])
    return audit && typeof audit.displayValue === 'string' ? [{ title: String(audit.title ?? id), value: audit.displayValue, score: number(audit.score) }] : []
  })
  const items = object(object(audits['network-requests'])?.details)?.items
  const requests = (Array.isArray(items) ? items : []).flatMap((raw) => {
    const item = object(raw)
    const start = number(item?.networkRequestTime ?? item?.startTime)
    const end = number(item?.networkEndTime ?? item?.endTime)
    return item && typeof item.url === 'string' && start !== null && end !== null
      ? [{ url: item.url, start, end, size: number(item.transferSize), type: typeof item.resourceType === 'string' ? item.resourceType : null, status: number(item.statusCode) }]
      : []
  })
  return { url: typeof root.finalDisplayedUrl === 'string' ? root.finalDisplayedUrl : typeof root.finalUrl === 'string' ? root.finalUrl : null, categories, metrics, requests }
}

// CPU profile：每个采样落在哪个节点、隔了多久（timeDeltas，微秒），累加成自身时间，再往上累成总时间
function profile(root: Json): PerfData | null {
  const raw = (root.nodes as unknown[]).map(object).filter((node): node is Json => node !== null)
  const byId = new Map<number, ProfileNode & { childIds: number[] }>()
  for (const node of raw) {
    const id = number(node.id)
    const frame = object(node.callFrame) ?? {}
    if (id === null) continue
    byId.set(id, {
      id,
      name: String(frame.functionName || '(匿名函数)'),
      url: String(frame.url ?? ''),
      line: (number(frame.lineNumber) ?? -1) + 1,
      self: 0,
      total: 0,
      children: [],
      childIds: Array.isArray(node.children) ? (node.children as unknown[]).flatMap((child) => (typeof child === 'number' ? [child] : [])) : [],
    })
  }
  const samples = root.samples as unknown[]
  const deltas = Array.isArray(root.timeDeltas) ? (root.timeDeltas as unknown[]) : []
  samples.forEach((sample, index) => {
    const node = typeof sample === 'number' ? byId.get(sample) : undefined
    if (node) node.self += (number(deltas[index + 1]) ?? number(deltas[index]) ?? 0) / 1000
  })
  for (const node of byId.values()) node.children = node.childIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
  const childIds = new Set([...byId.values()].flatMap((node) => node.childIds))
  const top = [...byId.values()].find((node) => !childIds.has(node.id))
  if (!top) return null
  const sum = (node: ProfileNode, depth: number): number => {
    node.total = node.self + (depth < MAX_DEPTH * 4 ? node.children.reduce((total, child) => total + sum(child, depth + 1), 0) : 0)
    return node.total
  }
  sum(top, 0)
  return top.total > 0 ? { kind: 'profile', root: top, duration: top.total } : null
}

// ---- Lighthouse ----

function scoreTone(score: number | null): string {
  if (score === null) return 'text-muted-foreground'
  if (score >= 0.9) return 'text-foreground'
  return score >= 0.5 ? 'text-warning' : 'text-destructive'
}

export function LighthouseView({ report }: { report: LighthouseReport }) {
  return (
    <div className="flex flex-col gap-2 bg-background px-2.5 py-2 text-xs" data-testid="lighthouse">
      <p className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        <Gauge className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">Lighthouse{report.url ? ` · ${report.url}` : ''}</span>
      </p>
      <div className="flex flex-wrap gap-2">
        {report.categories.map((category) => (
          <div key={category.id} className="flex min-w-24 flex-col items-center rounded-lg border px-3 py-1.5" data-testid="lighthouse-score">
            <span className={cn('text-xl font-semibold tabular-nums', scoreTone(category.score))}>{category.score === null ? '—' : Math.round(category.score * 100)}</span>
            <span className="text-muted-foreground">{category.title}</span>
          </div>
        ))}
      </div>
      {report.metrics.length > 0 && (
        <dl className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-x-4 gap-y-0.5">
          {report.metrics.map((metric) => (
            <div key={metric.title} className="flex justify-between gap-2">
              <dt className="truncate text-muted-foreground">{metric.title}</dt>
              <dd className={cn('shrink-0 tabular-nums', scoreTone(metric.score))}>{metric.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {report.requests.length > 0 && <Waterfall requests={report.requests} />}
    </div>
  )
}

// 请求瀑布图：横轴是时间，每条请求一行；超过 1 秒的标出来
function Waterfall({ requests }: { requests: LighthouseReport['requests'] }) {
  const [all, setAll] = useState(false)
  const sorted = useMemo(() => [...requests].sort((a, b) => a.start - b.start), [requests])
  const start = sorted[0]?.start ?? 0
  const span = Math.max(1, Math.max(...sorted.map((request) => request.end)) - start)
  const shown = all ? sorted : sorted.slice(0, MAX_REQUESTS)
  return (
    <div className="flex flex-col gap-px" data-testid="waterfall">
      <p className="text-muted-foreground tabular-nums">
        请求 {requests.length} 个 · 共 {Math.round(span)} ms
      </p>
      {shown.map((request, index) => {
        const duration = request.end - request.start
        const name = request.url.replace(/^https?:\/\/[^/]+/, '') || request.url
        return (
          <div key={index} className="grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)_4rem] items-center gap-2" title={`${request.url}\n${Math.round(duration)} ms${request.size !== null ? ` · ${formatBytes(request.size)}` : ''}`} data-testid="waterfall-row">
            <span className={cn('truncate font-mono', request.status !== null && request.status >= 400 && 'text-destructive')}>{name}</span>
            <span className="relative h-2.5 rounded-xs bg-muted">
              <span className={cn('absolute inset-y-0 rounded-xs', duration > 1000 ? 'bg-warning' : 'bg-chart-2')} style={{ left: `${((request.start - start) / span) * 100}%`, width: `${Math.max(0.5, (duration / span) * 100)}%` }} />
            </span>
            <span className={cn('text-right tabular-nums', duration > 1000 ? 'text-warning' : 'text-muted-foreground')}>{Math.round(duration)} ms</span>
          </div>
        )
      })}
      {sorted.length > shown.length && (
        <button type="button" className="self-start text-muted-foreground hover:text-foreground" onClick={() => setAll(true)}>
          显示全部 {sorted.length} 个
        </button>
      )}
    </div>
  )
}

// ---- 火焰图 ----

// 自上而下的冰柱图：每层一行，宽度按总时间；太窄的不画。点一帧：是项目里的文件就在文件面板打开到那一行
export function FlameGraph({ root, duration }: { root: ProfileNode; duration: number }) {
  const [focus, setFocus] = useState<ProfileNode>(root)
  const rows = useMemo(() => {
    const result: Array<Array<{ node: ProfileNode; left: number; width: number }>> = []
    const walk = (node: ProfileNode, left: number, depth: number) => {
      const width = node.total / focus.total
      if (width < 0.003 || depth >= MAX_DEPTH) return
      ;(result[depth] ??= []).push({ node, left, width })
      let offset = left
      for (const child of node.children) {
        walk(child, offset, depth + 1)
        offset += child.total / focus.total
      }
    }
    walk(focus, 0, 0)
    return result
  }, [focus])
  const hottest = useMemo(() => {
    const all: ProfileNode[] = []
    const collect = (node: ProfileNode) => {
      all.push(node)
      node.children.forEach(collect)
    }
    collect(root)
    return all.filter((node) => node.self > 0 && !/^\((?:idle|program|garbage collector)\)$/.test(node.name)).sort((a, b) => b.self - a.self).slice(0, 5)
  }, [root])
  return (
    <div className="flex flex-col gap-1.5 bg-background px-2.5 py-2 text-xs" data-testid="flame-graph">
      <p className="flex items-center gap-1.5 text-muted-foreground">
        <Flame className="size-3.5 shrink-0" aria-hidden="true" />
        CPU 采样共 {Math.round(duration)} ms
        {focus !== root && (
          <button type="button" className="ml-auto hover:text-foreground" onClick={() => setFocus(root)}>
            回到整体
          </button>
        )}
      </p>
      <div className="flex flex-col gap-px overflow-hidden" role="img" aria-label="CPU 火焰图，越宽越耗时">
        {rows.map((row, depth) => (
          <div key={depth} className="relative h-4">
            {row.map(({ node, left, width }) => (
              <button
                key={node.id}
                type="button"
                className="absolute inset-y-0 overflow-hidden rounded-xs border-r border-background bg-chart-3/40 px-1 text-left leading-4 whitespace-nowrap hover:bg-chart-3/70"
                style={{ left: `${left * 100}%`, width: `${width * 100}%` }}
                title={`${node.name}${node.url ? `\n${node.url}:${node.line}` : ''}\n总计 ${Math.round(node.total)} ms · 自身 ${Math.round(node.self)} ms`}
                onClick={() => setFocus(node === focus ? root : node)}
                data-testid="flame-frame"
              >
                {node.name}
              </button>
            ))}
          </div>
        ))}
      </div>
      {hottest.length > 0 && (
        <div className="flex flex-col gap-0.5" data-testid="flame-hottest">
          <p className="text-muted-foreground">自身耗时最多</p>
          {hottest.map((node) => (
            <HotFrame key={node.id} node={node} />
          ))}
        </div>
      )}
    </div>
  )
}

function HotFrame({ node }: { node: ProfileNode }) {
  const target = useContext(AnswerContext)
  const path = node.url ? decodeURIComponent(node.url.replace(/^file:\/\/\/?/, '')) : null
  const file = useProjectFile(path)
  return (
    <p className="flex min-w-0 items-baseline gap-2">
      <span className="w-14 shrink-0 text-right tabular-nums">{Math.round(node.self)} ms</span>
      <span className="shrink-0 font-mono">{node.name}</span>
      {file && target ? (
        // primary-color-allow: 能点开的源码位置，和回答里的文件引用同色
        <button type="button" className="min-w-0 truncate font-mono text-primary hover:underline" onClick={() => openFilePreview(target.project, file.relative, node.line)} data-testid="flame-source">
          {file.relative}:{node.line}
        </button>
      ) : (
        node.url && <span className="min-w-0 truncate font-mono text-muted-foreground">{node.url.replace(/^.*\//, '')}:{node.line}</span>
      )}
    </p>
  )
}
