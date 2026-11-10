import { useState } from 'react'
import { AlarmClock, X } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { formatDue } from '@/lib/todo-time'
import { useNow } from '@/lib/use-now'
import { addTodo } from '@/state/actions'
import { SchedulePicker } from './SchedulePicker'

// 记待办的输入框：回车保存；旁边的闹钟先定个提醒时间（定时发送在记下以后从那一条上设）。defaultAt 是日历里选中的那天
export function TodoInput({ autoFocus = false, placeholder = '记下一个点子，回车保存', defaultAt, className }: { autoFocus?: boolean; placeholder?: string; defaultAt?: Date; className?: string }) {
  const [draft, setDraft] = useState('')
  const [at, setAt] = useState<Date | null>(null)
  const now = useNow()
  const due = at ?? defaultAt ?? null
  const submit = () => {
    if (!draft.trim()) return
    void addTodo(draft, due ?? undefined)
    setDraft('')
    setAt(null)
  }
  return (
    <div className={cn('flex h-11 w-full items-center gap-1 rounded-xl border bg-background pr-1.5 pl-4 focus-within:border-ring/60', className)}>
      <input
        aria-label="新待办"
        value={draft}
        autoFocus={autoFocus}
        placeholder={placeholder}
        className="h-full min-w-0 flex-1 bg-transparent outline-none"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
          event.preventDefault()
          submit()
        }}
      />
      {at && (
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-soft px-2 py-0.5 text-xs" data-testid="todo-input-due">
          提醒 {formatDue(at.toISOString(), now)}
          <button type="button" aria-label="不定时间" className="text-muted-foreground hover:text-foreground" onClick={() => setAt(null)}>
            <X className="size-3" />
          </button>
        </span>
      )}
      <SchedulePicker value={due} onPick={(picked) => setAt(picked)}>
        <Button variant="ghost" size="icon-sm" aria-label="定个提醒时间" className="text-muted-foreground">
          <AlarmClock className="size-4" />
        </Button>
      </SchedulePicker>
    </div>
  )
}
