import { useContext, useEffect, useState } from 'react'
import type { TodosData } from '@diffra/core/rich'
import { CalendarClock, ListPlus, ListTodo, Send } from 'lucide-react'
import { cn } from 'cn'
import type { Todo } from '../../../../../shared/todos'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { SchedulePicker } from '@/features/todos/SchedulePicker'
import { SendTodosDialog } from '@/features/todos/SendTodosDialog'
import { addTodo, loadTodos, openTodos, saveTodos, setTodoSchedule } from '@/state/actions'
import { useAppState } from '@/state/store'
import { AnswerContext } from '../answer-links'
import { BlockShell, ShellAction } from './BlockShell'

// ```todos：回答里留到以后的事（第 664 步）。和侧栏的待办是同一份：按标题和项目对上已有的待办，
// 对上了就显示它的完成状态和时间，能勾掉、改期、派给任务；没对上的能加进待办。远程、只读会话里只列出来
export function TodosBlock({ data }: { data: TodosData }) {
  const target = useContext(AnswerContext)
  const todos = useAppState((state) => state.todos)
  const [sending, setSending] = useState<Todo[] | null>(null)
  useEffect(() => {
    if (target && todos === null) void loadTodos()
  }, [target, todos])
  const project = target?.project ?? null
  const linked = (text: string) => todos?.find((todo) => todo.text === text.trim() && todo.project === project) ?? null
  const missing = data.items.filter((item) => !linked(item.text))
  const add = (item: TodosData['items'][number]) => addTodo(item.text, undefined, { project, ...(item.note ? { body: item.note } : {}), ...(item.priority !== undefined ? { priority: item.priority } : {}) })
  return (
    <BlockShell
      testId="rich-todos"
      kind="todos"
      tone="card"
      icon={<ListTodo className="size-3.5 shrink-0" />}
      title={data.title ?? '后续事项'}
      meta={<span className="shrink-0 tabular-nums">· {data.items.length} 条</span>}
      actions={
        target && (
          <>
            {missing.length > 0 && todos !== null && (
              <ShellAction label="全部加入待办" onClick={() => void missing.reduce((chain, item) => chain.then(() => add(item)), Promise.resolve())}>
                <ListPlus />
              </ShellAction>
            )}
            <ShellAction label="去待办页" onClick={openTodos}>
              <ListTodo />
            </ShellAction>
          </>
        )
      }
    >
      <ul className="flex flex-col divide-y">
        {data.items.map((item, index) => {
          const todo = target ? linked(item.text) : null
          return (
            <li key={index} className="flex items-start gap-2.5 px-3 py-2 text-sm" data-testid="rich-todo" data-linked={todo ? (todo.done ? 'done' : 'open') : undefined}>
              {todo ? (
                <Checkbox
                  className="mt-0.5"
                  checked={todo.done}
                  aria-label={`${todo.done ? '标成没做完' : '标成已完成'}：${item.text}`}
                  onCheckedChange={() => void saveTodos((list) => list.map((entry) => (entry.id === todo.id ? { ...entry, done: !entry.done } : entry)))}
                />
              ) : (
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground" aria-hidden="true" />
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className={cn('break-words', todo?.done && 'text-muted-foreground line-through')}>{item.text}</span>
                {item.note && <span className="text-xs text-muted-foreground">{item.note}</span>}
                {todo?.schedule && <span className="text-xs text-muted-foreground tabular-nums">提醒：{new Date(todo.schedule.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>}
                {todo?.sentTo && <span className="text-xs text-muted-foreground">已派给任务「{todo.sentTo.title}」</span>}
              </div>
              {target && todos !== null && !todo && (
                <Button variant="outline" size="xs" className="shrink-0" onClick={() => void add(item)}>
                  <ListPlus />
                  加入待办
                </Button>
              )}
              {todo && !todo.done && (
                <span className="flex shrink-0 items-center">
                  <SchedulePicker value={todo.schedule ? new Date(todo.schedule.at) : null} onPick={(at) => void setTodoSchedule(todo.id, { at: at.toISOString(), action: { kind: 'remind' }, result: null })} onClear={todo.schedule ? () => void setTodoSchedule(todo.id, null) : undefined}>
                    <Button variant="ghost" size="icon-xs" aria-label={`改期：${item.text}`} className="text-muted-foreground">
                      <CalendarClock />
                    </Button>
                  </SchedulePicker>
                  {!todo.sentTo && (
                    <ShellAction label={`派给任务：${item.text}`} onClick={() => setSending([todo])}>
                      <Send />
                    </ShellAction>
                  )}
                </span>
              )}
            </li>
          )
        })}
      </ul>
      {sending && <SendTodosDialog todos={sending} onClose={() => setSending(null)} />}
    </BlockShell>
  )
}
