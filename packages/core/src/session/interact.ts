import { tool, type ToolResultPart } from 'ai'
import { z } from 'zod'
import { ASK_USER_OPTION_PREFIX, ASK_USER_SCOPE, ASK_USER_SKIP, formatSteps, LOCAL_ONLY_META, STEPS_CARD_TITLE } from '../protocol.js'
import { errorResult, type StepToolCall, textResult, type TurnIO } from './loop.js'
import type { Session } from './session.js'
import { toolDefinitionChars } from './tools.js'

// 两个让智能体和用户对上进度的工具（第 441、442 步，参照 qwen-code 的 todo_write 和 ask_user_question）：
// 步骤清单让用户看到它打算做哪几步、做到哪了；提问让它在岔路口先问，不用结束这一轮等回复

export const TODO_TOOL = 'todo_write'
export const ASK_USER_TOOL = 'ask_user'

const todoInput = z.object({
  todos: z
    .array(
      z.object({
        content: z.string().trim().min(1).max(200).describe('One concrete step, in the language the user writes in'),
        status: z.enum(['pending', 'in_progress', 'completed']),
      }),
    )
    .min(1)
    .max(30)
    .describe('The whole list every time, in order'),
})

export const todoTool = tool({
  description: [
    'Show the user your step list for the current task and keep it up to date. Send the whole list each time.',
    'Use it for work with three or more distinct steps; skip it for a question or a one-step change.',
    'Mark a step in_progress when you start it and completed as soon as it is done; keep at most one step in_progress. Add or reword steps when the plan changes.',
    'Do not repeat the list in your reply: the user sees it as a card.',
  ].join('\n'),
  inputSchema: todoInput,
})

const invalid = (issues: z.core.$ZodIssue[]) => `Invalid arguments: ${issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`

// 一轮一张步骤卡：同一轮里每次更新都发同一个 id，界面整张替换，不会越积越多
export async function runTodoWrite(session: Session, call: StepToolCall, io: TurnIO): Promise<{ result: ToolResultPart; edited: boolean }> {
  const parsed = todoInput.safeParse(call.input)
  if (!parsed.success) return { result: errorResult(call, invalid(parsed.error.issues)), edited: false }
  const steps = parsed.data.todos
  const done = steps.filter((step) => step.status === 'completed').length
  await io.update({
    sessionUpdate: 'tool_call',
    toolCallId: `steps-${session.turns.at(-1)?.id ?? session.id}`,
    title: STEPS_CARD_TITLE,
    kind: 'think',
    status: done === steps.length ? 'completed' : 'in_progress',
    content: [{ type: 'content', content: { type: 'text', text: formatSteps(steps) } }],
  })
  return { result: textResult(call, `Step list updated: ${done} of ${steps.length} done. Keep it current as you work.`), edited: false }
}

const askInput = z.object({
  question: z.string().trim().min(1).max(500).describe('One clear question, in the language the user writes in'),
  options: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(40).describe('Short button text for this choice'),
        description: z.string().trim().max(200).optional().describe('What choosing it means, when the label alone is not enough'),
      }),
    )
    .min(2)
    .max(4)
    .describe('Mutually exclusive choices; put the one you recommend first'),
})

export const askUserTool = tool({
  description: [
    'Ask the user to choose between 2-4 options and wait for the answer, without ending your turn.',
    'Use it only when the choice changes what you build (an ambiguous requirement, two reasonable designs, a risky step) and you cannot settle it from the code or the conversation. Do not ask for permission to continue or about details with an obvious default.',
    'The user can also decline to pick; then say what you need in your reply and stop.',
  ].join('\n'),
  inputSchema: askInput,
})

// 走确认请求：界面按 scope 画成提问卡，按钮是各个选项。只在本机问——远程设备的确认只有「允许一次」「拒绝」两种
export async function runAskUser(call: StepToolCall, signal: AbortSignal, io: TurnIO): Promise<{ result: ToolResultPart; edited: boolean }> {
  const parsed = askInput.safeParse(call.input)
  if (!parsed.success) return { result: errorResult(call, invalid(parsed.error.issues)), edited: false }
  const { question, options } = parsed.data
  const card = (status: 'completed' | 'failed', text: string) =>
    io.update({ sessionUpdate: 'tool_call', toolCallId: call.toolCallId, title: `提问 ${question}`, kind: 'other', status, content: [{ type: 'content', content: { type: 'text', text } }] })
  const choice = await io.requestPermission(
    { toolCallId: call.toolCallId, title: question, kind: 'other', status: 'pending', rawInput: { question, options, scope: ASK_USER_SCOPE }, _meta: LOCAL_ONLY_META },
    [
      ...options.map((option, index) => ({ optionId: `${ASK_USER_OPTION_PREFIX}${index}`, name: option.label, kind: index === 0 ? ('allow_once' as const) : ('allow_always' as const) })),
      { optionId: ASK_USER_SKIP, name: '都不选，我来说', kind: 'reject_once' as const },
    ],
  )
  if (signal.aborted) return { result: errorResult(call, 'Cancelled by the user.'), edited: false }
  const picked = choice?.startsWith(ASK_USER_OPTION_PREFIX) ? options[Number(choice.slice(ASK_USER_OPTION_PREFIX.length))] : undefined
  if (!picked) {
    await card('failed', '没有选')
    return { result: errorResult(call, 'The user did not pick any option. Say briefly what you need to know in your reply, then stop and wait for their message; do not guess.'), edited: false }
  }
  await card('completed', `选了：${picked.label}`)
  return { result: textResult(call, `The user chose: ${picked.label}${picked.description ? ` (${picked.description})` : ''}`), edited: false }
}

export const INTERACT_TOOLS = { [TODO_TOOL]: todoTool, [ASK_USER_TOOL]: askUserTool }
export const INTERACT_TOOL_CHARS = toolDefinitionChars(INTERACT_TOOLS)
