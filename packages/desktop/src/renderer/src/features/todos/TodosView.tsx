import { useMemo, useState } from 'react'
import { AlarmClock, ChevronDown, ChevronRight, ListTodo, Send } from 'lucide-react'
import type { Todo } from '../../../../shared/todos'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Kbd } from '@/components/ui/kbd'
import { Segmented } from '@/components/ui/segmented'
import { folderName } from '@/lib/format'
import { dayKey, formatDue, GROUP_LABELS, groupOf, type TodoGroup } from '@/lib/todo-time'
import { useNow } from '@/lib/use-now'
import { addTodo } from '@/state/actions'
import { store, useAppState } from '@/state/store'
import { SchedulePicker } from './SchedulePicker'
import { SendTodosDialog } from './SendTodosDialog'
import { TodoCalendar } from './TodoCalendar'
import { TodoInput } from './TodoInput'
import { TodoRow } from './TodoRow'
import { TodoSidePanel } from './TodoSidePanel'
import { shortcutLabel } from '@/lib/platform'

const ALL = '__all__'
const NO_PROJECT = '__none__'
const OPEN_GROUPS: TodoGroup[] = ['overdue', 'today', 'tomorrow', 'week', 'later', 'unscheduled']

// 发给任务的弹窗：立即发几条，或者给一条定时发送
type Sending = { ids: string[]; at?: Date }

// 待办页：顶部输入框回车就记（可以先定个提醒时间）；列表按到期时间分组，或者切到日历按天看
export function TodosView() {
  const todos = useAppState((state) => state.todos)
  const view = useAppState((state) => state.todosView)
  const now = useNow()
  const [filter, setFilter] = useState(ALL)
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [sending, setSending] = useState<Sending | null>(null)
  const [showDone, setShowDone] = useState(false)
  // 从右边迷你月历点进日历视图时停在那天
  const [calendarDay, setCalendarDay] = useState<Date | null>(null)

  const projects = useMemo(() => [...new Set((todos ?? []).map((todo) => todo.project ?? NO_PROJECT))], [todos])
  const allTags = useMemo(
    () => [...new Set((todos ?? []).flatMap((todo) => todo.tags))].sort((a, b) => a.localeCompare(b, 'zh-CN')),
    [todos],
  )
  const visible = useMemo(
    () =>
      (todos ?? []).filter(
        (todo) =>
          (filter === ALL || (todo.project ?? NO_PROJECT) === filter) &&
          (tagFilter === null || todo.tags.some((tag) => tag.toLowerCase() === tagFilter.toLowerCase())),
      ),
    [todos, filter, tagFilter],
  )
  const groups = useMemo(() => groupTodos(visible, now), [visible, now])
  const openCount = visible.filter((todo) => !todo.done).length
  const toggleSelected = (id: string) => setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
  const rowProps = (todo: Todo) => ({
    todo,
    now,
    onSend: () => setSending({ ids: [todo.id] }),
    onScheduleSend: (at: Date) => setSending({ ids: [todo.id], at }),
  })

  return (
    <div className="flex h-full flex-col overflow-y-auto" data-testid="todos-view">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 py-8">
        <div className="flex flex-wrap items-center gap-3">
          <ListTodo className="size-5 text-muted-foreground" />
          <h1 className="text-lg font-bold">待办</h1>
          <Segmented<'list' | 'calendar'>
            label="待办视图"
            size="sm"
            value={view}
            options={[
              { value: 'list', label: '列表' },
              { value: 'calendar', label: '日历' },
            ]}
            onChange={(next) => {
              setCalendarDay(null)
              store.set((state) => ({ ...state, todosView: next }))
            }}
          />
          <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
            任何页面按 <Kbd>{shortcutLabel('Ctrl+J')}</Kbd> 快速记
          </span>
        </div>
        <TodoInput autoFocus />
        {(todos?.length ?? 0) > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {[ALL, ...projects].map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                className="rounded-full border px-2.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground aria-pressed:border-foreground/30 aria-pressed:bg-soft aria-pressed:text-foreground"
                onClick={() => setFilter(value)}
              >
                {value === ALL ? '全部' : value === NO_PROJECT ? '无项目' : folderName(value)}
              </button>
            ))}
            {allTags.length > 0 && (
              <>
                <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />
                {allTags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    aria-pressed={tagFilter?.toLowerCase() === tag.toLowerCase()}
                    className="rounded-full border px-2.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground aria-pressed:border-foreground/30 aria-pressed:bg-soft aria-pressed:text-foreground"
                    data-testid="todo-tag-filter"
                    onClick={() => setTagFilter((current) => (current?.toLowerCase() === tag.toLowerCase() ? null : tag))}
                  >
                    #{tag}
                  </button>
                ))}
              </>
            )}
            <div className="flex-1" />
            {view === 'list' &&
              (selecting ? (
                <>
                  <Button size="sm" disabled={selected.length === 0} onClick={() => setSending({ ids: selected })}>
                    <Send className="size-3.5" />
                    发送 {selected.length} 条
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => (setSelecting(false), setSelected([]))}>
                    取消
                  </Button>
                </>
              ) : (
                openCount > 1 && (
                  <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setSelecting(true)}>
                    选几条一起发
                  </Button>
                )
              ))}
          </div>
        )}
        {todos !== null && todos.length === 0 && (
          <EmptyState icon={ListTodo} title="突然有点子就记在这里" description="可以定个时间到点提醒，或者到点自动发给某个任务；也可以随时派给新任务或已有的任务。" className="mt-6 bg-transparent" />
        )}
        {view === 'calendar' && todos !== null && todos.length > 0 ? (
          <TodoCalendar key={calendarDay ? dayKey(calendarDay) : 'today'} todos={visible} now={now} rowProps={rowProps} initialDay={calendarDay ?? undefined} />
        ) : (
          <div className={cn('grid items-start gap-6', todos !== null && todos.length > 0 && 'lg:grid-cols-[minmax(0,1fr)_17rem]')}>
          <div className="flex flex-col gap-4" data-testid="todo-list">
            {OPEN_GROUPS.map((group) =>
              groups[group].length === 0 ? null : (
                <section key={group} className="overflow-hidden rounded-xl border bg-card" data-testid="todo-group" data-group={group} aria-label={GROUP_LABELS[group]}>
                  <h2 className={cn('flex items-center gap-2 border-b px-4 py-2 text-xs font-bold', group === 'overdue' ? 'bg-warning-soft text-warning' : 'text-muted-foreground')}>
                    {GROUP_LABELS[group]}
                    <span className="font-normal tabular-nums">{groups[group].length}</span>
                  </h2>
                  <ul className="flex flex-col divide-y">
                    {groups[group].map((todo) => (
                      <TodoRow key={todo.id} {...rowProps(todo)} layout="list" selecting={selecting} selected={selected.includes(todo.id)} onSelect={() => toggleSelected(todo.id)} />
                    ))}
                  </ul>
                </section>
              ),
            )}
            {groups.done.length > 0 && (
              <section className="overflow-hidden rounded-xl border bg-card">
                <button type="button" className="flex w-full items-center gap-1 px-4 py-2 text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowDone(!showDone)}>
                  {showDone ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                  已完成 {groups.done.length}
                </button>
                {showDone && (
                  <ul className="flex flex-col divide-y border-t opacity-70">
                    {groups.done.map((todo) => (
                      <TodoRow key={todo.id} {...rowProps(todo)} layout="list" />
                    ))}
                  </ul>
                )}
              </section>
            )}
          </div>
          {todos !== null && todos.length > 0 && (
            <div className="hidden lg:block">
              <TodoSidePanel
                todos={visible}
                now={now}
                onPickDay={(day) => {
                  setCalendarDay(day)
                  store.set((state) => ({ ...state, todosView: 'calendar' }))
                }}
              />
            </div>
          )}
          </div>
        )}
      </div>
      {sending && (
        <SendTodosDialog
          todos={(todos ?? []).filter((todo) => sending.ids.includes(todo.id))}
          scheduleAt={sending.at}
          onClose={(sent) => {
            setSending(null)
            if (sent && !sending.at) {
              setSelecting(false)
              setSelected([])
            }
          }}
        />
      )}
    </div>
  )
}

