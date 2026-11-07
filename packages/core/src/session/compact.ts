import { randomUUID } from 'node:crypto'
import { type ModelMessage, streamText, type ToolResultPart } from 'ai'
import { toModelError } from '../models/errors.js'
import { MODEL_CALL_HEADERS } from '../models/operations.js'
import type { ActiveModel, TurnIO } from './loop.js'
import type { Session } from './session.js'

// 最近这么多步（模型的回复和它调用工具的结果）原样保留，压缩只动更早的部分
export const KEEP_RECENT_STEPS = 4
// 短于这么多字的工具输出不值得省略
const MIN_OMITTED_CHARS = 500
// 压缩之后这么多步内不再压缩，免得最近几步本身就很大时每一步都压一遍
const COOLDOWN_STEPS = 3
// 压缩后还超过窗口的这个比例，再跑下去就会被模型拒绝，只能停下
const HARD_STOP_RATIO = 0.95
const OMITTED_PREFIX = '[Output omitted by Diffra'

const SUMMARY_REQUEST = [
  '[Diffra] The conversation is too long for the context window. Write a summary that will replace everything above this message.',
  'Work will continue from your summary alone, so include everything needed to continue:',
  '- what the user asked for, and every constraint or preference they stated;',
  '- decisions made and why;',
  '- files read or changed, and what was changed in each;',
  '- the current state: what is done, what is in progress, what remains;',
  '- errors met, and whether they are solved.',
  'Be specific: file paths, function names, commands. Do not call tools. Write in the language the user writes in.',
].join('\n')

export interface CompactionState {
  // 在这一步之前不再压缩
  cooldownUntil: number
}

export type CompactionOutcome = { kind: 'ok' } | { kind: 'too-large' } | { kind: 'failed'; message: string } | { kind: 'cancelled' }

// 发给编码模型的字数：系统提示词、工具定义和对话，用来按比例估算 token 数
export function contextChars(session: Session): number {
  return session.systemPrompt.length + session.toolChars() + JSON.stringify(session.contextMessages()).length
}

// 用上一次调用的实际输入 token 数，按字数比例估算下一次调用的大小；还没调用过时不知道
export function estimateContextTokens(session: Session): number | null {
  const last = session.lastContext
  if (!last || last.chars === 0) return null
  return Math.round((last.inputTokens * contextChars(session)) / last.chars)
}

