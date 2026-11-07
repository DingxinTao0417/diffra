import type { LiveTask } from '@/state/store'

export type TaskStatusTone = 'confirm' | 'running' | 'error' | 'waiting' | 'blocked' | 'stopped' | 'done' | 'idle'

export interface TaskStatus {
  label: string
  tone: TaskStatusTone
}

// 顶栏和任务监控共用这一套词，同一时刻只显示一个词
export function taskStatus(task: Pick<LiveTask, 'permission' | 'running' | 'turns' | 'progress'>): TaskStatus {
  if (task.permission) return { label: '等待确认', tone: 'confirm' }
  if (task.running) return { label: '运行中', tone: 'running' }
  const last = task.turns.at(-1)
  if (last?.error) return { label: '出错', tone: 'error' }
  const progress = task.progress
  if (progress?.status === 'waiting') return { label: '等待中', tone: 'waiting' }
  if (progress?.status === 'cancelled' || last?.stopReason === 'cancelled') return { label: '已停止', tone: 'stopped' }
  // 每轮没调 finish 结束时 core 都会记成 blocked；只有定义了完成条件且还有没完成的，才算受阻
  if ((progress?.status === 'blocked' || progress?.status === 'running') && progress.requirements.some((item) => !item.receiptId)) {
    return { label: '受阻（未完成）', tone: 'blocked' }
  }
  if (task.turns.length > 0) return { label: '已完成', tone: 'done' }
  return { label: '未开始', tone: 'idle' }
}
