import { useEffect, useMemo, useState } from 'react'
import { ARCHITECTURE_USAGE_ID, PROMPT_ENHANCE_USAGE_ID, type UsageSummary, type UsageTotals } from '@diffra/core/types'
import { Activity, BarChart3, Clock3, Coins, Download, Plus, Trash2, Zap } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Segmented } from '@/components/ui/segmented'
import { errorMessage } from '@/lib/errors'
import { folderName, formatTokens } from '@/lib/format'
import { openHome, openTask } from '@/state/actions'
import { showToast, useAppState } from '@/state/store'
import { budgetRatio, formatMoney, monthRange } from '@/state/usage-budget'
import { DEFAULT_USAGE, type UsageSettings } from '../../../../shared/settings'
import { UsageCleanupDialog, UsagePricesDialog } from './UsageCostDialogs'
import { SettingsGroup, SettingsHeader } from './SettingsLayout'

export type Range = 'today' | 'week' | 'month30' | 'thisMonth'

const RANGES: Array<{ value: Range; label: string }> = [
  { value: 'today', label: '今天' },
  { value: 'week', label: '近 7 天' },
  { value: 'month30', label: '近 30 天' },
  { value: 'thisMonth', label: '本月' },
]

// 按本机时区算起点；终点是现在。core 按同一个时区划分每天（侧栏的用量面板也用）
export function rangeOf(range: Range, now: Date): { from: Date; to: Date } {
  const year = now.getFullYear()
  const month = now.getMonth()
  const day = now.getDate()
  const start =
    range === 'today'
      ? new Date(year, month, day)
      : range === 'week'
        ? new Date(year, month, day - 6)
        : range === 'month30'
          ? new Date(year, month, day - 29)
          : new Date(year, month, 1)
  return { from: start, to: new Date(now.getTime() + 1000) }
}

const HEATMAP_DAYS = 56
const USAGE_CARD = 'rounded-xl border bg-card p-4'
const USAGE_CARD_TITLE = 'flex items-center gap-2 text-sm font-bold'

const total = (totals: UsageTotals) => totals.input + totals.output
const exact = (value: number) => value.toLocaleString('zh-CN')
// 卡片宽度放得下 10 万以内的精确值，再大才缩写
const compact = (value: number) => (value < 100_000 ? exact(value) : formatTokens(value))
const rateOf = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : null)
const percent = (part: number, whole: number) => {
  const rate = rateOf(part, whole)
  return rate === null ? '—' : `${rate}%`
}
const pad = (value: number) => String(value).padStart(2, '0')
const dayStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate())

// 热力图从 8 周前的周一开始，到今天为止；按周排成列，周一到周日是行
function heatmapRange(now: Date): { from: Date; to: Date } {
  const today = dayStart(now)
  const start = new Date(today)
  start.setDate(start.getDate() - (HEATMAP_DAYS - 1))
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
  const to = new Date(today)
  to.setDate(to.getDate() + 1)
  return { from: start, to }
}

