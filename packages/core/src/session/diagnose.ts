import { randomUUID } from 'node:crypto'
import type { SessionUpdate, StopReason, ToolCallContent } from '@agentclientprotocol/sdk'
import { tool } from 'ai'
import { z } from 'zod'
import { toModelError } from '../models/errors.js'
import {
  AGENT_META_KEY,
  type Diagnosis,
  DIAGNOSIS_META_KEY,
  MODEL_SILENCE_META_KEY,
  PARENT_TOOL_CALL_META_KEY,
  type StoredTurn,
  TURN_OUTCOME_META_KEY,
  type TurnOutcome,
} from '../protocol.js'
import { DEFAULT_CONTEXT_WINDOW, notice, type TurnIO } from './loop.js'
import { runReadOnlyLoop } from './read-only.js'
import type { Session } from './session.js'
import { TOOLS } from './tools.js'

const MAX_STEPS = 8
const READ_TOOLS = new Set(['read_file', 'list_files', 'search', 'outline'])
// 记录里最多列最后这么多步，每步的结果截到这么长；改动截到这么长
const MAX_LISTED_STEPS = 60
const MAX_STEP_RESULT = 400
const MAX_NOTICE = 600
const MAX_DIFF = 8_000

const diagnosisInput = z.object({
  cause: z.string().describe('One or two sentences: why it stopped or went wrong. Be specific: name the file, check or step.'),
  evidence: z
    .array(z.object({ step: z.string().describe('A step id from the facts, like s12'), note: z.string().describe('What this step shows') }))
    .max(5),
  done: z.array(z.string()).max(8).describe('What is already finished and must not be redone'),
  remaining: z.array(z.string()).max(8).describe('What is still left to do'),
  prompt: z
    .string()
    .describe(
      'The next message for the coding agent: what went wrong, what to do next, what not to redo. Do not retell the history: the agent already has the conversation. Short and concrete.',
    ),
  questions: z
    .array(
      z.object({
        question: z.string(),
        options: z
          .array(z.object({ label: z.string().describe('Short answer shown on a button'), text: z.string().describe('The line of the prompt for this answer') }))
          .min(2)
          .max(4)
          .describe('The first option is the default; its text must appear verbatim as one line of the prompt'),
      }),
    )
    .max(2)
    .describe('Only questions the user must answer before the agent continues (a choice of approach, what they meant). Empty if none.'),
})

type DiagnosisInput = z.infer<typeof diagnosisInput>

const DIAGNOSIS_TOOLS = {
  read_file: TOOLS.read_file,
  list_files: TOOLS.list_files,
  search: TOOLS.search,
  outline: TOOLS.outline,
  submit_diagnosis: tool({ description: 'Submit the diagnosis. Call it exactly once, at the end.', inputSchema: diagnosisInput }),
}

// 接在编码的系统提示词后面：这一轮只查原因、交结论，不改文件
const DIAGNOSIS_MODE = [
  '',
  'DIAGNOSIS MODE: the user wants to know why a turn stopped (or why a worker did not finish) and how to continue. Nothing gets changed now.',
  '- You can only use read_file, list_files, search and outline, and only a few calls. Check the real state of files when the cause depends on it (for example a half-finished edit).',
  '- The facts in the last message list the steps of that turn as s1, s2, ... Cite them as evidence.',
  '- If the cause is outside the task (the model service stalled or failed, rate limits, a wrong API key), say so plainly; the prompt can then be short.',
  '- When you know enough, call submit_diagnosis exactly once. Write it in the language the user writes in.',
].join('\n')

interface Step {
  id: string
  title: string
  status: string
  result: string
  parentId: string | null
  agent: string | null
  // 子智能体卡片（那次 delegate 调用）带的任务和认领
  card: { task: string; files: string[]; nodes: string[] } | null
}

const CHECK_STOPS: Partial<Record<NonNullable<TurnOutcome['stop']>, string>> = {
  'check-exhausted': '快速检查一直没修好',
  'gate-exhausted': '完成检查一直没通过',
  stuck: '一直在重复同样的操作',
  'step-limit': '达到了单次任务的步数上限',
  'context-limit': '上下文快用完了',
  'no-finish': '改了文件但没有走完完成检查',
  'goal-exhausted': '目标模式的轮数用完了',
  cancelled: '被用户停止',
  paused: '主动暂停在等待',
}

