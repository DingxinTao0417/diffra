import { useState } from 'react'
import { AlarmClock, Bell, Send, X } from 'lucide-react'
import { type Todo, type TodoPriority, TODO_MAX_TEXT, TODO_MAX_TITLE, TODO_PRIORITIES, type TodoSchedule, todoParts } from '../../../../shared/todos'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Segmented } from '@/components/ui/segmented'
import { Textarea } from '@/components/ui/textarea'
import { formatDue } from '@/lib/todo-time'
import { useNow } from '@/lib/use-now'
import { addTodo, updateTodo } from '@/state/actions'
import { showToast } from '@/state/store'
import { SchedulePicker } from './SchedulePicker'
import { TodoProjectPicker } from './TodoInput'
import { priorityLabel } from './TodoPriority'
import { TodoTagEditor } from './TodoTagEditor'

type PriorityChoice = 'none' | `${TodoPriority}`

export interface TodoDraft {
  title: string
  project: string | null
  tags: string[]
  at: Date | null
}

// 添加、编辑一条待办：标题（必填）、正文、优先级、标签、项目、提醒时间。todo 有值时是编辑，draft 是从快速记那一行带过来的。
// 新设「定时发送」还是在列表那一行上做；编辑已经定时发送的待办时，这里只改时间或取消，发给谁不变
export function TodoEditorDialog({ todo, draft, onClose }: { todo?: Todo; draft?: TodoDraft; onClose(saved: boolean): void }) {
  const parts = todo ? todoParts(todo) : null
  const [title, setTitle] = useState(parts?.title ?? draft?.title ?? '')
  const [body, setBody] = useState(parts?.body ?? '')
  const [priority, setPriority] = useState<PriorityChoice>(todo?.priority === undefined || todo.priority === null ? 'none' : `${todo.priority}`)
  const [tags, setTags] = useState(todo?.tags ?? draft?.tags ?? [])
  const [project, setProject] = useState(todo ? todo.project : (draft?.project ?? null))
  const original = todo?.schedule ?? null
  const [at, setAt] = useState<Date | null>(original ? new Date(original.at) : (draft?.at ?? null))
  const [busy, setBusy] = useState(false)
  const now = useNow()
  const sending = original?.action.kind === 'send'

  const save = async () => {
    if (!title.trim() || busy) return
    setBusy(true)
    const chosen = priority === 'none' ? null : (Number(priority) as TodoPriority)
    try {
      if (todo) {
        await updateTodo(todo.id, { text: title, body, priority: chosen, tags, project, schedule: nextSchedule(original, at) })
      } else {
        await addTodo(title, at ?? undefined, { project, tags, body, priority: chosen })
      }
      onClose(true)
    } catch {
      showToast('保存待办失败，请重试')
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose(false)}>
      <DialogContent className="sm:max-w-xl" data-testid="todo-editor">
        <DialogHeader>
          <DialogTitle>{todo ? '编辑待办' : '添加待办'}</DialogTitle>
          <DialogDescription>标题必填，其余都可以不填。Ctrl+Enter 保存。</DialogDescription>
        </DialogHeader>
        <div
          className="flex flex-col gap-3 text-sm"
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void save()
            }
          }}
        >
          <input
            autoFocus
            aria-label="待办标题"
            value={title}
            maxLength={Math.max(TODO_MAX_TITLE, title.length)}
            placeholder="一句话说清要做什么"
            className="h-9 rounded-md border bg-background px-3 outline-none focus:border-ring/60"
            onChange={(event) => setTitle(event.target.value)}
          />
          <Textarea aria-label="待办正文" value={body} maxLength={TODO_MAX_TEXT} rows={5} placeholder="细节、背景、链接（选填）" className="max-h-72 min-h-24" onChange={(event) => setBody(event.target.value)} />
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-12 shrink-0 text-xs text-muted-foreground">优先级</span>
            <Segmented<PriorityChoice>
              label="优先级"
              size="sm"
              value={priority}
              options={[{ value: 'none', label: '不设' }, ...TODO_PRIORITIES.map((value) => ({ value: `${value}` as PriorityChoice, label: priorityLabel(value) }))]}
              onChange={setPriority}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-12 shrink-0 text-xs text-muted-foreground">项目</span>
            <TodoProjectPicker value={project} onChange={setProject} />
          </div>
          <div className="flex items-start gap-2">
            <span className="mt-1 w-12 shrink-0 text-xs text-muted-foreground">标签</span>
            <TodoTagEditor tags={tags} onChange={setTags} className="min-w-0 flex-1" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-12 shrink-0 text-xs text-muted-foreground">{sending ? '定时发送' : '提醒'}</span>
            <SchedulePicker value={at} kind={sending ? 'send' : 'remind'} align="start" onPick={(picked) => setAt(picked)} onClear={at ? () => setAt(null) : undefined}>
              <Button variant="outline" size="xs" className="text-muted-foreground" data-testid="todo-editor-due">
                {sending ? <Send className="size-3" /> : at ? <Bell className="size-3" /> : <AlarmClock className="size-3" />}
                {at ? formatDue(at.toISOString(), now) : '不定时间'}
              </Button>
            </SchedulePicker>
            {at && (
              <Button variant="ghost" size="icon-xs" aria-label="不定时间" className="text-muted-foreground" onClick={() => setAt(null)}>
                <X className="size-3" />
              </Button>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onClose(false)}>
            取消
          </Button>
          <Button disabled={!title.trim() || busy} onClick={() => void save()}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// 时间没变保持原样（包括到点后的结果）；改了时间就重新等，定时发送保留发给谁和发什么
function nextSchedule(original: TodoSchedule | null, at: Date | null): TodoSchedule | null {
  if (!at) return null
  if (original && new Date(original.at).getTime() === at.getTime()) return original
  if (original?.action.kind === 'send') return { ...original, at: at.toISOString(), result: null }
  return { at: at.toISOString(), action: { kind: 'remind' }, result: null }
}