// 按到期时间分组；组内按时间先后，没定时间的新记的在前
function groupTodos(todos: Todo[], now: Date): Record<TodoGroup, Todo[]> {
  const groups: Record<TodoGroup, Todo[]> = { overdue: [], today: [], tomorrow: [], week: [], later: [], unscheduled: [], done: [] }
  for (const todo of todos) groups[groupOf(todo, now)].push(todo)
  for (const group of OPEN_GROUPS) {
    if (group !== 'unscheduled') groups[group].sort((a, b) => a.schedule!.at.localeCompare(b.schedule!.at))
  }
  return groups
}

// 快速记：任何页面按 Ctrl+J 弹出，回车记下就关；可以顺手定个提醒时间
export function QuickTodo() {
  const open = useAppState((state) => state.quickTodoOpen)
  const [text, setText] = useState('')
  const [at, setAt] = useState<Date | null>(null)
  const now = useNow()
  if (!open) return null
  const close = () => {
    setText('')
    setAt(null)
    store.set((state) => ({ ...state, quickTodoOpen: false }))
  }
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 pt-[18vh]" onMouseDown={(event) => event.target === event.currentTarget && close()} data-testid="quick-todo">
      <div className="flex w-full max-w-lg items-center gap-1 rounded-xl border bg-popover p-2 shadow-overlay">
        <input
          autoFocus
          aria-label="快速记待办"
          value={text}
          placeholder="记下一个点子，回车保存，Esc 关闭"
          className="h-10 min-w-0 flex-1 bg-transparent px-2 outline-none"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') close()
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            event.preventDefault()
            if (text.trim()) void addTodo(text, at ?? undefined)
            close()
          }}
        />
        {at && <span className="shrink-0 rounded-full bg-soft px-2 py-0.5 text-xs">提醒 {formatDue(at.toISOString(), now)}</span>}
        <SchedulePicker value={at} onPick={(picked) => setAt(picked)}>
          <Button variant="ghost" size="icon-sm" aria-label="定个提醒时间" className="text-muted-foreground">
            <AlarmClock className="size-4" />
          </Button>
        </SchedulePicker>
      </div>
    </div>
  )
}
