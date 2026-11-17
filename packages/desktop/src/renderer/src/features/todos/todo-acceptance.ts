import type { VerdictTone } from '@/lib/turn-verdict'
import { turnVerdict } from '@/lib/turn-verdict'
import type { LiveTask } from '@/state/store'

// 这些结论表示这一轮做完了；待办派出去的任务到了这里就可以验收
export const FINISHED_TODO_TASK_TONES = new Set<VerdictTone>(['done'])

export function taskFinishedForTodo(task: LiveTask | undefined): boolean {
  return task ? FINISHED_TODO_TASK_TONES.has(turnVerdict(task).tone) : false
}
