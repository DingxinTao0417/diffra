import { type ReactNode, useContext, useState } from 'react'
import type { CompareData, KeyValueData, MetricsData, StepsData, TimelineData } from '@diffra/core/rich'
import { ArrowDownRight, ArrowRight, ArrowUpRight, Check, ChevronDown, ChevronRight, Copy, ListChecks, Minus, Plus, SquareTerminal, TableProperties, X } from 'lucide-react'
import { cn } from 'cn'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { fillComposer } from '@/state/actions'
import { AnswerContext } from '../answer-links'
import { BlockShell, copyText, ShellAction } from './BlockShell'

// 第 651 步：结构化富块里不画坐标轴的几种——指标卡、键值表、步骤、时间线、方案对比。
// 颜色只用令牌：变差的指标用 warning，失败的步骤用 destructive；「推荐」「完成」都不用成功色（那是模型的说法，不是验证结果）

// 能填进输入框的块：只有本机任务有（远程、只读会话没有 AnswerContext）
function useFill(): ((text: string) => void) | null {
  const target = useContext(AnswerContext)
  return target ? (text: string) => fillComposer(target.sessionId, text) : null
}

// ---- 指标卡 ----

export function MetricsBlock({ data }: { data: MetricsData }) {
  return (
    <figure className="flex flex-col gap-1.5" data-testid="rich-metrics" data-kind="metrics">
      {data.title && <figcaption className="text-xs text-muted-foreground">{data.title}</figcaption>}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2">
        {data.items.map((item, index) => (
          <div key={index} className="flex min-w-0 flex-col gap-0.5 rounded-lg border px-3 py-2" data-testid="metric">
            <span className="truncate text-xs text-muted-foreground" title={item.label}>
              {item.label}
            </span>
            <span className="flex items-baseline gap-1 truncate">
              <span className="text-xl font-bold tabular-nums">{item.value}</span>
              {item.unit && <span className="text-xs text-muted-foreground">{item.unit}</span>}
            </span>
            {item.delta !== undefined && <MetricDelta delta={item.delta} trend={item.trend} better={item.better} />}
            {item.note && <span className="text-xs text-muted-foreground">{item.note}</span>}
          </div>
        ))}
      </div>
    </figure>
  )
}

function MetricDelta({ delta, trend, better }: { delta: number | string; trend?: 'up' | 'down' | 'flat'; better?: 'up' | 'down' }) {
  const Icon = trend === 'up' ? ArrowUpRight : trend === 'down' ? ArrowDownRight : ArrowRight
  const worse = better !== undefined && trend !== undefined && trend !== 'flat' && trend !== better
  const text = typeof delta === 'number' ? `${delta > 0 ? '+' : ''}${delta}` : delta
  return (
    <span className={cn('flex items-center gap-0.5 text-xs tabular-nums', worse ? 'text-warning' : 'text-muted-foreground')} data-trend={trend} data-worse={worse || undefined}>
      <Icon className="size-3.5" aria-hidden="true" />
      {text}
      {worse && <span className="sr-only">（变差）</span>}
    </span>
  )
}

// ---- 键值表 ----

const looksMono = (value: string) => /^[\w./\\:@~-]+$/.test(value) && /[./\\:_-]|\d/.test(value)

export function KeyValueBlock({ data }: { data: KeyValueData }) {
  const lines = data.items.map((item) => `${item.key}: ${item.value ?? ''}`).join('\n')
  return (
    <BlockShell
      testId="rich-keyvalue"
      kind="keyvalue"
      tone="card"
      icon={<TableProperties className="size-3.5 shrink-0" />}
      title={data.title ?? '参数'}
      actions={
        <ShellAction label="复制全部" onClick={() => copyText(lines, '已复制')}>
          <Copy />
        </ShellAction>
      }
    >
      <dl className="grid grid-cols-[minmax(5rem,max-content)_minmax(0,1fr)] gap-x-4 gap-y-1 px-3 py-2 text-sm">
        {data.items.map((item, index) => {
          const value = item.value === null ? '—' : String(item.value)
          return (
            <div key={index} className="contents">
              <dt className="truncate text-muted-foreground" title={item.key}>
                {item.key}
              </dt>
              <dd className={cn('min-w-0 break-words', (item.mono ?? looksMono(value)) && 'font-mono text-xs leading-6')}>{value}</dd>
            </div>
          )
        })}
      </dl>
    </BlockShell>
  )
}