function contentText(content: ToolCallContent[] | null | undefined): string | null {
  if (!content || content.length === 0) return null
  return content
    .map((item) => (item.type === 'content' && item.content.type === 'text' ? item.content.text : item.type === 'diff' ? `（改动 ${item.path}）` : ''))
    .join('\n')
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

// 这一轮记下的工具调用，按出现顺序；工具调用和后面的更新合在一起
function stepsOf(turn: StoredTurn): Step[] {
  const steps = new Map<string, Step>()
  for (const update of turn.updates) {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') continue
    const existing = steps.get(update.toolCallId)
    const diffra = (update._meta?.diffra ?? {}) as Record<string, unknown>
    const parent = diffra[PARENT_TOOL_CALL_META_KEY]
    const tag = diffra[AGENT_META_KEY] as { name?: unknown; task?: unknown; files?: unknown; nodes?: unknown } | undefined
    const card =
      typeof parent !== 'string' && typeof tag?.task === 'string'
        ? { task: tag.task, files: Array.isArray(tag.files) ? tag.files.map(String) : [], nodes: Array.isArray(tag.nodes) ? tag.nodes.map(String) : [] }
        : null
    steps.set(update.toolCallId, {
      id: update.toolCallId,
      title: update.title ?? existing?.title ?? update.toolCallId,
      status: update.status ?? existing?.status ?? 'pending',
      result: contentText(update.content) ?? existing?.result ?? '',
      parentId: typeof parent === 'string' ? parent : (existing?.parentId ?? null),
      agent: typeof tag?.name === 'string' ? tag.name : (existing?.agent ?? null),
      card: card ?? existing?.card ?? null,
    })
  }
  return [...steps.values()]
}

function outcomeOf(turn: StoredTurn): TurnOutcome | null {
  for (const update of [...turn.updates].reverse()) {
    if (update.sessionUpdate !== 'session_info_update') continue
    const outcome = (update._meta?.diffra as Record<string, unknown> | undefined)?.[TURN_OUTCOME_META_KEY]
    if (outcome) return outcome as TurnOutcome
  }
  return null
}

// 停下时还没输出的模型：智能体名（主智能体为 null）和已经多久没输出
function stalledAtEnd(turn: StoredTurn): Array<{ agent: string | null; seconds: number }> {
  const silent = new Map<string, { agent: string | null; since: number }>()
  for (const update of turn.updates) {
    if (update.sessionUpdate !== 'session_info_update') continue
    const diffra = update._meta?.diffra as Record<string, unknown> | undefined
    if (!diffra || !(MODEL_SILENCE_META_KEY in diffra)) continue
    const tag = diffra[AGENT_META_KEY] as { id?: unknown; name?: unknown } | undefined
    const key = typeof tag?.id === 'string' ? tag.id : 'main'
    const since = diffra[MODEL_SILENCE_META_KEY]
    if (typeof since === 'string') silent.set(key, { agent: typeof tag?.name === 'string' ? tag.name : null, since: Date.parse(since) })
    else silent.delete(key)
  }
  const end = turn.endedAt ? Date.parse(turn.endedAt) : Date.now()
  return [...silent.values()].map(({ agent, since }) => ({ agent, seconds: Math.round((end - since) / 1000) }))
}

function noticesOf(updates: SessionUpdate[]): string[] {
  return updates.flatMap((update) =>
    update.sessionUpdate === 'notice' ? [`- [${update.severity}] ${update.title}${update.description ? `：${clip(update.description, MAX_NOTICE)}` : ''}`] : [],
  )
}

// 一句话说清怎么停下的；模型没交结果时的通用版本也用它
function endingOf(turn: StoredTurn, stalled: Array<{ agent: string | null; seconds: number }>, card: Step | null): string {
  if (card) return card.status === 'failed' ? `子智能体「${card.agent ?? ''}」没有做完：${clip(card.result, 200)}` : `子智能体「${card.agent ?? ''}」交回了结果`
  const silent = stalled[0]
  if (silent) return `${silent.agent ? `子智能体「${silent.agent}」的模型` : '模型'}已经 ${silent.seconds} 秒没有输出，用户停止了这一轮`
  const outcome = outcomeOf(turn)
  if (outcome?.stop === 'model-error') return `模型调用出错（${outcome.errorKind ?? 'unknown'}）`
  if (outcome?.stop) return CHECK_STOPS[outcome.stop] ?? outcome.stop
  if (turn.stopReason === 'cancelled') return '被用户停止'
  if (turn.stopReason === 'max_tokens') return '上下文快用完了'
  if (turn.stopReason === 'max_turn_requests') return '达到了单次任务的步数上限'
  return '这一轮结束了，但没有完成'
}

interface Facts {
  text: string
  // s1、s2……对应的步骤
  steps: Step[]
  fallback: Diagnosis
}

async function buildFacts(session: Session, turn: StoredTurn, cardId: string | null): Promise<Facts> {
  const all = stepsOf(turn)
  const card = cardId ? (all.find((step) => step.id === cardId) ?? null) : null
  if (cardId && !card) throw new Error('找不到要定位的子智能体')
  // 定位子智能体只看它自己的步骤；主会话看主智能体的步骤和各张子智能体卡片
  const scoped = card ? all.filter((step) => step.parentId === cardId) : all.filter((step) => step.parentId === null)
  const steps = scoped.slice(-MAX_LISTED_STEPS)
  const stalled = stalledAtEnd(turn).filter((item) => (card ? item.agent === card.agent : true))
  const ending = endingOf(turn, stalled, card)
  const lines: string[] = []
  if (card) {
    lines.push(`The user wants to know why worker "${card.agent ?? ''}" did not finish its part, and how to continue. Its own conversation was not saved; its steps are listed below.`)
    lines.push(`Task given to the worker: ${card.card?.task ?? ''}`)
    if (card.card && card.card.files.length > 0) lines.push(`Files it owned: ${card.card.files.join(', ')}`)
    if (card.card && card.card.nodes.length > 0) lines.push(`Canvas nodes it owned: ${card.card.nodes.join(', ')}`)
    lines.push(`Its result: ${clip(card.result, 2_000) || '(none)'}`)
  } else {
    lines.push('The user wants to know why the turn below stopped, and how to continue.')
    lines.push(`The request of that turn: ${clip(turn.prompt, 2_000)}`)
  }
  lines.push(`How it ended: ${ending}`)
  const notices = noticesOf(turn.updates)
  if (notices.length > 0) lines.push('', 'Notices in that turn:', ...notices)
  lines.push('', `Steps (oldest first${scoped.length > steps.length ? `, only the last ${steps.length}` : ''}):`)
  steps.forEach((step, index) => {
    const who = step.card ? ` (worker "${step.agent ?? ''}", task: ${clip(step.card.task, 200)})` : ''
    const result = step.result.trim() ? ` → ${clip(step.result.trim().replace(/\s+/g, ' '), MAX_STEP_RESULT)}` : ''
    lines.push(`s${index + 1} [${step.status}] ${step.title}${who}${result}`)
  })
  if (!card && session.unresolvedCheck) lines.push('', `Errors still failing in \`${session.unresolvedCheck.command}\`:`, ...session.unresolvedCheck.lines.slice(0, 20))
  const diff = await session.checkpointDiff(turn.id).catch(() => '')
  if (diff.trim()) lines.push('', 'Changes in the workspace since that turn started (unified diff):', clip(diff, MAX_DIFF))
  const last = [...steps].reverse().find((step) => step.status !== 'pending')
  const where = last ? `停在了「${last.title}」之后（${ending}）` : `（${ending}）`
  const prompt = card
    ? `子智能体「${card.agent ?? ''}」没有做完它负责的部分：${clip(card.card?.task ?? '', 300)}。它${where}。请先检查它已经改过的地方，再把剩下的部分做完，已经完成的不要重做。`
    : `上一轮${where}。请先确认当前文件的实际状态，再从这里接着做，已经完成的不要重做。`
  return {
    text: lines.join('\n'),
    steps,
    fallback: { target: { turnId: turn.id, cardId, agent: card?.agent ?? null }, cause: ending, evidence: [], done: [], remaining: [], prompt, questions: [], fallback: true },
  }
}

function toDiagnosis(input: DiagnosisInput, steps: Step[], target: Diagnosis['target']): Diagnosis {
  const evidence = input.evidence.flatMap(({ step, note }) => {
    const target = steps[Number(/^s?(\d+)$/i.exec(step.trim())?.[1] ?? 0) - 1]
    return target ? [{ itemId: target.id, title: target.title, note }] : []
  })
  // 默认答案那一行要在提示词里，换选项时才找得到；模型漏了就补在末尾
  let prompt = input.prompt.trim()
  for (const question of input.questions) {
    const line = question.options[0]!.text.trim()
    if (line && !prompt.includes(line)) prompt = `${prompt}\n${line}`
  }
  return { target, cause: input.cause.trim(), evidence, done: input.done, remaining: input.remaining, prompt, questions: input.questions, fallback: false }
}

export function formatDiagnosis(diagnosis: Diagnosis): string {
  const lines = [`原因：${diagnosis.cause}`]
  if (diagnosis.done.length > 0) lines.push('', '已经完成：', ...diagnosis.done.map((item) => `- ${item}`))
  if (diagnosis.remaining.length > 0) lines.push('', '还没完成：', ...diagnosis.remaining.map((item) => `- ${item}`))
  lines.push('', '修复提示词：', diagnosis.prompt)
  return lines.join('\n')
}

async function showDiagnosis(toolCallId: string, diagnosis: Diagnosis, io: TurnIO): Promise<void> {
  await io.update({
    sessionUpdate: 'tool_call',
    toolCallId,
    title: '定位结果',
    kind: 'think',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: formatDiagnosis(diagnosis) } }],
    _meta: { diffra: { [DIAGNOSIS_META_KEY]: diagnosis } },
  })
}

