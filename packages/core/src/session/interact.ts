import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { tool, type ToolResultPart } from 'ai'
import { z } from 'zod'
import { ASK_USER_OPTION_PREFIX, ASK_USER_SCOPE, ASK_USER_SKIP, ASK_USER_SUBMIT, type AskAnswer, type AskQuestion, formatSteps, type PromptImage, type StepItem, STEPS_CARD_TITLE } from '../protocol.js'
import { errorResult, type StepToolCall, textResult, type TurnIO } from './loop.js'
import type { Session } from './session.js'
import { toolDefinitionChars } from './tools.js'
import { ToolError } from '../tools/types.js'
import { resolveInWorkspace } from '../tools/workspace.js'

// 两个让智能体和用户对上进度的工具：
// 计划（第 510 步起照 Codex 的 update_plan，以前是 todo_write）让用户看到它打算做哪几步、做到哪了；提问（ask_user）让它在岔路口先问，不用结束这一轮等回复

export const TODO_TOOL = 'update_plan'
export const ASK_USER_TOOL = 'ask_user'

const todoInput = z.object({
  explanation: z.string().max(500).optional().describe('Optional short note on why the plan changed'),
  plan: z
    .array(
      z.object({
        step: z.string().trim().min(1).max(200).describe('One concrete step, in the language the user writes in'),
        status: z.enum(['pending', 'in_progress', 'completed']),
      }),
    )
    .min(1)
    .max(30)
    .describe('The whole plan every time, in order'),
})

export const todoTool = tool({
  description: [
    'Updates the task plan shown to the user. Provide an optional explanation and the whole list of steps, each with a status. At most one step can be in_progress at a time.',
    'Use a plan for non-trivial work with several distinct phases, or when the user asked for several things; skip it for a question or a simple change you can do in a few actions.',
    'Mark a step completed as soon as it is done and the next one in_progress, in the same response as your next tool call. Do not repeat the plan in your reply: the user sees it as a card.',
  ].join('\n'),
  inputSchema: todoInput,
})

const invalid = (issues: z.core.$ZodIssue[]) => `Invalid arguments: ${issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`

const stepsCardId = (session: Session) => `steps-${session.turns.at(-1)?.id ?? session.id}`

// 一轮一张步骤卡：同一轮里每次更新都发同一个 id，界面整张替换，不会越积越多
async function showSteps(session: Session, steps: StepItem[], io: TurnIO): Promise<number> {
  const id = stepsCardId(session)
  // 第一次是新卡片，之后是同一张卡片的更新；按 ACP 的约定用 tool_call_update，不能一直重复发 tool_call
  const updating = session.stepList?.id === id
  session.stepList = { id, steps }
  const done = steps.filter((step) => step.status === 'completed').length
  await io.update({
    sessionUpdate: updating ? 'tool_call_update' : 'tool_call',
    toolCallId: id,
    title: STEPS_CARD_TITLE,
    kind: 'think',
    status: done === steps.length ? 'completed' : 'in_progress',
    content: [{ type: 'content', content: { type: 'text', text: formatSteps(steps) } }],
  })
  return done
}

// 按计划执行（v2）：一开始就把计划的步骤列成清单（都还没开始），智能体用 update_plan 照着打勾，计划卡片跟着显示每一步的状态
export async function presetSteps(session: Session, steps: string[], io: TurnIO): Promise<void> {
  await showSteps(session, steps.map((content) => ({ content, status: 'pending' as const })), io)
}

// 发给模型的提问后面接一段：照着这几步用 update_plan 打勾（存下来的提问还是原话）
export function planStepsInstruction(steps: string[]): string {
  return [
    '',
    '',
    '[Diffra] The plan steps are already listed as your step list. Keep them in this exact order and wording, and use update_plan to mark each one in_progress when you start it and completed when it is done:',
    ...steps.map((step, index) => `${index + 1}. ${step}`),
  ].join('\n')
}

