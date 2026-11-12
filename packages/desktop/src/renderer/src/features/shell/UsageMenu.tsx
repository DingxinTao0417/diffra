import { useEffect, useState } from 'react'
import { ARCHITECTURE_USAGE_ID, PROMPT_ENHANCE_USAGE_ID, type UsageSummary, type UsageTotals } from '@diffra/core/types'
import { ArrowRight, BarChart3 } from 'lucide-react'
import { cn } from 'cn'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { compositionOf, rangeOf } from '@/features/settings/UsageSection'
import { errorMessage } from '@/lib/errors'
import { folderName, formatTokens } from '@/lib/format'
import { openSettings, openTask } from '@/state/actions'
import { store, useAppState } from '@/state/store'
import { FooterButton } from './FooterButton'

// 侧栏底部的用量（docs/decisions.md「左下角的设备和用量」）：右边写今天的 token，点开看今天、近 7 天、本月的构成、按模型、用得最多的任务。
// 和用量页同一份统计、同样按本机时区；右边的数在启动、每轮跑完、切回窗口时读，面板的在打开、切换时读，不在后台一直刷新
type Period = 'today' | 'week' | 'thisMonth'

const PERIODS: Array<{ value: Period; label: string; versus: string }> = [
  { value: 'today', label: '今天', versus: '比昨天这时' },
  { value: 'week', label: '近 7 天', versus: '比前 7 天' },
  { value: 'thisMonth', label: '本月', versus: '比上月同期' },
]
const WEEKDAYS = '日一二三四五六'
// 按模型列前几个，其余合成一行；任务列前几个
const TOP_MODELS = 2
const TOP_TASKS = 3

const tokensOf = (totals: Pick<UsageTotals, 'input' | 'output'>) => totals.input + totals.output

function read(range: { from: Date; to: Date }): Promise<UsageSummary> {
  return window.diffra.usageSummary({ from: range.from.toISOString(), to: range.to.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
}

// 上一个同样长的时间段：昨天到这个时刻、再往前 7 天、上个月 1 号起同样长
function previousOf(period: Period, now: Date): { from: Date; to: Date } {
  const { from, to } = rangeOf(period, now)
  if (period === 'week') return { from: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 13), to: from }
  const start = period === 'today' ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1) : new Date(now.getFullYear(), now.getMonth() - 1, 1)
  return { from: start, to: new Date(start.getTime() + (to.getTime() - from.getTime())) }
}

interface PeriodUsage {
  current: UsageSummary
  previous: UsageSummary
  // 柱状图：今天看的是近 7 天每天，其余就是这段时间的每天
  days: UsageSummary['days']
}

async function readPeriod(period: Period): Promise<PeriodUsage> {
  const now = new Date()
  const [current, previous, week] = await Promise.all([read(rangeOf(period, now)), read(previousOf(period, now)), period === 'today' ? read(rangeOf('week', now)) : null])
  return { current, previous, days: (week ?? current).days }
}

// 有任务从「在跑」变成不在跑（一轮跑完）时加一
function useTurnsEnded(): number {
  const running = useAppState((state) => Object.values(state.live).filter((task) => task.running).length)
  const [ended, setEnded] = useState({ running, count: 0 })
  if (running !== ended.running) setEnded({ running, count: running < ended.running ? ended.count + 1 : ended.count })
  return ended.count
}

