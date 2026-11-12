import { ClipboardCheck } from 'lucide-react'
import { todoParts } from '../../../../shared/todos'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/lib/errors'
import { folderName } from '@/lib/format'
import type { LiveTask } from '@/state/store'
import { showToast, useAppState } from '@/state/store'
import { acceptTodos, openTodos } from '@/state/actions'
import { taskFinishedForTodo } from './todo-acceptance'

// 派给这个任务的待办，任务做完后在对话底部出现验收卡片；验收后待办同步完成
export function TodoAcceptanceCard({ task }: { task: LiveTask }) {
  const todos = useAppState((state) => state.todos)
  if (!taskFinishedForTodo(task)) return null
  const pending = (todos ?? []).filter((todo) => !todo.done && todo.sentTo?.sessionId === task.sessionId)
  if (pending.length === 0) return null
  const accept = (ids: string[]) => {
    acceptTodos(ids).catch((error: unknown) => showToast(`验收失败：${errorMessage(error)}`))
  }
  return (
    <section className="rounded-xl border border-border bg-card p-4" data-testid="todo-acceptance">
      <div className="flex items-start gap-2.5">
        <ClipboardCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold">待办待验收</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">这个任务是从待办发来的。确认结果后验收，待办会标记为已完成。</p>
        </div>
        <Button size="xs" variant="ghost" className="shrink-0 text-muted-foreground" onClick={() => openTodos()}>
          去待办页
        </Button>
      </div>
      <ul className="mt-3 flex flex-col divide-y">
        {pending.map((todo) => (
          <li key={todo.id} className="flex items-start gap-3 py-2 first:pt-0 last:pb-0" data-testid="todo-acceptance-item">
            <div className="min-w-0 flex-1">
              <TodoText todo={todo} />
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span>{todo.project ? folderName(todo.project) : '无项目'}</span>
                {todo.tags.map((tag) => (
                  <span key={tag}>#{tag}</span>
                ))}
              </div>
            </div>
            <Button size="xs" className="shrink-0" onClick={() => accept([todo.id])}>
              验收并完成
            </Button>
          </li>
        ))}
      </ul>
      {pending.length > 1 && (
        <div className="mt-2 flex justify-end">
          <Button size="sm" onClick={() => accept(pending.map((todo) => todo.id))}>
            全部验收
          </Button>
        </div>
      )}
    </section>
  )
}

function TodoText({ todo }: { todo: Parameters<typeof todoParts>[0] }) {
  const { title, body } = todoParts(todo)
  return (
    <>
      <p className="text-sm break-words">{title}</p>
      {body && <p className="mt-0.5 line-clamp-2 text-xs break-words whitespace-pre-wrap text-muted-foreground">{body}</p>}
    </>
  )
}
