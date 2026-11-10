import { readdir } from 'node:fs/promises'
import { type LanguageModelUsage, streamText, tool, ToolChoiceViolationError } from 'ai'
import { z } from 'zod'
import { designStyleById } from './design-styles.js'
import { createLanguageModel, MODEL_CALL_HEADERS } from './models/operations.js'
import type { PromptQuestion, SessionModel } from './protocol.js'
import type { Session } from './session/session.js'

const TIMEOUT_MS = 90_000
// 带给模型的上下文：项目顶层最多这么多项，最近几轮，每轮的提问和回复截到这么长
const MAX_ENTRIES = 60
const RECENT_TURNS = 3
const MAX_TURN_TEXT = 600
const MAX_CHANGED_FILES = 30

const enhanceInput = z.object({
  prompt: z.string().describe('The improved request, ready to send. Same language as the user.'),
  questions: z
    .array(
      z.object({
        question: z.string(),
        options: z
          .array(z.object({ label: z.string().describe('Short answer shown on a button'), text: z.string().describe('The line of the improved request for this answer') }))
          .min(2)
          .max(4)
          .describe('The first option is the assumption you used; its text must appear verbatim as one line of the improved request'),
      }),
    )
    .max(3)
    .describe('Assumptions that change the result and only the user can decide. Empty if none.'),
})

const SYSTEM = [
  'You improve a request a user is about to send to Diffra, a coding agent that works in their project. Rewrite it so the agent can act without guessing.',
  "- Keep the user's intent and language. Do not add features or requirements they did not ask for.",
  '- Make the goal, the scope, constraints and how to check the result explicit, but only where it helps. A short, clear request stays short: no headings or templates for a one-line task.',
  '- Name only files and folders that appear in the context below. Never invent paths.',
  '- Keep every attachment token listed below exactly as written, in the request.',
  '- When the request leaves open something that changes the result and only the user can decide (scope, approach, what "done" means), pick the most likely answer, write it as one line of the request, and ask it as a question: the first option is the answer you used, its text is that exact line; other options are real alternatives. At most 3 questions; usually 0 or 1.',
  '- Call submit_prompt exactly once.',
].join('\n')

export interface EnhanceRequest {
  model: SessionModel
  text: string
  cwd: string | null
  // 输入框里的 @附件，改写后要原样保留
  mentions: string[]
  design: boolean
}

export interface EnhanceResult {
  prompt: string
  questions: PromptQuestion[]
  // 供应商没报用量时为 null，不记
  usage: LanguageModelUsage | null
}

async function projectEntries(cwd: string): Promise<string[]> {
  const entries = await readdir(cwd, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => !entry.name.startsWith('.') || entry.name === '.github')
    .slice(0, MAX_ENTRIES)
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

// 任务里最近几轮说了什么、改过哪些文件：「刚才那个」「这个页面」之类的指代靠它对上
function taskContext(session: Session): string[] {
  const lines: string[] = []
  const turns = session.turns.filter((turn) => turn.kind === 'prompt' || turn.kind === 'goal').slice(-RECENT_TURNS)
  for (const turn of turns) {
    const reply = turn.updates.flatMap((update) => (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? [update.content.text] : [])).join('')
    lines.push(`- User: ${clip(turn.prompt.trim(), MAX_TURN_TEXT)}`)
    if (reply.trim()) lines.push(`  Agent: ${clip(reply.trim(), MAX_TURN_TEXT)}`)
  }
  const changed = new Set<string>()
  for (const turn of session.turns) {
    for (const update of turn.updates) {
      if (update.sessionUpdate !== 'tool_call_update' && update.sessionUpdate !== 'tool_call') continue
      for (const item of update.content ?? []) if (item.type === 'diff') changed.add(item.path)
    }
  }
  const files = [...changed].slice(-MAX_CHANGED_FILES)
  return [...(lines.length > 0 ? ['Recent conversation in this task:', ...lines] : []), ...(files.length > 0 ? [`Files changed in this task: ${files.join(', ')}`] : [])]
}

// 优化输入框里的提示词：一次调用拿到改写稿和问题（第一个选项是改写稿采用的答案）。不进任何对话
export async function enhancePrompt(request: EnhanceRequest, session: Session | null, signal?: AbortSignal): Promise<EnhanceResult> {
  const context: string[] = []
  const cwd = session?.cwd ?? request.cwd
  if (cwd && !session?.noProject) {
    const entries = await projectEntries(cwd)
    if (entries.length > 0) context.push(`Top level of the project: ${entries.join(', ')}`)
  }
  if (session) context.push(...taskContext(session))
  const design = session ? Boolean(session.designTask) : request.design
  if (design) {
    const style = designStyleById(session?.designStyle ?? null)
    context.push(`This is a design task: the agent draws pages on a canvas${style ? ` in the "${style.name}" style` : ''}.`)
  }
  if (request.mentions.length > 0) context.push(`Attachments (keep these tokens exactly): ${request.mentions.join(' ')}`)
  const model = createLanguageModel(request.model.endpoint, request.model.modelId, request.model.reasoningEffort)
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  // 和其他模型调用一样走流式接口；强制只调 submit_prompt
  const result = streamText({
    model,
    system: SYSTEM,
    prompt: [...(context.length > 0 ? ['Context:', ...context, ''] : []), 'The request to improve:', request.text].join('\n'),
    tools: { submit_prompt: tool({ description: 'Submit the improved request and the questions.', inputSchema: enhanceInput }) },
    toolChoice: { type: 'tool', toolName: 'submit_prompt' },
    maxRetries: 1,
    abortSignal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: MODEL_CALL_HEADERS,
  })
  let input: unknown
  let usage: LanguageModelUsage | null = null
  for await (const part of result.fullStream) {
    if (part.type === 'tool-call' && part.toolName === 'submit_prompt') input = part.input
    if (part.type === 'finish-step') usage = part.usage
    if (part.type === 'error') {
      // 模型只回了文字、没调 submit_prompt：和没交结果一样说
      if (ToolChoiceViolationError.isInstance(part.error)) break
      throw part.error
    }
  }
  if (input === undefined) throw new Error('模型没有给出优化后的提示词')
  const parsed = enhanceInput.parse(input)
  let prompt = parsed.prompt.trim()
  // 默认答案那一行要在提示词里，换选项时才找得到；模型漏了就补在末尾
  for (const question of parsed.questions) {
    const line = question.options[0]!.text.trim()
    if (line && !prompt.includes(line)) prompt = `${prompt}\n${line}`
  }
  return { prompt, questions: parsed.questions, usage }
}