export async function runTodoWrite(session: Session, call: StepToolCall, io: TurnIO): Promise<{ result: ToolResultPart; edited: boolean }> {
  const parsed = todoInput.safeParse(call.input)
  if (!parsed.success) return { result: errorResult(call, invalid(parsed.error.issues)), edited: false }
  const steps = parsed.data.plan.map((item) => ({ content: item.step, status: item.status }))
  const done = await showSteps(session, steps, io)
  return { result: textResult(call, `Plan updated: ${done} of ${steps.length} done.`), edited: false }
}

// 这一轮完成（过了结束门禁）时替模型收尾（第 466 步）：进行中的那一步标成做完，没开始的照旧，免得它为了打勾单独再调一次。
// 只认这一轮的清单
export async function settleSteps(session: Session, io: TurnIO): Promise<void> {
  const list = session.stepList
  if (!list || list.id !== stepsCardId(session) || !list.steps.some((step) => step.status === 'in_progress')) return
  await showSteps(session, list.steps.map((step) => (step.status === 'in_progress' ? { ...step, status: 'completed' as const } : step)), io)
}

const MAX_PREVIEW_BYTES = 400_000
const PREVIEW_TYPES: Record<string, PromptImage['mimeType']> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
const MAX_FILES = 20
const MAX_SLIDER_STEPS = 1000

const askQuestionInput = z
  .object({
    question: z.string().trim().min(1).max(500).describe('One clear question, in the language the user writes in'),
    header: z.string().trim().min(1).max(12).optional().describe('A few words for the tab label; needed when asking several questions'),
    type: z.enum(['choice', 'slider', 'file']).optional().describe('choice (default): pick from options; slider: a number in a range; file: pick files from the project'),
    options: z
      .array(
        z.object({
          label: z.string().trim().min(1).max(40).describe('Short text for this choice'),
          description: z.string().trim().max(200).optional().describe('What choosing it means, when the label alone is not enough'),
          image: z.string().trim().min(1).max(500).optional().describe('Project-relative path of a PNG, JPEG, WebP or GIF (at most 400 KB) shown as a preview of this choice'),
        }),
      )
      .min(2)
      .max(6)
      .optional()
      .describe('For choice: the choices, the one you recommend first'),
    multiSelect: z.boolean().optional().describe('choice: the user may pick several options; file: several files'),
    min: z.number().finite().optional().describe('For slider'),
    max: z.number().finite().optional().describe('For slider'),
    step: z.number().finite().positive().optional().describe('For slider; defaults to 1'),
    unit: z.string().trim().max(12).optional().describe('For slider, shown after the number'),
    default: z.number().finite().optional().describe('For slider: the starting value'),
  })
  .superRefine((value, context) => {
    const issue = (message: string) => context.addIssue({ code: 'custom', message })
    const type = value.type ?? 'choice'
    if (type === 'choice' && !value.options) issue('a choice question needs 2-6 options')
    if (type !== 'choice' && value.options) issue('options are only for choice questions')
    if (type === 'slider') {
      if (value.min === undefined || value.max === undefined || value.min >= value.max) return issue('a slider needs min < max')
      if ((value.max - value.min) / (value.step ?? 1) > MAX_SLIDER_STEPS) issue(`a slider can have at most ${MAX_SLIDER_STEPS} steps; use a larger step`)
      if (value.default !== undefined && (value.default < value.min || value.default > value.max)) issue('default must be between min and max')
    }
  })

const askInput = z.object({
  questions: z.array(askQuestionInput).min(1).max(4).describe('One to four questions; several are shown as tabs and answered together'),
})

export const askUserTool = tool({
  description: [
    'Ask the user up to 4 questions and wait for the answers, without ending your turn.',
    'Each question is a choice (2-6 options; multiSelect to allow several; an option can show a preview image from the project), a slider (a number between min and max, with step and unit) or a file pick (files in the project). Several questions are shown as tabs and answered together, so ask everything you need at once.',
    'Use it only when the answer changes what you build (an ambiguous requirement, two reasonable designs, a risky step) and you cannot settle it from the code or the conversation. Do not ask for permission to continue or about details with an obvious default.',
    'The user can also decline to answer; then say what you need in your reply and stop.',
  ].join('\n'),
  inputSchema: askInput,
})