// ---- 步骤 ----

type StepStatus = StepsData['items'][number]['status']

// 勾选只记在界面上（帮用户自己对着做），不回写回答；当前步骤是第一个没勾的
export function StepsBlock({ data }: { data: StepsData }) {
  const [done, setDone] = useState<Set<number>>(() => new Set(data.items.flatMap((item, index) => (item.status === 'done' ? [index] : []))))
  const fill = useFill()
  const explicitActive = data.items.findIndex((item) => item.status === 'active')
  const current = explicitActive >= 0 && !done.has(explicitActive) ? explicitActive : data.items.findIndex((item, index) => !done.has(index) && item.status !== 'skipped' && item.status !== 'failed')
  const toggle = (index: number) =>
    setDone((previous) => {
      const next = new Set(previous)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  return (
    <BlockShell testId="rich-steps" kind="steps" tone="card" icon={<ListChecks className="size-3.5 shrink-0" />} title={data.title ?? '步骤'} meta={<span className="shrink-0 tabular-nums">· 完成 {done.size}/{data.items.length}</span>}>
      <ol className="flex flex-col gap-0.5 p-1.5">
        {data.items.map((item, index) => {
          const checked = done.has(index)
          return (
            <li key={index} className={cn('flex gap-2.5 rounded-md px-2 py-1.5', index === current && 'bg-soft')} data-testid="rich-step" data-status={checked ? 'done' : item.status} aria-current={index === current ? 'step' : undefined}>
              {item.status === 'failed' || item.status === 'skipped' ? (
                <StepMark status={item.status} />
              ) : (
                <Checkbox className="mt-0.5" checked={checked} onCheckedChange={() => toggle(index)} aria-label={`第 ${index + 1} 步：${item.title}`} />
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className={cn('text-sm', checked && 'text-muted-foreground line-through')}>
                  <span className="mr-1.5 text-muted-foreground tabular-nums">{index + 1}.</span>
                  {item.title}
                </span>
                {item.detail && <span className="text-xs text-muted-foreground">{item.detail}</span>}
                {item.command && <StepCommand command={item.command} fill={fill} />}
              </div>
            </li>
          )
        })}
      </ol>
    </BlockShell>
  )
}

function StepMark({ status }: { status: StepStatus }) {
  if (status === 'failed') return <X className="mt-0.5 size-4 shrink-0 text-destructive" strokeWidth={2.6} aria-label="失败" />
  return <Minus className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="跳过" />
}

function StepCommand({ command, fill }: { command: string; fill: ((text: string) => void) | null }) {
  return (
    <span className="mt-0.5 flex min-w-0 items-center gap-1">
      <code className="min-w-0 truncate rounded-sm bg-muted px-1.5 py-px font-mono text-xs" title={command}>
        {command}
      </code>
      <ShellAction label="复制命令" onClick={() => copyText(command, '已复制命令')}>
        <Copy />
      </ShellAction>
      {fill && (
        <ShellAction label="让智能体执行" onClick={() => fill(`执行这条命令：\n${command}`)}>
          <SquareTerminal />
        </ShellAction>
      )}
    </span>
  )
}

// ---- 时间线 ----

const DOT: Record<NonNullable<TimelineData['items'][number]['status']>, string> = {
  done: 'border-muted-foreground bg-muted-foreground',
  active: 'border-foreground bg-background ring-2 ring-foreground/20',
  pending: 'border-muted-foreground/60 bg-background',
  failed: 'border-destructive bg-destructive',
  skipped: 'border-muted-foreground/60 bg-muted',
}

// 详情超过这么多字先收起
const DETAIL_PREVIEW = 120

export function TimelineBlock({ data }: { data: TimelineData }) {
  return (
    <figure className="flex flex-col gap-1.5" data-testid="rich-timeline" data-kind="timeline">
      {data.title && <figcaption className="text-xs text-muted-foreground">{data.title}</figcaption>}
      <ol className="relative flex flex-col gap-3 border-l pl-4 ml-1.5">
        {data.items.map((item, index) => (
          <TimelineItem key={index} item={item} />
        ))}
      </ol>
    </figure>
  )
}

function TimelineItem({ item }: { item: TimelineData['items'][number] }) {
  const long = (item.detail?.length ?? 0) > DETAIL_PREVIEW
  const [open, setOpen] = useState(false)
  return (
    <li className="relative flex flex-col gap-0.5" data-testid="rich-timeline-item" data-status={item.status}>
      <span className={cn('absolute top-1.5 -left-[calc(1rem+5px)] size-2.5 rounded-full border-2', DOT[item.status ?? 'done'])} aria-hidden="true" />
      <span className="flex flex-wrap items-baseline gap-x-2">
        {item.time && <span className="text-xs text-muted-foreground tabular-nums">{item.time}</span>}
        <span className={cn('text-sm font-bold', item.status === 'failed' && 'text-destructive', item.status === 'pending' && 'font-normal text-muted-foreground')}>{item.title}</span>
      </span>
      {item.detail &&
        (long ? (
          <>
            <span className="text-sm text-muted-foreground">{open ? item.detail : `${item.detail.slice(0, DETAIL_PREVIEW)}…`}</span>
            <button type="button" aria-expanded={open} className="flex w-fit items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen(!open)}>
              {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              {open ? '收起' : '展开详情'}
            </button>
          </>
        ) : (
          <span className="text-sm text-muted-foreground">{item.detail}</span>
        ))}
    </li>
  )
}

// ---- 方案对比 ----

export function CompareBlock({ data }: { data: CompareData }) {
  const fill = useFill()
  const criteria = data.criteria ?? [...new Set(data.options.flatMap((option) => Object.keys(option.scores ?? {})))]
  return (
    <figure className="flex flex-col gap-1.5" data-testid="rich-compare" data-kind="compare">
      {data.title && <figcaption className="text-xs text-muted-foreground">{data.title}</figcaption>}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-2">
        {data.options.map((option, index) => (
          <section key={index} className={cn('flex min-w-0 flex-col gap-2 rounded-lg border px-3 py-2.5', option.recommended && 'border-foreground/40')} data-testid="rich-compare-option" data-recommended={option.recommended || undefined} aria-label={option.recommended ? `${option.name}（推荐）` : option.name}>
            <header className="flex items-center gap-2">
              <span className="min-w-0 truncate font-bold">{option.name}</span>
              {option.recommended && <Badge variant="outline">推荐</Badge>}
            </header>
            {option.summary && <p className="text-sm text-muted-foreground">{option.summary}</p>}
            {criteria.length > 0 && option.scores && (
              <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-sm">
                {criteria.map((criterion) => (
                  <div key={criterion} className="contents">
                    <dt className="text-muted-foreground">{criterion}</dt>
                    <dd className="min-w-0 break-words tabular-nums">{option.scores?.[criterion] ?? '—'}</dd>
                  </div>
                ))}
              </dl>
            )}
            <PointList items={option.pros} icon={<Plus className="mt-1 size-3 shrink-0 text-muted-foreground" aria-label="优点" />} />
            <PointList items={option.cons} icon={<Minus className="mt-1 size-3 shrink-0 text-warning" aria-label="缺点" />} />
            {fill && (
              <Button variant="outline" size="sm" className="mt-auto self-start" onClick={() => fill(`选「${option.name}」`)}>
                <Check />
                选这个
              </Button>
            )}
          </section>
        ))}
      </div>
    </figure>
  )
}

function PointList({ items, icon }: { items?: string[]; icon: ReactNode }) {
  if (!items || items.length === 0) return null
  return (
    <ul className="flex flex-col gap-0.5 text-sm">
      {items.map((item, index) => (
        <li key={index} className="flex gap-1.5">
          {icon}
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ul>
  )
}
