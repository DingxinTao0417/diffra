import { cn } from 'cn'
import type { TodoPriority } from '../../../../shared/todos'

// P0 最醒目（destructive），P1 次之（warning），P2、P3 用中性色；不用 success、primary
const PRIORITY_STYLES: Record<TodoPriority, string> = {
  0: 'bg-destructive-soft text-destructive',
  1: 'bg-warning-soft text-warning',
  2: 'bg-soft text-foreground',
  3: 'border text-muted-foreground',
}

export const priorityLabel = (priority: TodoPriority) => `P${priority}`

// 列表里排在前面：P0 最前，没设的最后
export const priorityRank = (priority: TodoPriority | null | undefined) => priority ?? 4

export function PriorityBadge({ priority, className }: { priority: TodoPriority; className?: string }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center rounded px-1 text-[11px] leading-4 font-bold tabular-nums', PRIORITY_STYLES[priority], className)} data-testid="todo-priority">
      {priorityLabel(priority)}
    </span>
  )
}