// 预览图在 core 读好放进确认请求：远程设备、换了窗口都能看，界面不用再读文件
async function questionOf(cwd: string, input: z.infer<typeof askQuestionInput>): Promise<AskQuestion> {
  const base = { question: input.question, ...(input.header ? { header: input.header } : {}) }
  const type = input.type ?? 'choice'
  if (type === 'slider') return { ...base, type, min: input.min!, max: input.max!, step: input.step ?? 1, ...(input.unit ? { unit: input.unit } : {}), ...(input.default !== undefined ? { default: input.default } : {}) }
  if (type === 'file') return { ...base, type, multiSelect: input.multiSelect ?? false }
  const options = await Promise.all(
    input.options!.map(async (option) => ({ label: option.label, ...(option.description ? { description: option.description } : {}), ...(option.image ? { image: await previewOf(cwd, option.image) } : {}) })),
  )
  return { ...base, type, multiSelect: input.multiSelect ?? false, options }
}

async function previewOf(cwd: string, path: string): Promise<PromptImage> {
  const mimeType = PREVIEW_TYPES[extname(path).toLowerCase()]
  if (!mimeType) throw new ToolError(`Preview images must be PNG, JPEG, WebP or GIF: ${path}`)
  const { absolute } = await resolveInWorkspace(cwd, path)
  const info = await stat(absolute).catch(() => null)
  if (!info?.isFile()) throw new ToolError(`Preview image not found: ${path}`)
  if (info.size > MAX_PREVIEW_BYTES) throw new ToolError(`Preview image is larger than 400 KB: ${path}`)
  return { mimeType, data: (await readFile(absolute)).toString('base64') }
}

// 界面（或远程设备）交回的答案：按问题逐个查，有一个不对就整份不算
async function checkedAnswers(cwd: string, questions: AskQuestion[], raw: unknown): Promise<AskAnswer[] | null> {
  if (!Array.isArray(raw) || raw.length !== questions.length) return null
  const answers: AskAnswer[] = []
  for (const [index, question] of questions.entries()) {
    const answer = raw[index] as Record<string, unknown> | null
    if (typeof answer !== 'object' || answer === null) return null
    if (question.type === 'choice') {
      const choice = answer.choice
      if (!Array.isArray(choice) || !choice.every((item) => Number.isInteger(item) && item >= 0 && item < question.options.length)) return null
      const picked = [...new Set(choice as number[])].sort((a, b) => a - b)
      if (picked.length === 0 || (!question.multiSelect && picked.length > 1)) return null
      answers.push({ choice: picked })
    } else if (question.type === 'slider') {
      const value = answer.value
      if (typeof value !== 'number' || !Number.isFinite(value) || value < question.min || value > question.max) return null
      const steps = (value - question.min) / question.step
      if (Math.abs(steps - Math.round(steps)) > 1e-6) return null
      answers.push({ value })
    } else {
      const files = answer.files
      if (!Array.isArray(files) || files.length === 0 || files.length > (question.multiSelect ? MAX_FILES : 1) || !files.every((file) => typeof file === 'string')) return null
      const resolved: string[] = []
      for (const file of files as string[]) {
        const target = await resolveInWorkspace(cwd, file).catch(() => null)
        if (!target || !(await stat(target.absolute).catch(() => null))?.isFile()) return null
        resolved.push(target.display)
      }
      answers.push({ files: [...new Set(resolved)] })
    }
  }
  return answers
}

function answerText(question: AskQuestion, answer: AskAnswer): string {
  if ('choice' in answer && question.type === 'choice') return answer.choice.map((index) => question.options[index]!.label).join('、')
  if ('value' in answer && question.type === 'slider') return `${answer.value}${question.unit ? ` ${question.unit}` : ''}`
  return 'files' in answer ? answer.files.join('、') : ''
}

