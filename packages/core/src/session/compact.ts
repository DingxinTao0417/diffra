import { randomUUID } from 'node:crypto'
import { type ModelMessage, streamText } from 'ai'
import { contextOverflowError, toModelError } from '../models/errors.js'
import { MODEL_CALL_HEADERS } from '../models/operations.js'
import { streamParts } from '../models/stream.js'
import { truncateForModel } from '../process.js'
import { DEFAULT_CONTEXT_WINDOW, type ActiveModel, type TurnIO } from './loop.js'
import type { StopReason, UsageCache } from '../protocol.js'
import { messagesChars, type Session } from './session.js'
import { isWorldStateMessage } from './world-state.js'

// 上下文压缩（第 512 步起参照 Codex）：用量到触发点时让编码模型写一份交接摘要。之后发给模型的只有用户说过的话
// （从最近往前，最多约 2 万 token，原话）、交接摘要，和重新补上的环境、AGENTS.md（见 world-state.ts）；
// 工具调用、输出和模型的回复都不再发。messages 保留原文，撤销、重新生成照常按位置截断

// 触发点最高是窗口的 90%；压缩后还超过 95%，再跑下去会被模型拒绝，只能停下（Codex 的默认值）
const MAX_COMPACT_RATIO = 0.9
const HARD_STOP_RATIO = 0.95
const USER_MESSAGES_MAX_TOKENS = 20_000
// 压缩之后这么多步内不再压缩，免得用户的话本身就很长时每一步都压一遍
const COOLDOWN_STEPS = 3
const MANUAL_COMPACTION_TIMEOUT_MS = 5 * 60_000
// 写摘要的请求本身超出窗口时，从最早的消息开始丢，最多重试这么多次
const MAX_OVERFLOW_RETRIES = 5

const SUMMARY_REQUEST = [
  '[Diffra] You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another model that will resume this task from your summary and the user\'s messages alone.',
  'Include:',
  '- current progress and key decisions made, and why;',
  '- important context, constraints and user preferences;',
  '- files changed and what was changed in each; commands or processes still running (with their session IDs);',
  '- verification: which checks and tests were run and what they showed, which were not run yet;',
  '- what remains to be done, with clear next steps; approaches that failed and why, so they are not tried again;',
  '- critical data needed to continue: exact paths, names, error messages, values; and the path of each SKILL.md you were following.',
  'Be concise and structured. Do not call tools. Write in the language the user writes in.',
].join('\n')

export interface CompactionState {
  // 在这一步之前不再压缩
  cooldownUntil: number
}

export type CompactionOutcome = { kind: 'ok' } | { kind: 'compacted' } | { kind: 'too-large' } | { kind: 'failed'; message: string } | { kind: 'cancelled' }

// 发给编码模型的字数：系统提示词、工具定义和对话，用来按比例估算 token 数
export function contextChars(session: Session): number {
  return session.systemPrompt.length + session.toolChars() + messagesChars(session.contextMessages())
}

// 用上一次调用的实际输入 token 数，按字数比例估算下一次调用的大小；还没调用过时不知道
export function estimateContextTokens(session: Session): number | null {
  const last = session.lastContext
  if (!last || last.chars === 0) return null
  return Math.round((last.inputTokens * contextChars(session)) / last.chars)
}

interface LastUsage {
  used: number
  cacheRead: number | null
  cacheWrite: number | null
  cacheInput: number
}

