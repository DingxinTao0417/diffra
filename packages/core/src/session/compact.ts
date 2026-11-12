import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { type ModelMessage, streamText, type ToolResultPart } from 'ai'
import { toModelError } from '../models/errors.js'
import { MODEL_CALL_HEADERS } from '../models/operations.js'
import { streamParts } from '../models/stream.js'
import { DEFAULT_CONTEXT_WINDOW, type ActiveModel, type TurnIO } from './loop.js'
import type { StopReason, UsageCache } from '../protocol.js'
import { SCREENSHOT_MARKER } from './browser.js'
import { IMAGE_CHARS, messagesChars, type Session } from './session.js'
import { isProtectedFile } from '../tools/protected.js'
import { resolveInWorkspace } from '../tools/workspace.js'

// 最近这么多步（模型的回复和它调用工具的结果）原样保留，压缩只动更早的部分
export const KEEP_RECENT_STEPS = 4
// 短于这么多字的工具输出不值得省略
const MIN_OMITTED_CHARS = 500
// 压缩之后这么多步内不再压缩，免得最近几步本身就很大时每一步都压一遍
const COOLDOWN_STEPS = 3
const MANUAL_COMPACTION_TIMEOUT_MS = 5 * 60_000
// 压缩后还超过窗口的这个比例，再跑下去就会被模型拒绝，只能停下
const HARD_STOP_RATIO = 0.95
const OMITTED_PREFIX = '[Output omitted by Diffra'

const SUMMARY_REQUEST = [
  '[Diffra] The conversation is too long for the context window. Write a summary that will replace everything above this message.',
  'Work will continue from your summary alone, so include everything needed to continue:',
  "- what the user asked for, and every constraint or preference they stated, in the user's own words where the wording matters;",
  '- decisions made and why;',
  '- files read or changed, and what was changed in each;',
  '- skills you were following: the path of each SKILL.md you read, so it can be read again;',
  '- the current state: what is done, what is in progress, what remains, and the next step;',
  '- verification: which checks and tests were run and what they showed, and which were not run yet;',
  '- errors met and whether they are solved; approaches that failed and why, so they are not tried again.',
  'Be specific: file paths, function names, commands. Do not call tools. Write in the language the user writes in.',
].join('\n')

export interface CompactionState {
  // 在这一步之前不再压缩
  cooldownUntil: number
}