export function UsageButton() {
  const [open, setOpen] = useState(false)
  const [today, setToday] = useState<number | null>(null)
  const turnsEnded = useTurnsEnded()
  useEffect(() => {
    const load = () => read(rangeOf('today', new Date())).then((summary) => setToday(tokensOf(summary.totals)), (error: unknown) => console.error('读今天的用量失败', error))
    load()
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [turnsEnded])
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <FooterButton
          aria-label={today === null ? '用量' : `用量：今天 ${formatTokens(today)} token`}
          icon={<BarChart3 className="size-4" />}
          label="用量"
          meta={today !== null && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">今天 {formatTokens(today)}</span>}
          data-testid="usage-button"
        />
      </PopoverTrigger>
      <PopoverContent side="right" align="end" sideOffset={8} collisionPadding={8} className="w-80 p-0" data-testid="usage-panel">
        {open && <UsagePanel onNavigate={() => setOpen(false)} />}
      </PopoverContent>
    </Popover>
  )
}

function UsagePanel({ onNavigate }: { onNavigate(): void }) {
  const [period, setPeriod] = useState<Period>('today')
  const [usage, setUsage] = useState<{ period: Period; data: PeriodUsage } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let stale = false
    setError(null)
    readPeriod(period).then(
      (data) => !stale && setUsage({ period, data }),
      (reason: unknown) => !stale && setError(errorMessage(reason)),
    )
    return () => {
      stale = true
    }
  }, [period])
  const meta = PERIODS.find((item) => item.value === period)!
  const data = usage?.period === period ? usage.data : null

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5">
        <div className="flex rounded-md bg-muted p-0.5 text-xs" role="radiogroup" aria-label="时间段">
          {PERIODS.map((item) => (
            <button
              key={item.value}
              type="button"
              role="radio"
              aria-checked={item.value === period}
              className={cn('rounded-[5px] px-2 py-0.5 text-muted-foreground', item.value === period && 'bg-background text-foreground shadow-xs')}
              onClick={() => setPeriod(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => {
            onNavigate()
            openSettings('usage')
          }}
        >
          用量详情
          <ArrowRight className="size-3" />
        </button>
      </div>
      {error ? (
        <p className="px-3 pb-3 text-xs text-destructive">读用量失败：{error}</p>
      ) : !data ? (
        <p className="px-3 pb-3 text-xs text-muted-foreground">正在读用量…</p>
      ) : (
        <PeriodView period={period} versus={meta.versus} data={data} onNavigate={onNavigate} />
      )}
    </div>
  )
}

function PeriodView({ period, versus, data, onNavigate }: { period: Period; versus: string; data: PeriodUsage; onNavigate(): void }) {
  const tasks = useAppState((state) => state.tasks)
  const { current, previous, days } = data
  const total = tokensOf(current.totals)
  const before = tokensOf(previous.totals)
  const change = before > 0 ? Math.round(((total - before) / before) * 100) : null
  const parts = compositionOf(current.totals)
  const peak = Math.max(1, ...days.map(tokensOf))
  const models = [...current.models].sort((a, b) => tokensOf(b) - tokensOf(a))
  const shownModels = models.slice(0, TOP_MODELS)
  const otherModels = models.slice(TOP_MODELS)
  const otherTokens = otherModels.reduce((sum, model) => sum + tokensOf(model), 0)
  const share = (value: number) => (total > 0 ? Math.round((value / total) * 100) : 0)
  const topTasks = [...current.tasks].sort((a, b) => tokensOf(b) - tokensOf(a)).slice(0, TOP_TASKS)

  return (
    <div className="flex flex-col pb-2" data-testid="usage-period" data-period={period}>
      <div className="flex items-baseline justify-between gap-2 px-3">
        <span className="min-w-0">
          <span className="text-2xl font-bold tabular-nums" data-testid="usage-total">
            {formatTokens(total)}
          </span>
          <span className="ml-1 text-xs text-muted-foreground">token · {current.totals.calls} 次调用</span>
        </span>
        {change !== null && (
          <span className="shrink-0 text-xs text-muted-foreground" data-testid="usage-change">
            {versus}
            {change === 0 ? '持平' : change > 0 ? `多 ${change}%` : `少 ${-change}%`}
          </span>
        )}
      </div>

      {total > 0 && (
        <>
          <div className="mx-3 mt-2 flex h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
            {parts.map((part) => (part.value > 0 ? <span key={part.key} style={{ flex: part.value, background: part.color }} /> : null))}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 px-3 pt-1.5 text-[11px] text-muted-foreground">
            {parts.map((part) => (
              <span key={part.key} className="flex items-center gap-1">
                <span className="size-2 rounded-[2px]" style={{ background: part.color }} />
                {part.label} {formatTokens(part.value)}
              </span>
            ))}
          </div>
        </>
      )}

      <div className="mt-2.5 flex h-12 items-end gap-1 px-3" aria-label="每天的 token 用量">
        {days.map((day, index) => (
          <span
            key={day.date}
            title={`${day.date} · ${formatTokens(tokensOf(day))} token`}
            className={cn('flex-1 rounded-sm bg-chart-1', index === days.length - 1 ? 'opacity-90' : 'opacity-35')}
            style={{ height: `${Math.max(4, (tokensOf(day) / peak) * 100)}%` }}
          />
        ))}
      </div>
      {days.length <= 7 ? (
        <div className="flex gap-1 px-3 pt-1 text-center text-[10px] text-muted-foreground">
          {days.map((day, index) => (
            <span key={day.date} className={cn('flex-1', index === days.length - 1 && 'text-foreground')}>
              {index === days.length - 1 ? '今天' : WEEKDAYS[new Date(`${day.date}T00:00:00`).getDay()]}
            </span>
          ))}
        </div>
      ) : (
        <div className="flex justify-between px-3 pt-1 text-[10px] text-muted-foreground">
          <span>{Number(days[0]?.date.slice(8))} 日</span>
          <span className="text-foreground">今天</span>
        </div>
      )}

      {models.length > 0 && (
        <>
          <p className="mx-3 mt-2.5 border-t pt-2 text-[11px] text-muted-foreground">按模型</p>
          {[...shownModels.map((model) => ({ key: `${model.providerId}/${model.modelId}`, name: model.modelId, value: tokensOf(model) })), ...(otherModels.length > 0 ? [{ key: 'other', name: `其他 ${otherModels.length} 个`, value: otherTokens }] : [])].map((row) => (
            <div key={row.key} className="flex items-center gap-2 px-3 py-0.5 text-xs" data-testid="usage-model">
              <span className="min-w-0 flex-1 truncate" title={row.name}>
                {row.name}
              </span>
              <span className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
                <span className="block h-full bg-chart-1" style={{ width: `${share(row.value)}%` }} />
              </span>
              <span className="w-9 shrink-0 text-right text-muted-foreground tabular-nums">{share(row.value)}%</span>
            </div>
          ))}
        </>
      )}

      {topTasks.length > 0 && (
        <>
          <p className="mx-3 mt-2.5 border-t pt-2 text-[11px] text-muted-foreground">用得最多的任务</p>
          {topTasks.map((task) => {
            const stored = tasks.find((item) => item.sessionId === task.sessionId) ?? store.get().tasks.find((item) => item.sessionId === task.sessionId)
            // 首页还没建任务时优化提示词的用量记在一个固定的 id 下（和用量页一样）
            const name = stored?.title ?? (task.sessionId === PROMPT_ENHANCE_USAGE_ID ? '首页的提示词优化' : task.sessionId === ARCHITECTURE_USAGE_ID ? '架构页的模型解读和画图' : '已删除的任务')
            const label = `${name}${task.cwd ? ` · ${folderName(task.cwd)}` : ''}`
            return (
              <button
                key={task.sessionId}
                type="button"
                disabled={!stored}
                className="flex items-center gap-2 px-3 py-0.5 text-left text-xs enabled:hover:bg-accent disabled:cursor-default"
                data-testid="usage-task"
                onClick={() => {
                  if (!stored) return
                  onNavigate()
                  void openTask(stored)
                }}
              >
                <span className="min-w-0 flex-1 truncate" title={label}>
                  {label}
                </span>
                <span className="shrink-0 text-muted-foreground tabular-nums">{formatTokens(tokensOf(task))}</span>
              </button>
            )
          })}
        </>
      )}
    </div>
  )
}