// 刚启动或重启后 lastContext 还是空的，从存下来的更新里找最近一次上下文用量
function latestUsage(session: Session): LastUsage | null {
  for (let turnIndex = session.turns.length - 1; turnIndex >= 0; turnIndex--) {
    const updates = session.turns[turnIndex]?.updates ?? []
    for (let updateIndex = updates.length - 1; updateIndex >= 0; updateIndex--) {
      const update = updates[updateIndex]
      if (update?.sessionUpdate !== 'usage_update' || update.used <= 0) continue
      const meta = update._meta as
        | {
            cache?: { read?: unknown; write?: unknown; input?: unknown }
            diffra?: { cache?: { read?: unknown; write?: unknown; input?: unknown }; cacheRead?: unknown; cacheWrite?: unknown; cacheInput?: unknown }
          }
        | null
        | undefined
      const cache = meta?.cache ?? meta?.diffra?.cache
      return {
        used: update.used,
        cacheRead: typeof cache?.read === 'number' ? cache.read : typeof meta?.diffra?.cacheRead === 'number' ? meta.diffra.cacheRead : null,
        cacheWrite: typeof cache?.write === 'number' ? cache.write : typeof meta?.diffra?.cacheWrite === 'number' ? meta.diffra.cacheWrite : null,
        cacheInput:
          typeof cache?.input === 'number' ? cache.input : typeof meta?.diffra?.cacheInput === 'number' ? meta.diffra.cacheInput : update.used,
      }
    }
  }
  return null
}

function cacheUsageOf(session: Session, previous: LastUsage | null): UsageCache {
  if (session.lastContext) return { read: session.lastContext.cacheRead, write: session.lastContext.cacheWrite, input: session.lastContext.inputTokens }
  return { read: previous?.cacheRead ?? null, write: previous?.cacheWrite ?? null, input: previous?.cacheInput ?? previous?.used ?? 0 }
}

// 压缩后按减少的字数比例折算上下文用量，让界面上的百分比马上跟着变；没有上次实际用量时发不了
async function emitCompactedUsage(
  session: Session,
  io: TurnIO,
  beforeChars: number,
  beforeUsed: number | null,
  cache: UsageCache,
): Promise<void> {
  if (beforeUsed === null || beforeChars <= 0) return
  const afterChars = contextChars(session)
  if (afterChars >= beforeChars) return
  const used = Math.max(1, Math.round((beforeUsed * afterChars) / beforeChars))
  await io.update({
    sessionUpdate: 'usage_update',
    used,
    size: session.config.model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    _meta: { diffra: session.usageBreakdown(used), cache },
  })
}

// 上次压缩之后有没有新的东西可压
function hasNewHistory(session: Session): boolean {
  const start = session.compaction?.upTo ?? 0
  return session.messages.slice(start).some((message) => message.role === 'assistant')
}

// 每次调用编码模型前检查：估算超过触发点就压缩
export async function compactIfNeeded(
  session: Session,
  // model：这一轮在用的编码模型，摘要也由它写
  options: { window: number; step: number; state: CompactionState; model: ActiveModel },
  signal: AbortSignal,
  io: TurnIO,
): Promise<CompactionOutcome> {
  const { window, step, state } = options
  const threshold = window * Math.min(session.config.limits.compactAtPercent / 100, MAX_COMPACT_RATIO)
  const estimate = estimateContextTokens(session)
  if (estimate === null || estimate <= threshold) return { kind: 'ok' }
  if (step < state.cooldownUntil || !hasNewHistory(session)) return estimate > window * HARD_STOP_RATIO ? { kind: 'too-large' } : { kind: 'ok' }
  state.cooldownUntil = step + COOLDOWN_STEPS

  const percent = Math.round((estimate / window) * 100)
  const toolCallId = randomUUID()
  await io.update({ sessionUpdate: 'tool_call', toolCallId, title: '上下文压缩', kind: 'other', status: 'in_progress' })
  const finishCard = (status: 'completed' | 'failed', text: string) =>
    io.update({ sessionUpdate: 'tool_call_update', toolCallId, status, content: [{ type: 'content', content: { type: 'text', text } }] })
  const charsBefore = contextChars(session)
  const cut = session.messages.length
  try {
    const summary = await summarize(session, options.model, signal, io)
    session.compaction = { upTo: cut, summary: summaryMessage(session, cut, summary) }
    // 压缩拖了一会儿才结束，界面上的上下文百分比这时就更新，不用等下一次模型调用
    await emitCompactedUsage(session, io, charsBefore, estimate, cacheUsageOf(session, latestUsage(session)))
    await finishCard('completed', `上下文用到约 ${percent}%。之前的对话压缩成了下面的交接摘要，你说过的话原样保留。\n\n${summary}`)
    const after = estimateContextTokens(session)
    return after !== null && after > window * HARD_STOP_RATIO ? { kind: 'too-large' } : { kind: 'compacted' }
  } catch (error) {
    if (signal.aborted) {
      await finishCard('failed', '已停止')
      return { kind: 'cancelled' }
    }
    console.error('[session] 上下文压缩失败', error)
    const message = toModelError(error, options.model.config.endpoint.apiKey, 0).message
    await finishCard('failed', `压缩失败：${message}`)
    return { kind: 'failed', message }
  }
}

