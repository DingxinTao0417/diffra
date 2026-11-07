import { useEffect, useMemo, useState } from 'react'
import type { UsageSummary, UsageTotals } from '@diffra/core/types'
import { cn } from 'cn'
import { Segmented } from '@/components/ui/segmented'
import { errorMessage } from '@/lib/errors'
import { folderName, formatTokens } from '@/lib/format'
import { openTask } from '@/state/actions'
import { useAppState } from '@/state/store'

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
const percent = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—')

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
      <div className="mb-6 flex flex-wrap items-end gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <h1 className="text-xl font-semibold">用量</h1>
          <p className="text-sm text-muted-foreground">每次模型调用（编码和规范审查）的 token 数，按供应商返回的用量统计；从这个版本开始记录。</p>
        </div>
        <Segmented label="统计范围" value={range} options={RANGES} onChange={(value) => setRange(value)} />
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          读取用量失败：{error}
        </p>
      )}
      {!error && !summary && <p className="text-sm text-muted-foreground">正在统计…</p>}
      {summary && summary.totals.calls === 0 && <p className="text-sm text-muted-foreground">这段时间没有模型调用。</p>}
      {summary && summary.totals.calls > 0 && (
        <div className="space-y-8" data-testid="usage-summary">
          <Tiles totals={summary.totals} />
          {range !== 'today' && <DailyChart days={summary.days} />}

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
          {(summary.totals.unknownCalls > 0 || summary.skippedLines > 0) && (
            <p className="text-xs text-muted-foreground">
              {summary.totals.unknownCalls > 0 && `有 ${summary.totals.unknownCalls} 次调用供应商没有返回用量，只计了次数。`}
              {summary.skippedLines > 0 && `用量记录里有 ${summary.skippedLines} 行读不了（可能是应用异常退出时留下的），已跳过。`}
            </p>
          )}
        </div>
      )}
    </>
  )
}

function Tiles({ totals }: { totals: UsageTotals }) {
  const tiles = [
    { label: '总 token', value: formatTokens(total(totals)), title: exact(total(totals)), note: '输入 + 输出' },
    { label: '输入', value: formatTokens(totals.input), title: exact(totals.input), note: `缓存命中 ${percent(totals.cacheRead, totals.input)}` },
    { label: '输出', value: formatTokens(totals.output), title: exact(totals.output), note: `其中推理 ${formatTokens(totals.reasoning)}` },
    { label: '模型调用', value: `${exact(totals.calls)} 次`, title: exact(totals.calls), note: null },
  ]
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {tiles.map((tile) => (
        <div key={tile.label} className="rounded-lg border px-4 py-3" data-testid="usage-tile">
          <div className="text-xs text-muted-foreground">{tile.label}</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums" title={tile.title}>
            {tile.value}
          </div>
          {tile.note && <div className="mt-0.5 text-xs text-muted-foreground">{tile.note}</div>}
        </div>
      ))}
    </div>
  )
}

// 每天一根柱子，高度是当天的总 token；悬停看明细
function DailyChart({ days }: { days: UsageSummary['days'] }) {
  const [hovered, setHovered] = useState<number | null>(null)
  const max = Math.max(...days.map(total), 1)
  const labelEvery = Math.max(1, Math.ceil(days.length / 7))
  const active = hovered === null ? null : days[hovered]

  return (
    <section aria-label="每天的 token 用量">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="font-medium">每天</span>
        <span className="text-xs text-muted-foreground">最高 {formatTokens(max)}</span>
      </div>
      <div className="relative">
        <div className="flex h-36 items-end gap-0.5 border-b" onMouseLeave={() => setHovered(null)}>
          {days.map((day, index) => (
            <div
              key={day.date}
              className="flex h-full min-w-0 flex-1 items-end justify-center"
              onMouseEnter={() => setHovered(index)}
              aria-hidden="true"
            >
              <div
                className={cn('w-full max-w-7 rounded-t-[4px] bg-primary', hovered !== null && hovered !== index && 'opacity-50')}
                style={{ height: total(day) > 0 ? `max(2px, ${(total(day) / max) * 100}%)` : '0' }}
              />
            </div>
          ))}
        </div>
        {active && hovered !== null && (
          // 放在柱子旁边、图表区域里面；右半边的柱子提示放在左侧，免得超出
          <div
            role="tooltip"
            className={cn(
              'pointer-events-none absolute top-0 z-10 w-44 rounded-md border bg-popover px-3 py-2 text-xs shadow-md',
              hovered >= days.length / 2 ? '-translate-x-[calc(100%+12px)]' : 'translate-x-3',
            )}
            style={{ left: `${((hovered + 0.5) / days.length) * 100}%` }}
          >
            <div className="mb-1 font-medium">{active.date}</div>
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
              {index % labelEvery === 0 || index === days.length - 1 ? day.date.slice(5).replace('-', '/') : ''}
            </span>
          ))}
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

function UsageTable({ title, rows }: { title: string; rows: UsageRow[] }) {
  return (
    <section>
      <div className="mb-2 font-medium">{title}</div>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
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
              <tr key={row.key} data-testid="usage-row">
                <td className="max-w-64 px-3 py-2" title={row.hint}>
                  {row.onOpen ? (
                    <button type="button" className="max-w-full truncate text-left hover:text-primary hover:underline" onClick={row.onOpen}>
                      {row.name}
                    </button>
                  ) : (
                    <span className="block truncate">{row.name}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{exact(row.totals.calls)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{exact(row.totals.input)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{percent(row.totals.cacheRead, row.totals.input)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{exact(row.totals.output)}</td>
                <td className="px-3 py-2 text-right font-medium tabular-nums">{exact(total(row.totals))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
