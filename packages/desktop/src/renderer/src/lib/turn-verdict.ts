import type { StopReason, TurnStop } from '@diffra/core/types'
import type { TranscriptItem } from '@/features/session/transcript'
import type { LiveTask } from '@/state/store'

export type VerdictTone = 'confirm' | 'running' | 'error' | 'waiting' | 'blocked' | 'failed' | 'stopped' | 'unfinished' | 'unverified' | 'verified' | 'nochange' | 'done' | 'idle'

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
  unfinished: '未完成 · 未验证',
  unverified: '已完成 · 未经自动验证',
  verified: '已完成 · 已验证',
  nochange: '已完成 · 没有改动',
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

// 和 core 撤销时写进任务状态的原因相同
const RESTORED_REASON = '文件已撤销，需要重新验证完成条件。'

function verdict(tone: VerdictTone, reason: string | null = null): Verdict {
  return { label: LABELS[tone], tone, reason }
}

function isStoppedBy(stop: TurnStop | null): stop is StoppedBy {
  return stop !== null && Object.hasOwn(STOPPED, stop)
}

// 顶栏和任务监控共用的本轮结论，按顺序取第一条命中的，同一时刻只显示一个词。
// 结论看最后一个 prompt 或 goal 轮；plan、deep-scan、compact 轮不经过主循环、没有 turnOutcome，只参与出错和用户停止的判定
export function turnVerdict(task: Pick<LiveTask, 'permission' | 'running' | 'turns' | 'progress'>): Verdict {
  if (task.permission) return verdict('confirm')
  if (task.running) return verdict('running')
  const last = task.turns.at(-1)
  if (!last) return verdict('idle')
  const subject = task.turns.findLast((turn) => turn.kind === 'prompt' || turn.kind === 'goal')
  const outcome = subject?.outcome
  const stop = outcome?.stop ?? null
  const progress = task.progress
  if (last.error && !last.restoredAt) return verdict('error')
  // 结论那一轮或之后撤销过：文件变了，原来的完成或停止都不再算数
  if (subject && task.turns.slice(task.turns.indexOf(subject)).some((turn) => turn.restoredAt)) return verdict('unfinished', progress?.reason ?? RESTORED_REASON)
  if (stop === 'model-error') return verdict('error')
  if (progress?.status === 'waiting') return verdict('waiting')
  if (progress?.status === 'blocked' && (stop === 'paused' || progress.requirements.some((item) => !item.receiptId))) return verdict('blocked', progress.reason)
  if (stop === 'gate-exhausted' || stop === 'check-exhausted') return verdict('failed')
  if (last.stopReason === 'cancelled' || progress?.status === 'cancelled') return verdict('stopped', STOPPED.cancelled)
  if (isStoppedBy(stop)) return verdict('stopped', STOPPED[stop])
  const legacy = subject !== undefined && outcome === undefined
  const legacyStop = legacy && subject.stopReason ? LEGACY_STOPPED[subject.stopReason] : undefined
  if (legacyStop) return verdict('stopped', legacyStop)
  // 改了文件没调 finish；或撤销之后 core 把状态改回 blocked，要求重新验证
  if (stop === 'no-finish' || (progress?.status === 'blocked' && progress.needsVerification)) return verdict('unfinished', progress?.reason ?? null)
  if (outcome?.finish === 'unverified') return verdict('unverified')
  if (outcome?.finish === 'verified') return verdict('verified')
  if (outcome?.finish === 'no-edits') return verdict('nochange')
  // 旧记录永远不显示已验证：完成卡带 unverified 标记的算未经自动验证，其余只说已完成
  if (legacy && subject.items.findLast((item): item is ToolItem => item.kind === 'tool' && item.title === '完成')?.unverified) return verdict('unverified')
  return verdict('done')
}

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

// 每张完成卡按自己的 verification 出词；没有这个字段的旧卡按 unverified 标记和状态推
export function finishVerdict(item: Pick<ToolItem, 'status' | 'verification' | 'unverified'>): Pick<Verdict, 'label' | 'tone'> {
  const verification = item.verification ?? (item.status === 'failed' ? 'failed' : item.unverified ? 'unverified' : null)
  if (verification === 'verified' || verification === 'reused') return { label: LABELS.verified, tone: 'verified' }
  if (verification === 'unverified') return { label: LABELS.unverified, tone: 'unverified' }
  if (verification === 'no-edits') return { label: LABELS.nochange, tone: 'nochange' }
  if (verification === 'failed') return { label: '还没完成', tone: 'failed' }
  return { label: LABELS.done, tone: 'done' }
}
