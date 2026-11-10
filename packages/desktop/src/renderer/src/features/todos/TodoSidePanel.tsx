import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { Todo } from '../../../../shared/todos'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { addDays, dayKey, dueParts, isDue, monthGrid, sameDay, startOfDay } from '@/lib/todo-time'
import { store } from '@/state/store'

const WEEK_HEADER = ['一', '二', '三', '四', '五', '六', '日']
const UPCOMING = 5

// 列表页右边一栏：几个数、迷你月历（点哪天就到日历视图的那天）、接下来要到的几条（点了定位到那一条）
export function TodoSidePanel({ todos, now, onPickDay }: { todos: Todo[]; now: Date; onPickDay(day: Date): void }) {
  const [month, setMonth] = useState(() => new Date(now.getFullYear(), now.getMonth(), 1))
  const today = startOfDay(now)
  const open = todos.filter((todo) => !todo.done)
  const scheduled = open.filter((todo) => todo.schedule)
  const days = useMemo(() => new Set(scheduled.map((todo) => dayKey(new Date(todo.schedule!.at)))), [scheduled])
  const upcoming = scheduled
    .filter((todo) => !isDue(todo, now))
    .sort((a, b) => a.schedule!.at.localeCompare(b.schedule!.at))
    .slice(0, UPCOMING)
  const counts = [
    { label: '逾期', value: open.filter((todo) => isDue(todo, now)).length, warn: true },
    { label: '今天', value: scheduled.filter((todo) => !isDue(todo, now) && sameDay(new Date(todo.schedule!.at), today)).length, warn: false },
    { label: '7 天内', value: scheduled.filter((todo) => !isDue(todo, now) && new Date(todo.schedule!.at) < addDays(today, 7)).length, warn: false },
  ]

  return (
    <aside className="flex flex-col gap-4" data-testid="todo-side-panel">
      <div className="grid grid-cols-3 gap-2">
        {counts.map((item) => (
          <div key={item.label} className="rounded-xl border bg-card px-3 py-2">
            <div className={cn('text-lg leading-tight font-bold tabular-nums', item.warn && item.value > 0 ? 'text-warning' : 'text-foreground')}>{item.value}</div>
            <div className="text-[11px] text-muted-foreground">{item.label}</div>
          </div>
        ))}
      </div>
      <section className="rounded-xl border bg-card p-3" data-testid="mini-calendar" aria-label="月历">
        <div className="mb-1 flex items-center">
          <h2 className="mr-auto text-sm font-bold tabular-nums">
            {month.getFullYear()}年{month.getMonth() + 1}月
          </h2>
          <Button size="icon-xs" variant="ghost" aria-label="上个月" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>
            <ChevronLeft className="size-3.5" />
          </Button>
          <Button size="icon-xs" variant="ghost" aria-label="下个月" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>
            <ChevronRight className="size-3.5" />
          </Button>
        </div>
        <div className="grid grid-cols-7 text-center text-[11px] text-muted-foreground">
          {WEEK_HEADER.map((day) => (
            <div key={day} className="py-1">
              {day}
            </div>
          ))}
          {monthGrid(month).map((day) => {
            const isToday = sameDay(day, today)
            const has = days.has(dayKey(day))
            return (
              <button
                key={dayKey(day)}
                type="button"
                data-day={dayKey(day)}
                aria-label={`${day.getMonth() + 1}月${day.getDate()}日${has ? '，有待办' : ''}`}
                className={cn(
                  'relative mx-auto flex size-7 items-center justify-center rounded-full text-xs tabular-nums hover:bg-accent',
                  day.getMonth() !== month.getMonth() ? 'text-muted-foreground/50' : 'text-foreground',
                  isToday && 'bg-foreground font-bold text-background hover:bg-foreground/85',
                )}
                onClick={() => onPickDay(startOfDay(day))}
              >
                {day.getDate()}
                {has && <span className={cn('absolute bottom-0.5 size-1 rounded-full', isToday ? 'bg-background' : 'bg-foreground/60')} />}
              </button>
            )
          })}
        </div>
      </section>
      <section className="flex flex-col gap-1" aria-label="接下来" data-testid="todo-upcoming">
        <h2 className="px-1 text-xs font-bold text-muted-foreground">接下来</h2>
        {upcoming.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">没有快到时间的待办</p>
        ) : (
          upcoming.map((todo) => {
            const parts = dueParts(todo.schedule!.at, now)
            return (
              <button
                key={todo.id}
                type="button"
                className="flex items-baseline gap-2 rounded-md px-1 py-1 text-left text-sm hover:bg-accent"
                onClick={() => store.set((state) => ({ ...state, todoFocus: todo.id }))}
              >
                <span className="w-16 shrink-0 text-xs text-muted-foreground tabular-nums">
                  {parts.day} {parts.clock}
                </span>
                <span className="min-w-0 flex-1 truncate">{todo.text}</span>
              </button>
            )
          })
        )}
      </section>
    </aside>
  )
}
