import { useEffect, useMemo, useState } from 'react'
import type { UsageSummary, UsageTotals } from '@diffra/core/types'
import { BarChart3, Plus } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Segmented } from '@/components/ui/segmented'
import { errorMessage } from '@/lib/errors'
import { folderName, formatTokens } from '@/lib/format'
import { openHome, openTask } from '@/state/actions'
import { useAppState } from '@/state/store'
import { SettingsGroup, SettingsHeader } from './SettingsLayout'

type Range = 'today' | 'week' | 'month30' | 'thisMonth'

const RANGES: Array<{ value: Range; label: string }> = [
  { value: 'today', label: '今天' },
  { value: 'week', label: '近 7 天' },
  { value: 'month30', label: '近 30 天' },
  { value: 'thisMonth', label: '本月' },
]

// 按本机时区算起点；终点是现在。core 按同一个时区划分每天
function rangeOf(range: Range, now: Date): { from: Date; to: Date } {
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

const total = (totals: UsageTotals) => totals.input + totals.output
const exact = (value: number) => value.toLocaleString('zh-CN')
// 卡片宽度放得下 10 万以内的精确值，再大才缩写
const compact = (value: number) => (value < 100_000 ? exact(value) : formatTokens(value))
const percent = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—')
const pad = (value: number) => String(value).padStart(2, '0')

export function UsageSection() {
  const tasks = useAppState((state) => state.tasks)
  const [range, setRange] = useState<Range>('week')
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

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
  }, [range])

  const titles = useMemo(() => new Map(tasks.map((task) => [task.sessionId, task])), [tasks])

  return (
    <>
      <SettingsHeader
        title="用量"
        description="按模型供应商返回的数据统计 token 用量。"
        actions={<Segmented label="统计范围" value={range} options={RANGES} onChange={(value) => setRange(value)} />}
      />

      {error && (
        <p className="mb-4 text-sm text-destructive" role="alert">
          读取用量失败：{error}
        </p>
      )}
      {!error && !summary && <UsageSkeleton />}
      {summary && summary.totals.calls === 0 && (
        <EmptyState icon={BarChart3} title="这段时间还没有用量" description="开始一个任务后，这里会按天统计 token。" className="border bg-card">
          <Button onClick={() => openHome()}>
            <Plus />
            新建任务
          </Button>
        </EmptyState>
      )}
      {summary && summary.totals.calls > 0 && (
        <div data-testid="usage-summary">
          <Tiles totals={summary.totals} />
          {range !== 'today' && <DailyChart days={summary.days} />}

          <div className="mt-8">
            <UsageTable
              title="按模型"
              rows={summary.models.map((model) => ({
                key: `${model.providerId ?? ''}/${model.modelId}`,
                name: model.providerName ? `${model.providerName} / ${model.modelId}` : model.modelId,
                totals: model,
              }))}
            />
            <UsageTable
              title="按项目"
              rows={summary.projects.map((project) => ({ key: project.cwd, name: folderName(project.cwd), hint: project.cwd, totals: project }))}
            />
            <UsageTable
              title="用量最多的任务"
              rows={summary.tasks.map((task) => {
                const stored = titles.get(task.sessionId)
                return {
                  key: task.sessionId,
                  name: stored?.title ?? '已删除的任务',
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
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} aria-hidden className="space-y-2.5 rounded-xl border px-4 py-3">
            <div className="h-3 w-12 rounded-sm bg-muted" />
            <div className="h-6 w-20 rounded-sm bg-muted" />
            <div className="h-3 w-16 rounded-sm bg-muted" />
          </div>
        ))}
      </div>
      <div aria-hidden className="mt-8 h-36 rounded-lg bg-muted/60" />
    </div>
  )
}

function Tiles({ totals }: { totals: UsageTotals }) {
  const known = totals.calls - totals.unknownCalls
  const tiles = [
    { label: '总用量', value: compact(total(totals)), unit: 'token', title: exact(total(totals)), note: '输入 + 输出' },
    { label: '输入', value: compact(totals.input), unit: 'token', title: exact(totals.input), note: `缓存命中 ${percent(totals.cacheRead, totals.input)}` },
    { label: '输出', value: compact(totals.output), unit: 'token', title: exact(totals.output), note: `其中推理 ${compact(totals.reasoning)}` },
    {
      label: '模型调用',
      value: exact(totals.calls),
      unit: '次',
      title: exact(totals.calls),
      note: `平均每次 ${known > 0 ? compact(Math.round(total(totals) / known)) : '—'}`,
    },
  ]
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {tiles.map((tile) => (
        <div key={tile.label} className="min-w-0 rounded-xl border px-4 py-3" data-testid="usage-tile">
          <div className="text-xs text-muted-foreground">{tile.label}</div>
          <div className="mt-1 truncate text-2xl font-semibold tabular-nums" title={tile.title}>
            {tile.value} <span className="text-sm font-normal text-muted-foreground">{tile.unit}</span>
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">{tile.note}</div>
        </div>
      ))}
    </div>
  )
}

// 刻度取 1/2/4/6/8/10 乘 10 的整数次方，中线也是整数，缩写后不会四舍五入走样
function niceCeil(value: number): number {
  const power = 10 ** Math.floor(Math.log10(value))
  const step = [1, 2, 4, 6, 8, 10].find((multiple) => multiple * power >= value) ?? 10
  return step * power
}

// 每天一根柱子，高度是当天的总 token；悬停看明细
function DailyChart({ days }: { days: UsageSummary['days'] }) {
  const [hovered, setHovered] = useState<number | null>(null)
  const scale = niceCeil(Math.max(...days.map(total), 1))
  const labelEvery = Math.max(1, Math.ceil(days.length / 7))
  const active = hovered === null ? null : days[hovered]
  const now = new Date()
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`

  return (
    <section aria-label="每天的 token 用量" className="mt-8">
      <h2 className="mb-2 text-sm font-semibold">每天</h2>
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
                    'w-full max-w-7',
                    total(day) > 0 ? 'rounded-t-sm bg-chart-1' : 'h-0.5 bg-muted-foreground/20',
                    hovered !== null && hovered !== index && 'opacity-50',
                  )}
                  style={total(day) > 0 ? { height: `max(2px, ${(total(day) / scale) * 100}%)` } : undefined}
                />
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
              <TooltipRow label="缓存命中" value={percent(active.cacheRead, active.input)} />
              <TooltipRow label="输出" value={exact(active.output)} />
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
      <table className="sr-only">
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
function UsageTable({ title, rows }: { title: string; rows: UsageRow[] }) {
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
        </colgroup>
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            <th className="px-3 py-2 text-left font-normal">名称</th>
            <th className="px-3 py-2 text-right font-normal">调用</th>
            <th className="px-3 py-2 text-right font-normal">输入</th>
            <th className="px-3 py-2 text-right font-normal">缓存命中</th>
            <th className="px-3 py-2 text-right font-normal">输出</th>
            <th className="px-3 py-2 text-right font-normal">合计</th>
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
              </td>
              <td className={NUMBER_CELL}>{exact(row.totals.calls)}</td>
              <td className={NUMBER_CELL}>{exact(row.totals.input)}</td>
              <td className={cn(NUMBER_CELL, 'text-muted-foreground')}>{percent(row.totals.cacheRead, row.totals.input)}</td>
              <td className={NUMBER_CELL}>{exact(row.totals.output)}</td>
              <td className={cn(NUMBER_CELL, 'font-semibold')}>{exact(total(row.totals))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </SettingsGroup>
  )
}