export function UsageSection() {
  const tasks = useAppState((state) => state.tasks)
  const usage = useAppState((state) => state.settings?.usage ?? DEFAULT_USAGE)
  const [range, setRange] = useState<Range>('week')
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [heatmap, setHeatmap] = useState<UsageSummary['days'] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // v2：单价和预算、清理旧记录的对话框；改了单价、清理之后重新统计
  const [dialog, setDialog] = useState<'prices' | 'cleanup' | null>(null)
  const [version, setVersion] = useState(0)
  const [monthCost, setMonthCost] = useState<string | undefined>(undefined)

  useEffect(() => {
    let stale = false
    const { from, to } = rangeOf(range, new Date())
    setError(null)
    window.diffra
      .usageSummary({ from: from.toISOString(), to: to.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
      .then(
        (result) => !stale && setSummary(result),
        (caught: unknown) => !stale && setError(errorMessage(caught)),
      )
    return () => {
      stale = true
    }
  }, [range, version])

  // 设了预算时看本月花了多少（不管上面选的统计范围）
  useEffect(() => {
    if (!usage.monthlyBudget || usage.prices.length === 0) {
      setMonthCost(undefined)
      return
    }
    let stale = false
    const { from, to } = monthRange(new Date())
    window.diffra
      .usageSummary({ from: from.toISOString(), to: to.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
      .then(
        (result) => !stale && setMonthCost(result.totals.cost),
        (caught: unknown) => console.error('读取本月用量失败', caught),
      )
    return () => {
      stale = true
    }
  }, [usage.monthlyBudget, usage.prices, version])

  const exportCsv = async () => {
    const { from, to } = rangeOf(range, new Date())
    try {
      const result = await window.diffra.exportUsage({ from: from.toISOString(), to: to.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
      if (result) showToast(`导出了 ${result.rows} 条记录到 ${result.path}`)
    } catch (caught) {
      showToast(`导出失败：${errorMessage(caught)}`)
    }
  }

  // 活动热力图固定看最近 8 周，不随上面的统计范围变
  useEffect(() => {
    let stale = false
    const { from, to } = heatmapRange(new Date())
    window.diffra
      .usageSummary({ from: from.toISOString(), to: to.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
      .then(
        (result) => !stale && setHeatmap(result.days),
        (caught: unknown) => {
          console.error('读取活动热力图失败', caught)
          if (!stale) setHeatmap([])
        },
      )
    return () => {
      stale = true
    }
  }, [])

  const titles = useMemo(() => new Map(tasks.map((task) => [task.sessionId, task])), [tasks])

  return (
    <>
      <SettingsHeader
        title="用量"
        description="按模型供应商返回的数据统计 token 用量，含缓存、推理和每天的活动。"
        actions={<Segmented label="统计范围" value={range} options={RANGES} onChange={(value) => setRange(value)} />}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2" data-testid="usage-toolbar">
        <Button variant="outline" size="sm" onClick={() => setDialog('prices')}>
          <Coins className="size-3.5" />
          单价和预算
        </Button>
        <Button variant="outline" size="sm" onClick={() => void exportCsv()}>
          <Download className="size-3.5" />
          导出 CSV
        </Button>
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setDialog('cleanup')}>
          <Trash2 className="size-3.5" />
          清理旧记录
        </Button>
        {usage.monthlyBudget && monthCost !== undefined && <BudgetBar usage={usage} cost={monthCost} />}
      </div>
      <UsagePricesDialog open={dialog === 'prices'} models={summary?.models ?? []} onClose={() => setDialog(null)} onSaved={() => setVersion((value) => value + 1)} />
      <UsageCleanupDialog open={dialog === 'cleanup'} onClose={() => setDialog(null)} onDone={() => setVersion((value) => value + 1)} />

      {error && (
        <p className="mb-4 text-sm text-destructive" role="alert">
          读取用量失败：{error}
        </p>
      )}
      {!error && !summary && <UsageSkeleton />}
      {summary && summary.totals.calls === 0 && (
        <EmptyState icon={BarChart3} title="这段时间还没有用量" description="开始一个任务后，这里会按天统计 token。" variant="card">
          <Button onClick={() => openHome()}>
            <Plus />
            新建任务
          </Button>
        </EmptyState>
      )}
      {summary && summary.totals.calls > 0 && (
        <div data-testid="usage-summary" className="space-y-3">
          <Tiles totals={summary.totals} days={summary.days} usage={usage} />
          {range !== 'today' && <DailyChart days={summary.days} />}
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_17rem]">
            <Composition totals={summary.totals} />
            <CacheEfficiency totals={summary.totals} />
          </div>
          {heatmap && heatmap.length > 0 && <ActivityHeatmap days={heatmap} />}

          <div className="space-y-8 pt-1">
            <UsageTable
              title="按模型"
              usage={usage}
              rows={summary.models.map((model) => ({
                key: `${model.providerId ?? ''}/${model.modelId}`,
                name: model.providerName ? `${model.providerName} / ${model.modelId}` : model.modelId,
                totals: model,
              }))}
            />
            <UsageTable
              title="按项目"
              usage={usage}
              rows={summary.projects.map((project) => ({ key: project.cwd, name: project.noProject ? `无项目（${project.tasks ?? 0} 个任务）` : folderName(project.cwd), hint: project.cwd, totals: project }))}
            />
            <UsageTable
              title="用量最多的任务"
              usage={usage}
              rows={summary.tasks.map((task) => {
                const stored = titles.get(task.sessionId)
                return {
                  key: task.sessionId,
                  // 首页还没建任务时优化提示词的用量记在一个固定的 id 下
                  name: stored?.title ?? (task.sessionId === PROMPT_ENHANCE_USAGE_ID ? '首页的提示词优化' : task.sessionId === ARCHITECTURE_USAGE_ID ? '架构页的模型解读和画图' : '已删除的任务'),
                  hint: task.cwd,
                  totals: task,
                  onOpen: stored ? () => void openTask(stored) : undefined,
                }
              })}
            />
          </div>
        </div>
      )}
      {summary && (
        <p className="mt-6 text-xs text-muted-foreground">
          用量从这个版本开始记录。
          {summary.totals.unknownCalls > 0 && `有 ${summary.totals.unknownCalls} 次调用供应商没有返回用量，只计了次数。`}
          {summary.skippedLines > 0 && `用量记录里有 ${summary.skippedLines} 行读不了（可能是应用异常退出时留下的），已跳过。`}
        </p>
      )}
    </>
  )
}

// 只在第一次读取时出现；之后切换范围先显示旧数据，避免布局跳动
function UsageSkeleton() {
  return (
    <div role="status" aria-label="正在统计用量" className="motion-safe:animate-pulse">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <div key={index} aria-hidden className="space-y-2.5 rounded-xl border p-4">
            <div className="h-3 w-12 rounded-sm bg-muted" />
            <div className="h-6 w-20 rounded-sm bg-muted" />
            <div className="h-3 w-16 rounded-sm bg-muted" />
          </div>
        ))}
      </div>
      <div aria-hidden className="mt-3 h-44 rounded-xl bg-muted/60" />
      <div aria-hidden className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="h-36 rounded-xl bg-muted/60" />
        <div className="h-36 rounded-xl bg-muted/60" />
      </div>
    </div>
  )
}

// 每月预算用了多少（v2）：到 80% 变成提醒色，超过 100% 用警告色
function BudgetBar({ usage, cost }: { usage: UsageSettings; cost: string }) {
  const ratio = budgetRatio(usage, cost) ?? 0
  return (
    <div className="ml-auto flex min-w-48 items-center gap-2 text-xs" data-testid="usage-budget" title="本月按你填的单价估算的费用">
      <span className={cn('tabular-nums', ratio >= 0.8 ? 'text-warning' : 'text-muted-foreground')}>
        本月 {formatMoney(usage, cost)} / {formatMoney(usage, usage.monthlyBudget ?? '0')}
      </span>
      <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted" aria-hidden>
        <span className={cn('block h-full rounded-full', ratio >= 0.8 ? 'bg-warning' : 'bg-chart-1')} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
      </span>
    </div>
  )
}

function Tiles({ totals, days, usage }: { totals: UsageTotals; days: UsageSummary['days']; usage: UsageSettings }) {
  const known = totals.calls - totals.unknownCalls
  const activeDays = days.filter((day) => day.calls > 0).length
  const tiles = [
    { label: '总用量', value: compact(total(totals)), unit: 'token', title: exact(total(totals)), note: '输入 + 输出' },
    { label: '输入', value: compact(totals.input), unit: 'token', title: exact(totals.input), note: `缓存命中 ${percent(totals.cacheRead, totals.input)}` },
    { label: '输出', value: compact(totals.output), unit: 'token', title: exact(totals.output), note: `其中推理 ${compact(totals.reasoning)}` },
    {
      label: '缓存命中率',
      value: percent(totals.cacheRead, totals.input),
      unit: '',
      title: `命中 ${exact(totals.cacheRead)}，写入 ${exact(totals.cacheWrite)}`,
      note: `命中 ${compact(totals.cacheRead)} · 写入 ${compact(totals.cacheWrite)}`,
    },
    {
      label: '模型调用',
      value: exact(totals.calls),
      unit: '次',
      title: exact(totals.calls),
      note: `平均每次 ${known > 0 ? compact(Math.round(total(totals) / known)) : '—'}`,
    },
    { label: '活跃天数', value: exact(activeDays), unit: '天', title: `${activeDays} 天有用量`, note: `平均每天 ${activeDays > 0 ? compact(Math.round(total(totals) / activeDays)) : '—'}` },
    // v2：填了单价才有费用
    ...(totals.cost !== undefined
      ? [{ label: '估算费用', value: formatMoney(usage, totals.cost), unit: '', title: '按你填的单价算，以供应商账单为准', note: totals.unpricedCalls ? `${totals.unpricedCalls} 次调用没有单价，没算` : '按你填的单价算' }]
      : []),
  ]
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {tiles.map((tile, index) => (
        <div key={tile.label} className="min-w-0 rounded-xl border bg-card p-4" data-testid="usage-tile">
          <div className="text-xs text-muted-foreground">{tile.label}</div>
          {/* 总用量是这一页的焦点，其余五项小一档 */}
          <div className={cn('mt-1 truncate font-semibold tabular-nums', index === 0 ? 'text-2xl' : 'text-xl')} title={tile.title}>
            {tile.value} {tile.unit && <span className="text-sm font-normal text-muted-foreground">{tile.unit}</span>}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">{tile.note}</div>
        </div>
      ))}
    </div>
  )
}

interface CompositionPart {
  key: string
  label: string
  value: number
  color: string
}

// 输入拆成缓存命中和新增，输出拆成正文和推理；四段加起来正好是总用量（侧栏的用量面板也用）
export function compositionOf(totals: UsageTotals): CompositionPart[] {
  const cacheRead = Math.max(0, Math.min(totals.cacheRead, totals.input))
  const reasoning = Math.max(0, Math.min(totals.reasoning, totals.output))
  return [
    { key: 'cache', label: '缓存命中', value: cacheRead, color: 'var(--chart-2)' },
    { key: 'fresh', label: '新增输入', value: Math.max(0, totals.input - cacheRead), color: 'var(--chart-3)' },
    { key: 'output', label: '输出', value: Math.max(0, totals.output - reasoning), color: 'var(--chart-1)' },
    { key: 'reasoning', label: '推理', value: reasoning, color: 'var(--chart-4)' },
  ]
}

const DONUT_RADIUS = 46
const DONUT_LENGTH = 2 * Math.PI * DONUT_RADIUS

function Composition({ totals }: { totals: UsageTotals }) {
  const parts = compositionOf(totals)
  const whole = total(totals)
  let offset = 0
  return (
    <section className={USAGE_CARD} aria-label="用量构成">
      <h2 className={USAGE_CARD_TITLE}>用量构成</h2>
      <div className="mt-3 flex items-center gap-5">
        <div className="relative shrink-0">
          <svg viewBox="0 0 120 120" className="size-32 -rotate-90" role="img" aria-label="用量构成环形图">
            <circle cx="60" cy="60" r={DONUT_RADIUS} fill="none" strokeWidth="14" className="stroke-muted" />
            {whole > 0 &&
              parts.filter((part) => part.value > 0).map((part) => {
                const length = (part.value / whole) * DONUT_LENGTH
                const visible = Math.max(0, length - 1.5)
                const circle = (
                  <circle
                    key={part.key}
                    cx="60"
                    cy="60"
                    r={DONUT_RADIUS}
                    fill="none"
                    strokeWidth="14"
                    strokeLinecap="butt"
                    strokeDasharray={`${visible} ${DONUT_LENGTH - visible}`}
                    strokeDashoffset={-offset}
                    style={{ stroke: part.color }}
                  />
                )
                offset += length
                return circle
              })}
          </svg>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-lg font-semibold tabular-nums">{formatTokens(whole)}</span>
            <span className="text-xs text-muted-foreground">token</span>
          </div>
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          {parts.map((part) => (
            <div key={part.key} className="flex items-center gap-2 text-xs">
              <span aria-hidden className="size-2 shrink-0 rounded-xs" style={{ background: part.color }} />
              <span className="min-w-0 flex-1 truncate">{part.label}</span>
              <span className="tabular-nums">{compact(part.value)}</span>
              <span className="w-9 text-right text-muted-foreground tabular-nums">{percent(part.value, whole)}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function CacheEfficiency({ totals }: { totals: UsageTotals }) {
  const rate = rateOf(totals.cacheRead, totals.input)
  return (
    <section className={cn(USAGE_CARD, 'flex flex-col')} aria-label="缓存效率">
      <h2 className={USAGE_CARD_TITLE}>
        <Zap className="size-4 text-muted-foreground" />
        缓存效率
      </h2>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="text-2xl font-semibold tabular-nums">{rate === null ? '—' : `${rate}%`}</span>
        <span className="text-xs text-muted-foreground">命中率</span>
      </div>
      <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
        <span className="h-full rounded-full bg-chart-2" style={{ width: `${rate ?? 0}%` }} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div className="min-w-0">
          <div className="text-muted-foreground">命中</div>
          <div className="mt-0.5 truncate font-semibold tabular-nums" title={exact(totals.cacheRead)}>{compact(totals.cacheRead)}</div>
        </div>
        <div className="min-w-0">
          <div className="text-muted-foreground">写入</div>
          <div className="mt-0.5 truncate font-semibold tabular-nums" title={exact(totals.cacheWrite)}>{compact(totals.cacheWrite)}</div>
        </div>
      </div>
      <p className="mt-auto pt-3 text-xs text-muted-foreground">命中率 = 命中缓存的输入 token / 全部输入 token。</p>
    </section>
  )
}

// 最近 8 周每天一格，颜色越深当天 token 越多；悬停看日期、用量和调用次数
function ActivityHeatmap({ days }: { days: UsageSummary['days'] }) {
  const scale = Math.max(...days.map(total), 1)
  const weeks: Array<Array<UsageSummary['days'][number] | undefined>> = []
  for (let index = 0; index < days.length; index += 7) {
    const week: Array<UsageSummary['days'][number] | undefined> = days.slice(index, index + 7)
    while (week.length < 7) week.push(undefined)
    weeks.push(week)
  }
  const levelOf = (value: number) => (value <= 0 ? 0 : Math.max(1, Math.min(5, Math.ceil((value / scale) * 5))))
  return (
    <section className={USAGE_CARD} aria-label="最近 8 周的活动热力图">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className={USAGE_CARD_TITLE}>
          <Activity className="size-4 text-muted-foreground" />
          最近 8 周
        </h2>
        <span className="text-xs text-muted-foreground">每天的 token 用量，颜色越深越多</span>
      </div>
      <div className="mt-3 flex gap-1 overflow-x-auto pb-1">
        {weeks.map((week, weekIndex) => (
          <div key={`week-${weekIndex}`} className="flex flex-col gap-1">
            {week.map((day, dayIndex) =>
              day ? (
                <span
                  key={day.date}
                  title={`${day.date} · ${exact(total(day))} token · ${day.calls} 次调用`}
                  aria-label={`${day.date}，${exact(total(day))} token，${day.calls} 次调用`}
                  className={cn('size-3.5 rounded-xs', levelOf(total(day)) === 0 && 'bg-muted')}
                  style={levelOf(total(day)) === 0 ? undefined : { backgroundColor: `color-mix(in oklab, var(--chart-1) ${levelOf(total(day)) * 20}%, transparent)` }}
                />
              ) : (
                <span key={`empty-${weekIndex}-${dayIndex}`} aria-hidden className="size-3.5" />
              ),
            )}
          </div>
        ))}
      </div>
      <div className="mt-1 flex items-center justify-end gap-1.5 text-xs text-muted-foreground" aria-hidden>
        <Clock3 className="size-3" />
        <span>{days[0]?.date.slice(5).replace('-', '/')}</span>
        <span>→</span>
        <span>今天</span>
        <span className="ml-3">少</span>
        {[0, 1, 2, 3, 4, 5].map((level) => (
          <span
            key={level}
            className={cn('size-2.5 rounded-xs', level === 0 && 'bg-muted')}
            style={level === 0 ? undefined : { backgroundColor: `color-mix(in oklab, var(--chart-1) ${level * 20}%, transparent)` }}
          />
        ))}
        <span>多</span>
      </div>
    </section>
  )
}

// 刻度取 1/2/4/6/8/10 乘 10 的整数次方，中线也是整数，缩写后不会四舍五入走样
function niceCeil(value: number): number {
  const power = 10 ** Math.floor(Math.log10(value))
  const step = [1, 2, 4, 6, 8, 10].find((multiple) => multiple * power >= value) ?? 10
  return step * power
}

// 每天一根堆叠柱：缓存命中、新增输入、输出、推理；悬停看明细
function DailyChart({ days }: { days: UsageSummary['days'] }) {
  const [hovered, setHovered] = useState<number | null>(null)
  const scale = niceCeil(Math.max(...days.map(total), 1))
  const labelEvery = Math.max(1, Math.ceil(days.length / 7))
  const active = hovered === null ? null : days[hovered]
  const now = new Date()
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`

  return (
    <section aria-label="每天的 token 用量" className={USAGE_CARD}>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className={cn(USAGE_CARD_TITLE, 'mr-auto')}>每天</h2>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><span className="size-2 rounded-xs bg-chart-2" />缓存命中</span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><span className="size-2 rounded-xs bg-chart-3" />新增输入</span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><span className="size-2 rounded-xs bg-chart-1" />输出</span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><span className="size-2 rounded-xs bg-chart-4" />推理</span>
      </div>
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-36">
            <div className="absolute inset-x-0 top-0 border-t border-dashed" />
            <div className="absolute inset-x-0 top-1/2 border-t border-dashed" />
          </div>
          <div className="relative flex h-36 items-end gap-0.5 border-b" onMouseLeave={() => setHovered(null)}>
            {days.map((day, index) => (
              <div
                key={day.date}
                className="flex h-full min-w-0 flex-1 items-end justify-center"
                onMouseEnter={() => setHovered(index)}
                aria-hidden="true"
              >
                <div
                  className={cn(
                    'flex w-full max-w-7 flex-col-reverse overflow-hidden',
                    total(day) > 0 ? 'rounded-t-sm' : 'h-0.5 bg-muted-foreground/20',
                    hovered !== null && hovered !== index && 'opacity-50',
                  )}
                  style={total(day) > 0 ? { height: `max(2px, ${(total(day) / scale) * 100}%)` } : undefined}
                >
                  {total(day) > 0 &&
                    compositionOf(day)
                      .filter((part) => part.value > 0)
                      .map((part) => (
                        <span
                          key={part.key}
                          className="w-full"
                          style={{ height: `${(part.value / total(day)) * 100}%`, backgroundColor: part.color }}
                        />
                      ))}
                </div>
              </div>
            ))}
          </div>
          {active && hovered !== null && (
            // 放在柱子旁边、图表区域里面；右半边的柱子提示放在左侧，免得超出
            <div
              role="tooltip"
              className={cn(
                'pointer-events-none absolute top-0 z-10 w-44 rounded-md border bg-popover px-3 py-2 text-xs shadow-overlay',
                hovered >= days.length / 2 ? '-translate-x-[calc(100%+12px)]' : 'translate-x-3',
              )}
              style={{ left: `${((hovered + 0.5) / days.length) * 100}%` }}
            >
              <div className="mb-1 font-semibold">{active.date}</div>
              <TooltipRow label="合计" value={exact(total(active))} />
              <TooltipRow label="输入" value={exact(active.input)} />
              <TooltipRow label="缓存命中" value={`${compact(active.cacheRead)} · ${percent(active.cacheRead, active.input)}`} />
              <TooltipRow label="输出" value={exact(active.output)} />
              <TooltipRow label="推理" value={exact(active.reasoning)} />
              <TooltipRow label="调用" value={`${active.calls} 次`} />
            </div>
          )}
          <div className="mt-1 flex gap-0.5 text-xs text-muted-foreground" aria-hidden="true">
            {days.map((day, index) => (
              <span key={day.date} className="min-w-0 flex-1 text-center whitespace-nowrap">
                {day.date === today ? '今天' : index % labelEvery === 0 || index === days.length - 1 ? day.date.slice(5).replace('-', '/') : ''}
              </span>
            ))}
          </div>
        </div>
        <div aria-hidden="true" className="relative h-36 w-10 shrink-0 text-xs text-muted-foreground tabular-nums">
          <span className="absolute top-0 left-0 -translate-y-1/2">{formatTokens(scale)}</span>
          <span className="absolute top-1/2 left-0 -translate-y-1/2">{formatTokens(scale / 2)}</span>
          <span className="absolute bottom-0 left-0 translate-y-1/2">0</span>
        </div>
      </div>
      {/* sr-only 的 1px 宽高对表格不起作用，表格会按行数撑开、把整个窗口撑出滚动条，所以裁剪放在外层 div 上 */}
      <div className="sr-only">
        <table>
          <caption>每天的 token 用量</caption>
          <thead>
            <tr>
              <th>日期</th>
              <th>输入</th>
              <th>输出</th>
              <th>调用次数</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.date}>
                <td>{day.date}</td>
                <td>{day.input}</td>
                <td>{day.output}</td>
                <td>{day.calls}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function TooltipRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  )
}

interface UsageRow {
  key: string
  name: string
  hint?: string
  totals: UsageTotals
  onOpen?: () => void
}

const NUMBER_CELL = 'px-3 py-2 text-right tabular-nums'

// 三张表共用同一组列宽，数字列上下对齐
function UsageTable({ title, rows, usage }: { title: string; rows: UsageRow[]; usage: UsageSettings }) {
  const maxTotal = Math.max(...rows.map((row) => total(row.totals)), 1)
  const priced = rows.some((row) => row.totals.cost !== undefined)
  return (
    <SettingsGroup title={title} className="overflow-x-auto">
      <table className="w-full min-w-2xl table-fixed text-sm">
        <colgroup>
          <col />
          <col className="w-20" />
          <col className="w-28" />
          <col className="w-20" />
          <col className="w-28" />
          <col className="w-28" />
          {priced && <col className="w-24" />}
        </colgroup>
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            <th className="px-3 py-2 text-left font-normal">名称</th>
            <th className="px-3 py-2 text-right font-normal">调用</th>
            <th className="px-3 py-2 text-right font-normal">输入</th>
            <th className="px-3 py-2 text-right font-normal">缓存命中</th>
            <th className="px-3 py-2 text-right font-normal">输出</th>
            <th className="px-3 py-2 text-right font-normal">合计</th>
            {priced && <th className="px-3 py-2 text-right font-normal">费用</th>}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => (
            // 整行可点；名称里的按钮负责键盘操作，它的点击会冒泡到这一行
            <tr key={row.key} data-testid="usage-row" className={cn(row.onOpen && 'group cursor-pointer hover:bg-accent')} onClick={row.onOpen}>
              <td className="px-3 py-2" title={row.hint}>
                {row.onOpen ? (
                  <button type="button" className="flex max-w-full items-center gap-1 text-left">
                    <span className="truncate underline-offset-2 group-hover:underline">{row.name}</span>
                  </button>
                ) : (
                  <span className="block truncate">{row.name}</span>
                )}
                <span className="mt-1 flex h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                  <span className="h-full rounded-full bg-chart-1" style={{ width: `${(total(row.totals) / maxTotal) * 100}%` }} />
                </span>
              </td>
              <td className={NUMBER_CELL}>{exact(row.totals.calls)}</td>
              <td className={NUMBER_CELL}>{exact(row.totals.input)}</td>
              <td className={cn(NUMBER_CELL, 'text-muted-foreground')}>{percent(row.totals.cacheRead, row.totals.input)}</td>
              <td className={NUMBER_CELL}>{exact(row.totals.output)}</td>
              <td className={cn(NUMBER_CELL, 'font-semibold')}>{exact(total(row.totals))}</td>
              {priced && <td className={NUMBER_CELL}>{row.totals.cost !== undefined && !(row.totals.cost === '0.000000' && row.totals.unpricedCalls) ? formatMoney(usage, row.totals.cost) : '—'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </SettingsGroup>
  )
}