// 走确认请求：界面按 scope 画成提问卡。可操作的远程设备也能答（第 673 步起，以前只在本机问）
export async function runAskUser(session: Session, call: StepToolCall, signal: AbortSignal, io: TurnIO): Promise<{ result: ToolResultPart; edited: boolean }> {
  const parsed = askInput.safeParse(call.input)
  if (!parsed.success) return { result: errorResult(call, invalid(parsed.error.issues)), edited: false }
  let questions: AskQuestion[]
  try {
    questions = await Promise.all(parsed.data.questions.map((question) => questionOf(session.cwd, question)))
  } catch (error) {
    if (error instanceof ToolError) return { result: errorResult(call, error.message), edited: false }
    throw error
  }
  const [first] = questions as [AskQuestion]
  const quick = questions.length === 1 && first.type === 'choice' && !first.multiSelect ? first : null
  const card = (status: 'completed' | 'failed', text: string) =>
    io.update({ sessionUpdate: 'tool_call', toolCallId: call.toolCallId, title: `提问 ${first.question}`, kind: 'other', status, content: [{ type: 'content', content: { type: 'text', text } }] })
  const options = [
    ...(quick
      ? quick.options.map((option, index) => ({ optionId: `${ASK_USER_OPTION_PREFIX}${index}`, name: option.label, kind: index === 0 ? ('allow_once' as const) : ('allow_always' as const) }))
      : [{ optionId: ASK_USER_SUBMIT, name: '提交', kind: 'allow_once' as const }]),
    { optionId: ASK_USER_SKIP, name: '都不选，我来说', kind: 'reject_once' as const },
  ]
  const toolCall = { toolCallId: call.toolCallId, title: first.question, kind: 'other' as const, status: 'pending' as const, rawInput: { questions, scope: ASK_USER_SCOPE } }
  const response: { optionId: string; answers?: unknown } | null = io.requestAnswers
    ? await io.requestAnswers(toolCall, options)
    : await io.requestPermission(toolCall, options).then((optionId) => (optionId ? { optionId } : null))
  if (signal.aborted) return { result: errorResult(call, 'Cancelled by the user.'), edited: false }
  const optionId = response?.optionId ?? null
  const answers = quick
    ? optionId?.startsWith(ASK_USER_OPTION_PREFIX)
      ? [{ choice: [Number(optionId.slice(ASK_USER_OPTION_PREFIX.length))] }].filter((answer) => quick.options[answer.choice[0]!])
      : null
    : optionId === ASK_USER_SUBMIT
      ? await checkedAnswers(session.cwd, questions, response?.answers)
      : null
  if (!answers?.length) {
    await card('failed', '没有选')
    return { result: errorResult(call, 'The user did not answer. Say briefly what you need to know in your reply, then stop and wait for their message; do not guess.'), edited: false }
  }
  if (quick) {
    const picked = quick.options[(answers[0] as { choice: number[] }).choice[0]!]!
    await card('completed', `选了：${picked.label}`)
    return { result: textResult(call, `The user chose: ${picked.label}${picked.description ? ` (${picked.description})` : ''}`), edited: false }
  }
  const lines = questions.map((question, index) => `${question.header ?? question.question}：${answerText(question, answers[index]!)}`)
  await card('completed', questions.length === 1 ? `选了：${answerText(first, answers[0]!)}` : lines.join('\n'))
  return { result: textResult(call, ['The user answered:', ...questions.map((question, index) => `- ${question.question} ${answerText(question, answers[index]!)}`)].join('\n')), edited: false }
}

export const INTERACT_TOOLS = { [TODO_TOOL]: todoTool, [ASK_USER_TOOL]: askUserTool }
export const INTERACT_TOOL_CHARS = toolDefinitionChars(INTERACT_TOOLS)
