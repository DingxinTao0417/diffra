import { useEffect, useRef, useState } from 'react'
import { AlarmClock, Bell, Pencil, Send, Tags, Trash2 } from 'lucide-react'
import type { Todo, TodoSendTarget } from '../../../../shared/todos'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { folderName, formatTime } from '@/lib/format'
import { dueParts, formatDue, isDue } from '@/lib/todo-time'
import { turnVerdict, type VerdictTone } from '@/lib/turn-verdict'
import { openTask, saveTodos, setTodoSchedule } from '@/state/actions'
import { store, useAppState } from '@/state/store'
import { sendScheduleNow } from '@/state/todo-scheduler'
import { SchedulePicker } from './SchedulePicker'
import { TodoTagEditor } from './TodoTagEditor'

const FINISHED = new Set<VerdictTone>(['verified', 'unverified', 'nochange', 'done'])

// 一条待办：勾完成、双击改字、定时、派给任务、删除。到期时间、定时发送的结果写在下面一行
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
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [editingTags, setEditingTags] = useState(false)
  const row = useRef<HTMLLIElement>(null)
  const focused = useAppState((state) => state.todoFocus === todo.id)
  const task = useAppState((state) => (todo.sentTo ? state.tasks.find((item) => item.sessionId === todo.sentTo!.sessionId) : undefined))
  // 派出去的任务在这次打开过（还在内存里）并且做完了，提示可以勾掉；不自动勾
  const live = useAppState((state) => (todo.sentTo ? state.live[todo.sentTo.sessionId] : undefined))
  const finished = !todo.done && live !== undefined && FINISHED.has(turnVerdict(live).tone)
  const schedule = todo.schedule ?? null
  const overdue = isDue(todo, now)
  const result = schedule?.result ?? null

  // 点系统通知跳过来的：滚到这一条、闪一下
  useEffect(() => {
    if (!focused) return
    row.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const timer = setTimeout(() => store.set((state) => ({ ...state, todoFocus: null })), 2400)
    return () => clearTimeout(timer)
  }, [focused])

  const saveText = () => {
    const text = editing?.trim()
    setEditing(null)
    if (text && text !== todo.text) void saveTodos((todos) => todos.map((item) => (item.id === todo.id ? { ...item, text } : item)))
  }
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
      data-done={todo.done}
      data-overdue={overdue}
    >
      {layout === 'list' && <TimeColumn todo={todo} now={now} overdue={overdue} onPick={schedule ? reschedule : pickTime} />}
      <Checkbox
        className="mt-0.5"
        aria-label={selecting ? `选中：${todo.text}` : `完成：${todo.text}`}
        checked={selecting ? selected : todo.done}
        onCheckedChange={() => (selecting ? onSelect?.() : void saveTodos((todos) => todos.map((item) => (item.id === todo.id ? { ...item, done: !item.done } : item))))}
      />
      <div className="min-w-0 flex-1">
        {editing !== null ? (
          <textarea
            autoFocus
            aria-label="编辑待办"
            value={editing}
            rows={Math.min(6, editing.split('\n').length)}
            className="w-full resize-none rounded-md border bg-background px-2 py-1 text-sm outline-none focus:border-ring/60"
            onChange={(event) => setEditing(event.target.value)}
            onBlur={saveText}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setEditing(null)
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                saveText()
              }
            }}
          />
        ) : (
          <p className={cn('text-sm break-words whitespace-pre-wrap', todo.done && 'text-muted-foreground line-through')} onDoubleClick={() => setEditing(todo.text)}>
            {todo.text}
          </p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
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
            <span className="text-foreground" data-testid="todo-finished">
              任务已完成，可以勾掉
            </span>
          )}
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
              onChange={(tags) => void saveTodos((todos) => todos.map((item) => (item.id === todo.id ? { ...item, tags } : item)))}
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
      {!selecting && editing === null && (
        <div className="flex shrink-0 items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <RowAction label="编辑" onClick={() => setEditing(todo.text)}>
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
          <RowAction label="删除" onClick={() => void saveTodos((todos) => todos.filter((item) => item.id !== todo.id))}>
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
          <span className="flex items-center gap-0.5 text-[11px] opacity-75">
            {schedule?.action.kind === 'send' ? <Send className="size-2.5" /> : <Bell className="size-2.5" />}
            {parts.day}
          </span>
        </button>
      ) : (
        <button type="button" aria-label="定时" title="定个时间" className="flex h-9 w-14 shrink-0 items-center rounded-md px-1.5 text-muted-foreground/50 hover:bg-accent hover:text-foreground">
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

