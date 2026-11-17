import { useEffect, useRef, useState } from 'react'
import { AlarmClock, Bell, CircleCheck, Paperclip, Pencil, Repeat, Send, Tags, Trash2 } from 'lucide-react'
import { advanceRepeat, repeatLabel, type Todo, type TodoSendTarget, todoParts } from '../../../../shared/todos'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { folderName, formatTime } from '@/lib/format'
import { dueParts, formatDue, isDue } from '@/lib/todo-time'
import { acceptTodos, openTask, saveTodos, setTodoSchedule } from '@/state/actions'
import { showToast, store, useAppState } from '@/state/store'
import { sendScheduleNow } from '@/state/todo-scheduler'
import { SchedulePicker } from './SchedulePicker'
import { TodoAttachmentList } from './TodoAttachments'
import { taskFinishedForTodo } from './todo-acceptance'
import { TodoEditorDialog } from './TodoEditorDialog'
import { PriorityBadge } from './TodoPriority'
import { TodoTagEditor } from './TodoTagEditor'

// 一条待办：勾完成、定时、派给任务、删除；双击或点「编辑」打开编辑对话框。
// 标题一行、正文最多两行，点一下展开看全文。到期时间、定时发送的结果写在下面一行
export function TodoRow({
  todo,
  now,
  selecting = false,
  selected = false,
  showProject = true,
  layout = 'compact',
  onSelect,
  onSend,
  onScheduleSend,
  onDragStart,
}: {
  todo: Todo
  now: Date
  selecting?: boolean
  selected?: boolean
  showProject?: boolean
  // list：左边一列时间（也是改时间的入口），用在列表的卡片里；compact：时间是下面一行的标签，用在日历旁边
  layout?: 'list' | 'compact'
  onSelect?: () => void
  onSend(): void
  onScheduleSend(at: Date): void
  // 日历旁边没定时间的那几条能拖到某一天（v2）
  onDragStart?: (event: React.DragEvent) => void
}) {
  const [editing, setEditing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const attachmentCount = (todo.images?.length ?? 0) + (todo.files?.length ?? 0)
  const [editingTags, setEditingTags] = useState(false)
  const { title, body } = todoParts(todo)
  const row = useRef<HTMLLIElement>(null)
  const save = (change: (todos: Todo[]) => Todo[]) => {
    saveTodos(change).catch(() => showToast('保存待办失败，请重试'))
  }
  const focused = useAppState((state) => state.todoFocus === todo.id)
  const task = useAppState((state) => (todo.sentTo ? state.tasks.find((item) => item.sessionId === todo.sentTo!.sessionId) : undefined))
  // 派出去的任务在这次打开过（还在内存里）并且做完了，提示可以勾掉；不自动勾
  const live = useAppState((state) => (todo.sentTo ? state.live[todo.sentTo.sessionId] : undefined))
  const finished = !todo.done && taskFinishedForTodo(live)
  const schedule = todo.schedule ?? null
  const repeating = Boolean(schedule?.repeat)
  const overdue = isDue(todo, now)
  const result = schedule?.result ?? null

  // 点系统通知跳过来的：滚到这一条、闪一下
  useEffect(() => {
    if (!focused) return
    row.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const timer = setTimeout(() => store.set((state) => ({ ...state, todoFocus: null })), 2400)
    return () => clearTimeout(timer)
  }, [focused])

  const pickTime = (at: Date, kind: 'remind' | 'send') => {
    if (kind === 'send') onScheduleSend(at)
    // 只改时间时保留原来的「到时发给谁」
    else void setTodoSchedule(todo.id, { at: at.toISOString(), action: { kind: 'remind' }, result: null })
  }
  const reschedule = (at: Date, kind: 'remind' | 'send') => {
    if (kind === 'send' && schedule?.action.kind === 'send') void setTodoSchedule(todo.id, { ...schedule, at: at.toISOString(), result: null })
    else pickTime(at, kind)
  }

  return (
    <li
      ref={row}
      className={cn('group flex items-start gap-3 py-2.5 transition-colors hover:bg-accent/40', layout === 'list' ? 'px-4' : 'rounded-lg px-2', focused && 'bg-soft ring-1 ring-ring/40')}
      data-testid="todo-row"
      draggable={onDragStart !== undefined}
      onDragStart={onDragStart}
      data-done={todo.done}
      data-overdue={overdue}
    >
      {layout === 'list' && <TimeColumn todo={todo} now={now} overdue={overdue} onPick={schedule ? reschedule : pickTime} />}
      <Checkbox
        className="mt-0.5"
        aria-label={selecting ? `选中：${title}` : repeating ? `完成这一次：${title}` : `完成：${title}`}
        checked={selecting ? selected : todo.done}
        onCheckedChange={() =>
          selecting
            ? onSelect?.()
            : save((todos) =>
                todos.map((item) => {
                  if (item.id !== todo.id) return item
                  // 重复的待办勾掉的是这一次：挪到下一次，不标完成
                  if (!item.done && item.schedule?.repeat) return advanceRepeat(item, { kind: 'done', at: new Date().toISOString() }, Date.now())
                  return { ...item, done: !item.done, acceptedAt: item.done ? null : item.acceptedAt }
                }),
              )
        }
      />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          aria-expanded={expanded}
          title={expanded ? '收起' : '展开全文，双击编辑'}
          className="flex w-full min-w-0 cursor-pointer flex-col items-stretch text-left"
          data-testid="todo-text"
          onClick={() => setExpanded(!expanded)}
          onDoubleClick={() => setEditing(true)}
        >
          <span className="flex min-w-0 items-start gap-1.5">
            {todo.priority !== undefined && todo.priority !== null && <PriorityBadge priority={todo.priority} className="mt-0.5" />}
            <span className={cn('min-w-0 text-sm break-words transition-colors', expanded ? 'whitespace-pre-wrap' : 'truncate', todo.done && 'text-muted-foreground line-through')} data-testid="todo-title">
              {title}
            </span>
          </span>
          {body && (
            <span className={cn('mt-0.5 text-xs break-words whitespace-pre-wrap text-muted-foreground', !expanded && 'line-clamp-2')} data-testid="todo-body">
              {body}
            </span>
          )}
        </button>
        {expanded && <TodoAttachmentList images={todo.images ?? []} files={todo.files ?? []} className="mt-2" />}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {attachmentCount > 0 && !expanded && (
            <span className="flex items-center gap-0.5" title="点开这条看附件" data-testid="todo-attachment-count">
              <Paperclip className="size-3" />
              {attachmentCount}
            </span>
          )}
          {todo.tags.map((tag) => (
            <button
              key={tag}
              type="button"
              className="rounded-full bg-soft px-1.5 py-0.5 text-xs text-foreground hover:bg-accent"
              aria-label={`编辑标签 ${tag}`}
              data-testid="todo-tag"
              onClick={() => setEditingTags(true)}
            >
              #{tag}
            </button>
          ))}
          {schedule?.repeat && (
            <span className="flex items-center gap-0.5" data-testid="todo-repeat" title={schedule.last ? `上一次：${formatTime(schedule.last.at)}${schedule.last.kind === 'missed' ? '（错过了）' : ''}` : undefined}>
              <Repeat className="size-3" />
              {repeatLabel(schedule.repeat)}
            </span>
          )}
          {layout === 'list' && schedule?.action.kind === 'send' && <span className="max-w-60 truncate">发给 {sendTargetLabel(schedule.action.target)}</span>}
          {layout === 'compact' && schedule && (
            <SchedulePicker
              value={new Date(schedule.at)}
              kind={schedule.action.kind}
              allowSend
              align="start"
              onPick={reschedule}
              onClear={() => void setTodoSchedule(todo.id, null)}
            >
              <button
                type="button"
                data-testid="todo-due"
                className={cn(
                  'flex items-center gap-1 rounded-full border px-2 py-px hover:bg-accent hover:text-foreground',
                  overdue && result?.kind !== 'sent' ? 'border-warning/30 bg-warning-soft text-warning' : 'bg-background',
                )}
                title="改时间"
              >
                {schedule.action.kind === 'send' ? <Send className="size-3" /> : <Bell className="size-3" />}
                {formatDue(schedule.at, now)}
                {schedule.action.kind === 'send' && <span className="max-w-40 truncate">· 发给 {sendTargetLabel(schedule.action.target)}</span>}
              </button>
            </SchedulePicker>
          )}
          {showProject && <span>{todo.project ? folderName(todo.project) : '无项目'}</span>}
          {!schedule && <span>{formatTime(todo.createdAt)}</span>}
          {todo.sentTo && (
            <button
              type="button"
              className="truncate hover:text-foreground hover:underline"
              data-testid="todo-sent"
              onClick={() => task && void openTask(task)}
              disabled={!task}
              title={task ? '打开这个任务' : '任务已删除'}
            >
              已派给 {todo.sentTo.title || '任务'}
            </button>
          )}
          {finished && (
            <span className="flex items-center gap-1 rounded-md bg-soft px-1.5 py-0.5 text-foreground" data-testid="todo-finished">
              <CircleCheck className="size-3" />
              任务已完成，待验收
              {/* primary-color-allow: 验收并完成待办，是下一步动作 */}
              <button type="button" className="ml-0.5 font-bold text-primary hover:underline" onClick={() => acceptTodos([todo.id]).catch(() => showToast('验收失败，请重试'))}>
                验收
              </button>
            </span>
          )}
          {todo.acceptedAt && <span data-testid="todo-accepted">已验收</span>}
        </div>
        {editingTags && (
          <div
            className="mt-1"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setEditingTags(false)
            }}
          >
            <TodoTagEditor
              autoFocus
              tags={todo.tags}
              onChange={(tags) => save((todos) => todos.map((item) => (item.id === todo.id ? { ...item, tags } : item)))}
            />
          </div>
        )}
        {!todo.done && schedule?.action.kind === 'send' && (result?.kind === 'missed' || result?.kind === 'failed') && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs" data-testid="todo-missed">
            <span className="text-warning">{result.kind === 'missed' ? '错过了定时发送' : `定时发送失败：${result.error ?? '未知原因'}`}</span>
            <Button size="xs" variant="outline" onClick={() => void sendScheduleNow(todo)}>
              现在发送
            </Button>
            <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => void setTodoSchedule(todo.id, null)}>
              取消定时
            </Button>
          </div>
        )}
      </div>
      {editing && <TodoEditorDialog todo={todo} onClose={() => setEditing(false)} />}
      {!selecting && (
        <div className="flex shrink-0 items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <RowAction label="编辑" onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" />
          </RowAction>
          {layout === 'compact' && !schedule && (
            <SchedulePicker value={null} allowSend onPick={pickTime}>
              <Button variant="ghost" size="icon-sm" aria-label="定时" className="text-muted-foreground">
                <AlarmClock className="size-3.5" />
              </Button>
            </SchedulePicker>
          )}
          <RowAction label="标签" onClick={() => setEditingTags(true)}>
            <Tags className="size-3.5" />
          </RowAction>
          <RowAction label="发送给任务" onClick={onSend}>
            <Send className="size-3.5" />
          </RowAction>
          <RowAction label="删除" onClick={() => save((todos) => todos.filter((item) => item.id !== todo.id))}>
            <Trash2 className="size-3.5" />
          </RowAction>
        </div>
      )}
    </li>
  )
}