export type CompactionOutcome = { kind: 'ok' } | { kind: 'too-large' } | { kind: 'failed'; message: string } | { kind: 'cancelled' }

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
  // 先算省略能省多少，够了才真的替换；不够就直接写摘要，摘要看到的是原文，前缀也没变、能用上缓存
  const omission = planOmission(session)
  const afterOmitting = (estimate * (charsBefore - omission.savedChars)) / charsBefore
  const omittedNote = omission.count > 0 ? `省略了 ${omission.count} 个较早的工具输出（约 ${omission.chars} 字），智能体需要时会重新读取。` : ''
  if (afterOmitting <= threshold) {
    applyOmission(session, omission)
    await finishCard('completed', `上下文用到约 ${percent}%。${omittedNote}`)
    return { kind: 'ok' }
  }

  const cut = recentStepsStart(session.messages, session.compaction?.upTo ?? 0)
  if (cut === null) {
    // 没有可省略的范围时 omission 是空的，这里只是一致地处理
    applyOmission(session, omission)
    await finishCard('completed', `上下文用到约 ${percent}%。${omittedNote}更早的对话已经压缩过，剩下的都是最近几步，没法再压。`)
    return afterOmitting > window * HARD_STOP_RATIO ? { kind: 'too-large' } : { kind: 'ok' }
  }
  try {
    const summary = await summarize(session, options.model, cut, signal, io)
    session.compaction = { upTo: cut, summary: summaryMessage(session, options.requestIndex, cut, summary, await recentFiles(session, cut, window)) }
    // 压缩拖了一会儿才结束，界面上的上下文百分比这时就更新，不用等下一次模型调用
    await emitCompactedUsage(session, io, charsBefore, estimate, cacheUsageOf(session, latestUsage(session)))
    await finishCard('completed', `上下文用到约 ${percent}%。较早的对话压缩成了下面的摘要，最近 ${KEEP_RECENT_STEPS} 步保留原文。\n\n${summary}`)
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

// 手动压缩不省略/改写原消息：失败和取消都不改变上下文，历史和撤销所需索引保留。
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
    const start = session.compaction?.upTo ?? 0
    // 优先保留最近四步；短会话至少保留最新用户轮，工具调用与结果不会拆开。
    let latestRequest = -1
    for (let index = session.messages.length - 1; index >= start; index--) {
      if (session.messages[index]?.role === 'user') { latestRequest = index; break }
    }
    const cut = recentStepsStart(session.messages, start) ?? (latestRequest > start ? latestRequest : null)
    if (cut === null) {
      await finishCard('completed', '当前上下文较短，没有可压缩的早期对话；未调用模型，原文保持不变。')
      return signal.aborted ? 'cancelled' : 'end_turn'
    }
    if (signal.aborted) { await finishCard('failed', '已停止，原上下文保持不变。'); return 'cancelled' }
    const before = messagesChars(session.contextMessages())
    const active: ActiveModel = { language: session.model, config: session.config.model }
    let summary: string
    // 仅将模型摘要请求的失败转成压缩卡片；通知/状态更新错误交由调用方处理。
    try {
      summary = await summarize(session, active, cut, signal, io)
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
    if (signal.aborted) { await finishCard('failed', '已停止，原上下文保持不变。'); return 'cancelled' }
    const content = summaryMessage(session, latestRequest, cut, summary, await recentFiles(session, cut, session.config.model.contextWindow ?? DEFAULT_CONTEXT_WINDOW))
    const after = messagesChars([{ role: 'user', content }, ...session.messages.slice(cut)])
    if (after >= before) {
      await finishCard('completed', '摘要未减少上下文长度，已保留原上下文。')
      return 'end_turn'
    }
    session.compaction = { upTo: cut, summary: content }
    await emitCompactedUsage(session, io, beforeChars, beforeUsed, cacheUsageOf(session, previous))
    await finishCard('completed', `已手动压缩早期上下文（对话约 ${before.toLocaleString()} → ${after.toLocaleString()} 字），保留最近内容。历史记录和任务完成条件不变。\n\n${summary}`)
    return 'end_turn'
  } finally {
    session.activeTurn = null
  }
}

interface Omission {
  // 消息位置 → 换上的消息
  replacements: Map<number, ModelMessage>
  count: number
  // 被省略的原文字数（显示用）和替换后实际少掉的字数（估算用）
  chars: number
  savedChars: number
}

// 算出压缩点之后、最近几步之前哪些长工具输出可以换成一句占位，不改消息
function planOmission(session: Session): Omission {
  const start = session.compaction?.upTo ?? 0
  const end = recentStepsStart(session.messages, start) ?? start
  const replacements = new Map<number, ModelMessage>()
  let count = 0
  let chars = 0
  for (let index = start; index < end; index++) {
    const message = session.messages[index]
    // 浏览器截图那条消息里的图片换成一句话
    if (message?.role === 'user' && Array.isArray(message.content) && message.content[0]?.type === 'text' && message.content[0].text === SCREENSHOT_MARKER) {
      const images = message.content.filter((part) => part.type === 'image').length
      if (images === 0) continue
      count += images
      chars += images * IMAGE_CHARS
      replacements.set(index, { role: 'user', content: `${OMITTED_PREFIX}: ${images} earlier browser screenshot(s). Take a new screenshot if you need to see the page.]` })
      continue
    }
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
    if (content.some((part, partIndex) => part !== message.content[partIndex])) replacements.set(index, { ...message, content })
  }
  const original = [...replacements.keys()].map((index) => session.messages[index]!)
  const savedChars = messagesChars(original) - messagesChars([...replacements.values()])
  return { replacements, count, chars, savedChars }
}