// 手动压缩：不看百分比。失败和取消都不改变上下文
export async function compactManually(session: Session, io: TurnIO): Promise<StopReason> {
  if (session.running) throw new Error('任务还在进行中，结束后再压缩上下文')
  const controller = session.activateTurn()
  const timeoutSignal = AbortSignal.timeout(MANUAL_COMPACTION_TIMEOUT_MS)
  const signal = AbortSignal.any([controller.signal, timeoutSignal])
  const toolCallId = randomUUID()
  const finishCard = (status: 'completed' | 'failed', text: string) =>
    io.update({ sessionUpdate: 'tool_call_update', toolCallId, status, content: [{ type: 'content', content: { type: 'text', text } }] })
  try {
    await io.update({ sessionUpdate: 'tool_call', toolCallId, title: '上下文压缩', kind: 'other', status: 'in_progress' })
    // 压缩前后都按同一套字数估算；重启后 lastContext 为空时用存下来的最近一次用量
    const beforeChars = contextChars(session)
    const previous = latestUsage(session)
    const beforeUsed = estimateContextTokens(session) ?? previous?.used ?? null
    if (!hasNewHistory(session)) {
      await finishCard('completed', '上次压缩之后还没有新的对话，没有可压缩的内容；未调用模型，原文保持不变。')
      return signal.aborted ? 'cancelled' : 'end_turn'
    }
    if (signal.aborted) {
      await finishCard('failed', '已停止，原上下文保持不变。')
      return 'cancelled'
    }
    const cut = session.messages.length
    const before = messagesChars(session.contextMessages())
    const active: ActiveModel = { language: session.model, config: session.config.model }
    let summary: string
    // 仅将模型摘要请求的失败转成压缩卡片；通知/状态更新错误交由调用方处理。
    try {
      summary = await summarize(session, active, signal, io)
    } catch (error) {
      if (signal.aborted) {
        await finishCard('failed', timeoutSignal.aborted ? '压缩超时，原上下文保持不变。' : '已停止，原上下文保持不变。')
        return 'cancelled'
      }
      if (!(error instanceof Error)) throw new Error('模型摘要请求返回了非标准错误', { cause: error })
      console.error(`[session] 会话 ${session.id} 模型摘要请求失败`, error)
      await finishCard('failed', `压缩失败，原上下文保持不变：${toModelError(error, session.config.model.endpoint.apiKey, 0).message}`)
      return 'end_turn'
    }
    if (signal.aborted) {
      await finishCard('failed', '已停止，原上下文保持不变。')
      return 'cancelled'
    }
    const content = summaryMessage(session, cut, summary)
    const after = messagesChars([{ role: 'user', content }])
    if (after >= before) {
      await finishCard('completed', '摘要没有让上下文变短，已保留原上下文。')
      return 'end_turn'
    }
    session.compaction = { upTo: cut, summary: content }
    await emitCompactedUsage(session, io, beforeChars, beforeUsed, cacheUsageOf(session, previous))
    await finishCard('completed', `已手动压缩上下文（对话约 ${before.toLocaleString()} → ${after.toLocaleString()} 字），你说过的话原样保留。历史记录不变。\n\n${summary}`)
    return 'end_turn'
  } finally {
    session.activeTurn = null
  }
}