// 列表里每行左边的时间：两行（日子、钟点），过期的标成警示色；没定时间的是个闹钟，点了定时间
function TimeColumn({ todo, now, overdue, onPick }: { todo: Todo; now: Date; overdue: boolean; onPick(at: Date, kind: 'remind' | 'send'): void }) {
  const schedule = todo.schedule ?? null
  const parts = schedule ? dueParts(schedule.at, now) : null
  return (
    <SchedulePicker value={schedule ? new Date(schedule.at) : null} kind={schedule?.action.kind} allowSend align="start" onPick={onPick} onClear={schedule ? () => void setTodoSchedule(todo.id, null) : undefined}>
      {parts ? (
        <button
          type="button"
          data-testid="todo-due"
          title="改时间"
          className={cn(
            'flex w-14 shrink-0 flex-col items-start rounded-md px-1.5 py-0.5 text-left leading-tight hover:bg-accent',
            overdue && schedule?.result?.kind !== 'sent' ? 'text-warning' : todo.done ? 'text-muted-foreground' : 'text-foreground',
          )}
        >
          <span className="text-sm font-bold tabular-nums">{parts.clock}</span>
          <span className="flex items-center gap-0.5 text-xs">
            {schedule?.action.kind === 'send' ? <Send className="size-2.5" /> : <Bell className="size-2.5" />}
            {parts.day}
          </span>
        </button>
      ) : (
        <button type="button" aria-label="定时" title="定个时间" className="flex h-9 w-14 shrink-0 items-center rounded-md px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
          <AlarmClock className="size-4" />
        </button>
      )}
    </SchedulePicker>
  )
}

function sendTargetLabel(target: TodoSendTarget): string {
  if (target.kind === 'existing') return `「${target.title || '任务'}」`
  return target.project ? `新任务 · ${folderName(target.project)}` : '新任务'
}

function RowAction({ label, onClick, children }: { label: string; onClick(): void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} className="text-muted-foreground" onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