// 每次调用编码模型前检查：估算超过触发点时，先省略较早的工具输出，还不够再把早期对话压成摘要
export async function compactIfNeeded(
  session: Session,
  // requestIndex：这一轮的提问在 messages 里的位置；model：这一轮在用的编码模型，摘要也由它写
  options: { window: number; requestIndex: number; step: number; state: CompactionState; model: ActiveModel },
  signal: AbortSignal,
  io: TurnIO,
): Promise<CompactionOutcome> {
  const { window, step, state } = options
  const threshold = (window * session.config.limits.compactAtPercent) / 100
  const estimate = estimateContextTokens(session)
  if (estimate === null || estimate <= threshold) return { kind: 'ok' }
  if (step < state.cooldownUntil) return estimate > window * HARD_STOP_RATIO ? { kind: 'too-large' } : { kind: 'ok' }
  state.cooldownUntil = step + COOLDOWN_STEPS

  const percent = Math.round((estimate / window) * 100)
  const toolCallId = randomUUID()
  await io.update({ sessionUpdate: 'tool_call', toolCallId, title: '上下文压缩', kind: 'other', status: 'in_progress' })
  const finishCard = (status: 'completed' | 'failed', text: string) =>
    io.update({ sessionUpdate: 'tool_call_update', toolCallId, status, content: [{ type: 'content', content: { type: 'text', text } }] })

  const charsBefore = contextChars(session)
  const omitted = omitOldToolOutputs(session)
  const omittedNote = omitted.count > 0 ? `省略了 ${omitted.count} 个较早的工具输出（约 ${omitted.chars} 字），智能体需要时会重新读取。` : ''
  const afterOmitting = (estimate * contextChars(session)) / charsBefore
  if (afterOmitting <= threshold) {
    await finishCard('completed', `上下文用到约 ${percent}%。${omittedNote}`)
    return { kind: 'ok' }
  }

  const cut = recentStepsStart(session.messages, session.compaction?.upTo ?? 0)
  if (cut === null) {
    await finishCard('completed', `上下文用到约 ${percent}%。${omittedNote}更早的对话已经压缩过，剩下的都是最近几步，没法再压。`)
    return afterOmitting > window * HARD_STOP_RATIO ? { kind: 'too-large' } : { kind: 'ok' }
  }
  try {
    const summary = await summarize(session, options.model, cut, signal, io)
    session.compaction = { upTo: cut, summary: summaryMessage(session, options.requestIndex, cut, summary) }
    await finishCard('completed', `上下文用到约 ${percent}%。${omittedNote}较早的对话压缩成了下面的摘要，最近 ${KEEP_RECENT_STEPS} 步保留原文。\n\n${summary}`)
    return { kind: 'ok' }
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

// 把压缩点之后、最近几步之前的长工具输出换成一句占位；原地修改，界面上的历史存在每轮的更新里，不受影响
function omitOldToolOutputs(session: Session): { count: number; chars: number } {
  const start = session.compaction?.upTo ?? 0
  const end = recentStepsStart(session.messages, start) ?? start
  let count = 0
  let chars = 0
  for (let index = start; index < end; index++) {
    const message = session.messages[index]
    if (message?.role !== 'tool') continue
    const content = message.content.map((part) => {
      if (part.type !== 'tool-result') return part
      const output = part.output
      if ((output.type !== 'text' && output.type !== 'error-text') || output.value.length < MIN_OMITTED_CHARS || output.value.startsWith(OMITTED_PREFIX)) {
        return part
      }
      count++
      chars += output.value.length
      const value = `${OMITTED_PREFIX} to save context (${output.value.length} characters). Run the tool again if you need it.]`
      return { ...part, output: { type: output.type, value } } satisfies ToolResultPart
    })
    session.messages[index] = { ...message, content }
  }
  return { count, chars }
}

// 最近 KEEP_RECENT_STEPS 步从哪里开始：倒数第 N 条模型回复的位置。从模型回复处切开，工具调用和它的结果不会被拆开。
// 压缩点之后不够这么多步时返回 null
function recentStepsStart(messages: ModelMessage[], from: number): number | null {
  let seen = 0
  for (let index = messages.length - 1; index > from; index--) {
    if (messages[index]?.role !== 'assistant') continue
    seen++
    if (seen === KEEP_RECENT_STEPS) return index
  }
  return null
}

// 用编码模型写摘要：发过去的是压缩点之前的对话加一条要求，前缀和刚才的请求一样，能用上提示词缓存
async function summarize(session: Session, model: ActiveModel, cut: number, signal: AbortSignal, io: TurnIO): Promise<string> {
  const context = session.contextMessages()
  const kept = session.messages.length - cut
  const result = streamText({
    model: model.language,
    system: session.systemPrompt,
    messages: [...context.slice(0, context.length - kept), { role: 'user', content: SUMMARY_REQUEST }],
    tools: session.toolSet(),
    toolChoice: 'none',
    maxRetries: 2,
    abortSignal: signal,
    headers: MODEL_CALL_HEADERS,
  })
  let text = ''
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') text += part.text
    if (part.type === 'finish-step') {
      await io.recordUsage({ role: 'coder', provider: model.config.provider, modelId: model.config.modelId, usage: part.usage })
    }
    if (part.type === 'error') throw part.error
  }
  if (!text.trim()) throw new Error('模型没有返回摘要')
  return text.trim()
}

// 摘要消息里原样带上这一轮的提问，不依赖模型把用户的原话转述对
function summaryMessage(session: Session, requestIndex: number, cut: number, summary: string): string {
  const request = requestIndex < cut ? session.messages[requestIndex] : undefined
  const requestText = request?.role === 'user' && typeof request.content === 'string' ? request.content : null
  return [
    '[Diffra] Earlier parts of this conversation were compacted to save context. Summary of what happened before:',
    summary,
    ...(requestText ? ['', "The user's request for the task in progress when this summary was written, verbatim:", requestText] : []),
  ].join('\n')
}
