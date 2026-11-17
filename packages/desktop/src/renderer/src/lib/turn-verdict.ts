import type { StopReason, TurnStop } from '@diffra/core/types'
import type { LiveTask } from '@/state/store'

export type VerdictTone = 'confirm' | 'running' | 'error' | 'waiting' | 'blocked' | 'failed' | 'stopped' | 'unfinished' | 'done' | 'idle'

export interface Verdict {
  label: string
  tone: VerdictTone
  // 悬停说明：已停止的原因，受阻和未完成时 core 写的原因
  reason: string | null
}

const LABELS: Record<VerdictTone, string> = {
  confirm: '等待确认',
  running: '运行中',
  error: '出错',
  waiting: '等待中',
  blocked: '受阻（未完成）',
  failed: '未完成 · 验证未通过',
  stopped: '已停止',
  unfinished: '未完成',
  done: '已完成',
  idle: '未开始',
}

type StoppedBy = Extract<TurnStop, 'cancelled' | 'stuck' | 'step-limit' | 'context-limit' | 'goal-exhausted'>

const STOPPED: Record<StoppedBy, string> = {
  cancelled: '这一轮没跑完就停止了，任务并未完成',
  stuck: '智能体反复做同样的操作，已自动停下',
  'step-limit': '达到了单次任务的步数上限',
  'context-limit': '上下文太大，压缩后仍然放不下',
  'goal-exhausted': '目标模式的轮数用完了，目标还没完成',
}

// 旧记录没有 turnOutcome，停止原因只能从 ACP 的 stopReason 看
const LEGACY_STOPPED: Partial<Record<StopReason, string>> = {
  max_tokens: STOPPED['context-limit'],
  max_turn_requests: STOPPED['step-limit'],
  refusal: '模型拒绝继续回答',
}

// core 撤销时按状态写原因；拿不到任务状态时不知道还要验证什么，只说原来的结论作废
const RESTORED_REASON = '文件已撤销，原来的结论不再算数。'

function verdict(tone: VerdictTone, reason: string | null = null): Verdict {
  return { label: LABELS[tone], tone, reason }
}

function isStoppedBy(stop: TurnStop | null): stop is StoppedBy {
  return stop !== null && Object.hasOwn(STOPPED, stop)
}

// 顶栏和任务监控共用的本轮结论，按顺序取第一条命中的，同一时刻只显示一个词。
// 结论看最后一个 prompt 或 goal 轮；plan、deep-scan、compact 轮不经过主循环、没有 turnOutcome，只参与出错和用户停止的判定。
// 定位轮（diagnose）只是查原因，完全不算：它出错、被停止都不改变任务结论
export function turnVerdict(task: Pick<LiveTask, 'permission' | 'running' | 'turns' | 'progress'>): Verdict {
  if (task.permission) return verdict('confirm')
  if (task.running) return verdict('running')
  const last = task.turns.findLast((turn) => turn.kind !== 'diagnose')
  if (!last) return verdict('idle')
  const subject = task.turns.findLast((turn) => turn.kind === 'prompt' || turn.kind === 'goal')
  const outcome = subject?.outcome
  const stop = outcome?.stop ?? null
  const progress = task.progress
  if (last.error && !last.restoredAt) return verdict('error')
  // 结论那一轮或之后撤销过：文件变了，原来的完成或停止都不再算数
  if (subject && task.turns.slice(task.turns.indexOf(subject)).some((turn) => turn.restoredAt)) return verdict('unfinished', progress?.reason ?? RESTORED_REASON)
  if (stop === 'model-error' || stop === 'agent-error') return verdict('error', outcome?.agentError?.message ?? null)
  if (progress?.status === 'waiting') return verdict('waiting')
  if (progress?.status === 'blocked' && (stop === 'paused' || progress.requirements.some((item) => !item.receiptId))) return verdict('blocked', progress.reason)
  // 以前结束门禁的检查卡住停下，只有旧记录里有
  if (stop === 'gate-exhausted' || stop === 'check-exhausted') return verdict('failed')
  if (last.stopReason === 'cancelled' || progress?.status === 'cancelled') return verdict('stopped', STOPPED.cancelled)
  if (isStoppedBy(stop)) return verdict('stopped', STOPPED[stop])
  const legacy = subject !== undefined && outcome === undefined
  const legacyStop = legacy && subject.stopReason ? LEGACY_STOPPED[subject.stopReason] : undefined
  if (legacyStop) return verdict('stopped', legacyStop)
  // 旧记录里改了文件没调 finish；或者这一轮停在 blocked（比如应用了候选方案、回答里的补丁），原因由 core 写
  if (stop === 'no-finish' || progress?.status === 'blocked') return verdict('unfinished', progress?.reason ?? null)
  return verdict('done')
}