// 定位问题的一轮：用当前模型、带着主对话只读地查，最多几步，交回原因、证据和修复提示词。
// 探索过程不进编码模型的对话；模型没交结果（出错、步数到头）时给一份按记录拼的通用提示词
export async function runDiagnose(session: Session, target: { turnId: string; cardId: string | null }, io: TurnIO): Promise<StopReason> {
  if (session.running) throw new Error('上一个任务还没结束')
  const stored = session.turns.find((turn) => turn.id === target.turnId)
  if (!stored) throw new Error('找不到要定位的那一轮')
  const controller = session.activateTurn()
  const { signal } = controller
  const model = session.config.model
  try {
    const facts = await buildFacts(session, stored, target.cardId)
    try {
      const outcome = await runReadOnlyLoop(
        session,
        {
          model: session.model,
          system: `${session.systemPrompt}\n${DIAGNOSIS_MODE}`,
          messages: [...session.contextMessages(), { role: 'user', content: facts.text }],
          tools: DIAGNOSIS_TOOLS,
          readTools: READ_TOOLS,
          finalTool: 'submit_diagnosis',
          maxSteps: MAX_STEPS,
          window: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
          usage: { role: 'coder', provider: model.provider, modelId: model.modelId },
          nudge: 'Check what you need with the read tools, or call submit_diagnosis now.',
          readOnlyError: 'This is diagnosis mode: you can only read. Use read_file, list_files, search, outline, or submit_diagnosis.',
          onFinal: (toolCallId, input) => showDiagnosis(toolCallId, toDiagnosis(diagnosisInput.parse(input), facts.steps, facts.fallback.target), io),
        },
        signal,
        io,
      )
      if (outcome === 'cancelled') return 'cancelled'
      if (outcome === 'done') return 'end_turn'
      await notice(io, 'warning', `定位达到步数上限（${MAX_STEPS} 步），没有给出结论`, '下面是按记录拼的通用提示词。')
    } catch (error) {
      if (signal.aborted) return 'cancelled'
      console.error('[session] 定位失败', error)
      await notice(io, 'error', '定位失败', `${toModelError(error, model.endpoint.apiKey, 0).message}\n下面是按记录拼的通用提示词。`)
    }
    await showDiagnosis(randomUUID(), facts.fallback, io)
    return 'end_turn'
  } finally {
    session.activeTurn = null
  }
}