// 用编码模型写摘要：发过去的是现在的对话加一条要求，前缀和刚才的请求一样，能用上提示词缓存。
// 请求本身超出窗口时从最早的消息开始丢（Codex 的做法），每次丢一成：在用户消息或模型回复处切开，工具调用和它的结果不拆开；
// 从模型回复切开时前面补一句说明，对话照旧以用户消息开头
const TRIMMED_NOTE = '[Diffra] Earlier messages were left out to fit the context window.'
async function summarize(session: Session, model: ActiveModel, signal: AbortSignal, io: TurnIO): Promise<string> {
  let context = session.contextMessages()
  for (let retries = 0; ; retries++) {
    try {
      return await requestSummary(session, model, context, signal, io)
    } catch (error) {
      if (signal.aborted || !contextOverflowError(error) || retries >= MAX_OVERFLOW_RETRIES) throw error
      let start = Math.max(1, Math.ceil(context.length / 10))
      while (start < context.length && context[start]?.role === 'tool') start++
      if (start >= context.length) throw error
      const rest = context.slice(start)
      context = rest[0]?.role === 'user' ? rest : [{ role: 'user', content: TRIMMED_NOTE }, ...rest]
    }
  }
}

async function requestSummary(session: Session, model: ActiveModel, context: ModelMessage[], signal: AbortSignal, io: TurnIO): Promise<string> {
  const attempt = new AbortController()
  const result = streamText({
    model: model.language,
    system: session.systemPrompt,
    messages: [...context, { role: 'user', content: SUMMARY_REQUEST }],
    tools: session.toolSet(),
    toolChoice: 'none',
    maxRetries: 2,
    abortSignal: AbortSignal.any([signal, attempt.signal]),
    headers: MODEL_CALL_HEADERS,
  })
  let text = ''
  for await (const part of streamParts(result.fullStream, () => attempt.abort())) {
    if (part.type === 'text-delta') text += part.text
    if (part.type === 'finish-step') {
      await io.recordUsage({ role: 'coder', provider: model.config.provider, modelId: model.config.modelId, usage: part.usage })
    }
  }
  if (!text.trim()) throw new Error('模型没有返回摘要')
  return text.trim()
}

function messageText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content.map((part) => (part.type === 'text' ? part.text : part.type === 'image' ? '[image]' : '')).join('')
}

// 用户每一轮的提问（每一轮开始处第一条不是上下文的用户消息），在 cut 之前的，按时间顺序
function userRequests(session: Session, cut: number): string[] {
  const starts = [...new Set(session.messageStarts.values())].filter((start) => start < cut).sort((a, b) => a - b)
  const texts: string[] = []
  for (const start of starts) {
    for (let index = start; index < cut; index++) {
      const message = session.messages[index]
      if (message?.role !== 'user' || isWorldStateMessage(message)) continue
      texts.push(messageText(message))
      break
    }
  }
  return texts
}

// 从最近往前取，合计不超过 USER_MESSAGES_MAX_TOKENS；最早那条放不下时截短
function keptUserMessages(texts: string[]): string[] {
  const kept: string[] = []
  let budget = USER_MESSAGES_MAX_TOKENS
  for (let index = texts.length - 1; index >= 0 && budget > 0; index--) {
    const shortened = truncateForModel(texts[index]!, budget)
    kept.unshift(shortened.text)
    budget -= Math.min(shortened.originalTokens, budget)
  }
  return kept
}

// 摘要消息：用户说过的话（原文）在前，交接摘要在后
function summaryMessage(session: Session, cut: number, summary: string): string {
  const requests = keptUserMessages(userRequests(session, cut))
  return [
    '[Diffra] Earlier parts of this conversation were compacted to save context.',
    ...(requests.length > 0
      ? ['', 'Messages the user sent, oldest first (verbatim; older ones may be left out):', ...requests.map((text) => `<user_message>\n${text}\n</user_message>`)]
      : []),
    '',
    'Another model worked on this task before you and wrote this handoff summary. Build on it and do not redo finished work; files and running processes are as it left them:',
    summary,
    '',
    'Continue from the current state without acknowledging or recapping this summary. Read again the SKILL.md of any skill it says you were following before you rely on it.',
  ].join('\n')
}
