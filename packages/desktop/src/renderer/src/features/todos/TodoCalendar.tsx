import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { Todo } from '../../../../shared/todos'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { addDays, atTime, dayKey, formatClock, isDue, monthGrid, sameDay, startOfDay } from '@/lib/todo-time'
import { TodoInput } from './TodoInput'
import { TodoRow } from './TodoRow'

const WEEK_HEADER = ['一', '二', '三', '四', '五', '六', '日']
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
// 每格最多列几条，多的写「还有 N 条」
const CELL_ITEMS = 3

type RowProps = (todo: Todo) => { todo: Todo; now: Date; onSend(): void; onScheduleSend(at: Date): void }

// 日历：按月看定了时间的待办，点某一天在右边看这天的、给这天加一条；没定时间的列在右边下面
export function TodoCalendar({ todos, now, rowProps, initialDay }: { todos: Todo[]; now: Date; rowProps: RowProps; initialDay?: Date }) {
  const start = initialDay ?? now
  const [month, setMonth] = useState(() => new Date(start.getFullYear(), start.getMonth(), 1))
  const [selected, setSelected] = useState(() => startOfDay(start))
  const byDay = useMemo(() => {
    const map = new Map<string, Todo[]>()
    for (const todo of todos) {
      if (!todo.schedule) continue
      const key = dayKey(new Date(todo.schedule.at))
      map.set(key, [...(map.get(key) ?? []), todo])
    }
    for (const items of map.values()) items.sort((a, b) => a.schedule!.at.localeCompare(b.schedule!.at))
    return map
  }, [todos])
  const unscheduled = todos.filter((todo) => !todo.schedule && !todo.done)
  const dayTodos = byDay.get(dayKey(selected)) ?? []
  const today = startOfDay(now)
  // 给选中的那天加一条：今天默认下一个整点，以后的日子默认早上 9 点，过去的日子不定时间
  const defaultAt = selected < today ? undefined : sameDay(selected, today) ? new Date(Math.ceil((now.getTime() + 1) / 3_600_000) * 3_600_000) : atTime(selected, 9)
  const shiftMonth = (delta: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + delta, 1))

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]" data-testid="todo-calendar">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1">
          <h2 className="mr-auto text-base font-bold tabular-nums" data-testid="calendar-month">
            {month.getFullYear()}年{month.getMonth() + 1}月
          </h2>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setMonth(new Date(now.getFullYear(), now.getMonth(), 1))
              setSelected(today)
            }}
          >
            今天
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="上个月" onClick={() => shiftMonth(-1)}>
            <ChevronLeft className="size-4" />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="下个月" onClick={() => shiftMonth(1)}>
            <ChevronRight className="size-4" />
          </Button>
        </div>
        <div className="overflow-hidden rounded-xl border">
          <div className="grid grid-cols-7 border-b bg-muted/40 text-center text-xs text-muted-foreground">
            {WEEK_HEADER.map((day) => (
              <div key={day} className="py-1.5">
                {day}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7" aria-label="日历">
            {monthGrid(month).map((day, index) => {
              const items = byDay.get(dayKey(day)) ?? []
              const inMonth = day.getMonth() === month.getMonth()
              const isToday = sameDay(day, today)
              const isSelected = sameDay(day, selected)
              return (
                <button
                  key={dayKey(day)}
                  type="button"
                  aria-pressed={isSelected}
                  aria-label={`${day.getMonth() + 1}月${day.getDate()}日，${items.length} 条待办`}
                  data-testid="calendar-day"
                  data-day={dayKey(day)}
                  className={cn(
                    'flex min-h-20 flex-col gap-0.5 border-b p-1.5 text-left align-top transition-colors hover:bg-accent/50 sm:min-h-24',
                    index % 7 !== 6 && 'border-r',
                    index >= 35 && 'border-b-0',
                    !inMonth && 'bg-muted/30 text-muted-foreground',
                    isSelected && 'bg-soft hover:bg-soft',
                  )}
                  onClick={() => {
                    setSelected(startOfDay(day))
                    if (!inMonth) setMonth(new Date(day.getFullYear(), day.getMonth(), 1))
                  }}
                >
                  <span className={cn('flex size-6 items-center justify-center rounded-full text-xs tabular-nums', isToday && 'bg-foreground font-bold text-background')}>{day.getDate()}</span>
                  {items.slice(0, CELL_ITEMS).map((todo) => {
                    const overdue = isDue(todo, now)
                    return (
                      <span
                        key={todo.id}
                        className={cn(
                          'w-full truncate rounded px-1 py-px text-[11px] leading-4',
                          todo.done ? 'text-muted-foreground line-through' : overdue ? 'bg-warning-soft text-warning' : 'bg-background/80 text-foreground ring-1 ring-border',
                        )}
                        title={todo.text}
                      >
                        <span className="text-muted-foreground tabular-nums">{formatClock(new Date(todo.schedule!.at))}</span> {todo.text}
                      </span>
                    )
                  })}
                  {items.length > CELL_ITEMS && <span className="px-1 text-[11px] text-muted-foreground">还有 {items.length - CELL_ITEMS} 条</span>}
                </button>
              )
            })}
          </div>
        </div>
      </div>
      <aside className="flex flex-col gap-5">
        <section className="flex flex-col gap-2" aria-label="选中的这天">
          <h2 className="text-sm font-bold" data-testid="calendar-selected">
            {selected.getMonth() + 1}月{selected.getDate()}日 周{WEEKDAYS[selected.getDay()]}
            {sameDay(selected, today) && <span className="ml-1.5 font-normal text-muted-foreground">今天</span>}
            {sameDay(selected, addDays(today, 1)) && <span className="ml-1.5 font-normal text-muted-foreground">明天</span>}
          </h2>
          <TodoInput key={dayKey(selected)} placeholder={defaultAt ? `在这天加一条（${formatClock(defaultAt)} 提醒）` : '记一条（不定时间）'} defaultAt={defaultAt} className="h-9 rounded-lg text-sm" />
          {dayTodos.length === 0 ? (
            <p className="px-2 text-xs text-muted-foreground">这天没有待办</p>
          ) : (
            <ul className="flex flex-col">
              {dayTodos.map((todo) => (
                <TodoRow key={todo.id} {...rowProps(todo)} />
              ))}
            </ul>
          )}
        </section>
        {unscheduled.length > 0 && (
          <section className="flex flex-col gap-1" aria-label="未定时间">
            <h2 className="flex items-center gap-2 text-xs font-bold text-muted-foreground">
              未定时间 <span className="font-normal tabular-nums">{unscheduled.length}</span>
            </h2>
            <ul className="flex flex-col">
              {unscheduled.map((todo) => (
                <TodoRow key={todo.id} {...rowProps(todo)} />
              ))}
            </ul>
          </section>
        )}
      </aside>
    </div>
  )
}
