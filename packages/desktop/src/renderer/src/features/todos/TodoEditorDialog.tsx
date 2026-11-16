import { useRef, useState } from 'react'
import { AlarmClock, Bell, Paperclip, Send, X } from 'lucide-react'
import type { FileReference } from '../../../../shared/attachments'
import { type Todo, type TodoPriority, TODO_MAX_TEXT, TODO_MAX_TITLE, TODO_PRIORITIES, TODO_REPEAT_KINDS, TODO_REPEAT_LABELS, type TodoRepeatKind, type TodoSchedule, todoParts } from '../../../../shared/todos'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Segmented } from '@/components/ui/segmented'
import { Textarea } from '@/components/ui/textarea'
import { formatDue } from '@/lib/todo-time'
import { useNow } from '@/lib/use-now'
import { addTodo, updateTodo } from '@/state/actions'
import { showToast } from '@/state/store'
import { SchedulePicker } from './SchedulePicker'
import { TodoAttachmentList, useTodoAttachments } from './TodoAttachments'
import { TodoProjectPicker } from './TodoInput'
import { priorityLabel } from './TodoPriority'
import { TodoTagEditor } from './TodoTagEditor'

type PriorityChoice = 'none' | `${TodoPriority}`
type RepeatChoice = 'none' | TodoRepeatKind

const REPEAT_OPTIONS: Array<{ value: RepeatChoice; label: string }> = [{ value: 'none', label: '不重复' }, ...TODO_REPEAT_KINDS.map((value) => ({ value, label: TODO_REPEAT_LABELS[value] }))]

export interface TodoDraft {
  title: string
  project: string | null
  tags: string[]
  at: Date | null
  images?: string[]
  files?: FileReference[]
}

// 添加、编辑一条待办：标题（必填）、正文、优先级、标签、项目、提醒时间、附件（按钮、粘贴或拖进来）。todo 有值时是编辑，draft 是从快速记那一行带过来的。
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
  const [repeat, setRepeat] = useState<RepeatChoice>(original?.repeat?.every ?? 'none')
  const [busy, setBusy] = useState(false)
  const attachments = useTodoAttachments({ images: todo?.images ?? draft?.images ?? [], files: todo?.files ?? draft?.files ?? [] })
  const picker = useRef<HTMLInputElement>(null)
  const now = useNow()
  const sending = original?.action.kind === 'send'

  const save = async () => {
    if (!title.trim() || busy || attachments.busy) return
    setBusy(true)
    const chosen = priority === 'none' ? null : (Number(priority) as TodoPriority)
    try {
      if (todo) {
        await updateTodo(todo.id, { text: title, body, priority: chosen, tags, project, schedule: nextSchedule(original, at, repeat), images: attachments.images, files: attachments.files })
      } else {
        await addTodo(title, at ?? undefined, { project, tags, body, priority: chosen, images: attachments.images, files: attachments.files, repeat: at && repeat !== 'none' ? repeat : undefined })
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
          <DialogDescription>标题必填，其余都可以不填。图片和文件可以直接粘贴或拖进来。Ctrl+Enter 保存。</DialogDescription>
        </DialogHeader>
        <div
          className="flex flex-col gap-3 text-sm"
          {...attachments.handlers}
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
          {at && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-12 shrink-0 text-xs text-muted-foreground">重复</span>
              <Segmented<RepeatChoice> label="重复" size="sm" value={repeat} options={REPEAT_OPTIONS} onChange={setRepeat} />
            </div>
          )}
          <div className="flex items-start gap-2">
            <span className="mt-1 w-12 shrink-0 text-xs text-muted-foreground">附件</span>
            <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
              <TodoAttachmentList images={attachments.images} files={attachments.files} onRemoveImage={attachments.removeImage} onRemoveFile={attachments.removeFile} className="pt-1.5 pr-1.5" />
              <Button variant="outline" size="xs" className="text-muted-foreground" disabled={attachments.busy} onClick={() => picker.current?.click()}>
                <Paperclip className="size-3" />
                添加图片或文件
              </Button>
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                aria-label="选择附件"
                data-testid="todo-attachment-input"
                onChange={(event) => {
                  const picked = [...(event.target.files ?? [])]
                  event.target.value = ''
                  void attachments.add(picked)
                }}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onClose(false)}>
            取消
          </Button>
          <Button disabled={!title.trim() || busy || attachments.busy} onClick={() => void save()}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// 时间和重复都没变保持原样（包括到点后的结果）；改了就重新等，定时发送保留发给谁和发什么。
// 重复从这次定的时刻算起；原来就是同一种重复的保留隔几个周期
function nextSchedule(original: TodoSchedule | null, at: Date | null, repeat: RepeatChoice): TodoSchedule | null {
  if (!at) return null
  const every = repeat === 'none' ? null : repeat
  if (original && new Date(original.at).getTime() === at.getTime() && (original.repeat?.every ?? null) === every) return original
  const base: TodoSchedule = original?.action.kind === 'send' ? { ...original, at: at.toISOString(), result: null } : { at: at.toISOString(), action: { kind: 'remind' }, result: null }
  if (every) return { ...base, repeat: { every, interval: original?.repeat?.every === every ? original.repeat.interval : 1, start: at.toISOString() } }
  return original?.repeat ? { ...base, repeat: null } : base
}
