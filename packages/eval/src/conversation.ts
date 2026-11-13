import { randomUUID } from 'node:crypto'
import type { SessionConfig, SessionUpdate } from '@diffra/core/types'
import { core, startCore } from './core.ts'

// 一次评测运行里发生的事，按时间排：用户说的话、core 推来的会话更新、确认和提问怎么答的、用户点停止（第 615 步）。
// 原样写进 events.jsonl，过程记录（transcript.md）和各项判定都从这里算
export type EvalEvent =
  | { at: number; type: 'turn'; index: number; text: string; goal: boolean }
  | { at: number; type: 'update'; update: SessionUpdate }
  | { at: number; type: 'permission'; title: string; options: string[]; answer: string; question: boolean }
  | { at: number; type: 'cancel'; index: number }
  | { at: number; type: 'turn-end'; index: number; stopReason: string | null; error: string | null }

export interface TurnSpec {
  text: string
  goal: boolean
  cancelAfterSeconds?: number
}

export interface ConversationOptions {
  dataDir: string
  workDir: string
  config: SessionConfig
  turns: TurnSpec[]
  // 还要确认的操作怎么答
  permission: 'allow' | 'reject'
  // 智能体提问时按顺序怎么答：选标签里含这段文字的选项；对不上就选第一个
  answers: string[]
  timeoutMs: number
}

export interface ConversationResult {
  events: EvalEvent[]
  // 最后一轮的结束原因；超时是 timeout
  stopReason: string | null
  error: string | null
  permissionRequests: number
  questions: number
}

// 提问也走确认请求，按 rawInput 里的 scope 认出来。比较 v0.3.3 这类旧版本时 core 里没有这个常量，也不会有提问
const isQuestion = (rawInput: unknown) => {
  const scope = typeof rawInput === 'object' && rawInput !== null && 'scope' in rawInput ? rawInput.scope : undefined
  return scope !== undefined && scope === core.ASK_USER_SCOPE
}

const CANCEL_SETTLE_MS = 30_000

// 起一个 core 跑完整段对话：每一轮发出去等它结束，再发下一轮；总时长到了就停止
export async function runConversation(options: ConversationOptions): Promise<ConversationResult> {
  const started = Date.now()
  const events: EvalEvent[] = []
  const now = () => Date.now() - started
  let permissionRequests = 0
  let questions = 0
  let stopReason: string | null = null
  let error: string | null = null

  const coreProcess = await startCore(options.dataDir, {
    onSessionUpdate: (notification) => events.push({ at: now(), type: 'update', update: notification.update }),
    onPermissionRequest: async (request) => {
      const names = request.options.map((option) => option.name)
      const title = request.toolCall.title ?? ''
      if (isQuestion(request.toolCall.rawInput)) {
        const wanted = options.answers[questions]
        questions++
        // 答案按正则匹配选项标签，智能体同一个意思可能有不同说法（「支付|付款」）；「都不选」那个不算
        const pattern = wanted ? new RegExp(wanted) : null
        const picked = (pattern ? request.options.find((option) => option.kind !== 'reject_once' && pattern.test(option.name)) : undefined) ?? request.options[0]
        events.push({ at: now(), type: 'permission', title, options: names, answer: picked?.name ?? '（没有选项）', question: true })
        return picked ? { outcome: { outcome: 'selected', optionId: picked.optionId } } : { outcome: { outcome: 'cancelled' } }
      }
      permissionRequests++
      const kind = options.permission === 'allow' ? 'allow_once' : 'reject_once'
      const option = request.options.find((item) => item.kind === kind)
      events.push({ at: now(), type: 'permission', title, options: names, answer: option?.name ?? '（取消）', question: false })
      return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } }
    },
  })

  try {
    const { sessionId } = await core.createSession(coreProcess.connection, options.workDir, options.config)
    for (const [index, turn] of options.turns.entries()) {
      const remaining = options.timeoutMs - now()
      if (remaining <= 0) {
        stopReason = 'timeout'
        break
      }
      events.push({ at: now(), type: 'turn', index, text: turn.text, goal: turn.goal })
      const prompt = core.sendPrompt(coreProcess.connection, sessionId, randomUUID(), turn.text, { goal: turn.goal })
      const timers: NodeJS.Timeout[] = []
      const waitFor = (ms: number, value: 'timeout' | 'cancel') => new Promise<typeof value>((resolve) => timers.push(setTimeout(() => resolve(value), ms)))
      const races: Promise<Awaited<typeof prompt> | 'timeout' | 'cancel'>[] = [prompt, waitFor(remaining, 'timeout')]
      if (turn.cancelAfterSeconds) races.push(waitFor(turn.cancelAfterSeconds * 1000, 'cancel'))
      let outcome: Awaited<(typeof races)[number]>
      try {
        outcome = await Promise.race(races)
      } catch (caught) {
        for (const timer of timers) clearTimeout(timer)
        error = caught instanceof Error ? caught.message : String(caught)
        events.push({ at: now(), type: 'turn-end', index, stopReason: null, error })
        break
      }
      for (const timer of timers) clearTimeout(timer)
      if (outcome === 'timeout' || outcome === 'cancel') {
        if (outcome === 'cancel') events.push({ at: now(), type: 'cancel', index })
        await core.cancelSession(coreProcess.connection, sessionId)
        const settled = await Promise.race([prompt.catch(() => null), new Promise<null>((resolve) => setTimeout(() => resolve(null), CANCEL_SETTLE_MS))])
        stopReason = outcome === 'timeout' ? 'timeout' : (settled?.stopReason ?? 'cancelled')
        events.push({ at: now(), type: 'turn-end', index, stopReason, error: null })
        if (outcome === 'timeout') break
        continue
      }
      stopReason = outcome.stopReason
      events.push({ at: now(), type: 'turn-end', index, stopReason, error: null })
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  } finally {
    coreProcess.stop()
  }
  if (coreProcess.stderr().trim() && error) error = `${error}\n${coreProcess.stderr().trim().slice(-2000)}`
  return { events, stopReason, error, permissionRequests, questions }
}

export const updatesOf = (events: EvalEvent[]): SessionUpdate[] => events.flatMap((event) => (event.type === 'update' ? [event.update] : []))