// 原地替换；界面上的历史存在每轮的更新里，不受影响
function applyOmission(session: Session, omission: Omission): void {
  for (const [index, message] of omission.replacements) session.messages[index] = message
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
  const attempt = new AbortController()
  const result = streamText({
    model: model.language,
    system: session.systemPrompt,
    messages: [...context.slice(0, context.length - kept), { role: 'user', content: SUMMARY_REQUEST }],
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

// 压缩掉的那段对话里最近读过、改过的文件，按现在磁盘上的内容附在摘要后面（第 444 步，参照 qwen-code）：
// 不然模型接着干活的第一件事往往是把这几个文件再读一遍。只附项目里的、不是受保护的、不太大的文件；
// 保留下来的最近几步里出现过的不附（原文还在）。总量不超过上下文窗口的一小部分
const RECENT_FILES = 5
const RECENT_FILE_MAX_CHARS = 8000
const RECENT_FILES_WINDOW_SHARE = 0.06
// 估算用：一个 token 大约 3 个字符
const CHARS_PER_TOKEN = 3

function touchedPaths(messages: ModelMessage[]): string[] {
  const paths: string[] = []
  for (const message of messages) {
    if (message.role !== 'assistant' || typeof message.content === 'string') continue
    for (const part of message.content) {
      if (part.type !== 'tool-call' || (part.toolName !== 'read_file' && part.toolName !== 'edit_file')) continue
      const path = typeof part.input === 'object' && part.input !== null && 'path' in part.input ? part.input.path : null
      if (typeof path === 'string') paths.push(path)
    }
  }
  return paths
}

async function recentFiles(session: Session, cut: number, window: number): Promise<string> {
  const kept = new Set(touchedPaths(session.messages.slice(cut)))
  const candidates = [...new Set(touchedPaths(session.messages.slice(session.compaction?.upTo ?? 0, cut)).reverse())].filter((path) => !kept.has(path))
  let budget = Math.min(RECENT_FILES * RECENT_FILE_MAX_CHARS, window * RECENT_FILES_WINDOW_SHARE * CHARS_PER_TOKEN)
  const blocks: string[] = []
  for (const path of candidates) {
    if (blocks.length >= RECENT_FILES) break
    try {
      const target = await resolveInWorkspace(session.cwd, path)
      if (isProtectedFile(target.absolute)) continue
      const content = await readFile(target.absolute, 'utf8')
      if (content.length > RECENT_FILE_MAX_CHARS || content.length > budget) continue
      budget -= content.length
      blocks.push(`=== ${target.display}\n${content}`)
    } catch {
      // 文件删了、挪了、在项目外：不附，模型需要时自己再读
    }
  }
  return blocks.join('\n\n')
}

// 摘要消息里原样带上这一轮的提问，不依赖模型把用户的原话转述对
function summaryMessage(session: Session, requestIndex: number, cut: number, summary: string, files = ''): string {
  const request = requestIndex < cut ? session.messages[requestIndex] : undefined
  const requestText = request?.role === 'user' && typeof request.content === 'string' ? request.content : null
  return [
    '[Diffra] Earlier parts of this conversation were compacted to save context. Summary of what happened before:',
    summary,
    ...(requestText ? ['', "The user's request for the task in progress when this summary was written, verbatim:", requestText] : []),
    ...(files ? ['', 'Files you read or edited most recently before the summary, as they are on disk now (read any other file again before relying on it):', files] : []),
    '',
    'Continue from the current state without acknowledging or recapping this summary. Read again the SKILL.md of any skill it says you were following before you rely on it.',
  ].join('\n')
}
