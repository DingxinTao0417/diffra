import { tool, type ToolResultPart, type ToolSet } from 'ai'
import { z } from 'zod'
import { PERMISSION_OPTIONS, type StoredTurn, type TaskActionParams, type TaskActionResult, type TurnOutcome, TURN_OUTCOME_META_KEY } from '../protocol.js'
import type { SessionIndexEntry } from './store.js'
import { errorResult, type StepToolCall, textResult, type TurnIO } from './loop.js'
import type { Session } from './session.js'
import { toolDefinitionChars } from './tools.js'

// 任务之间互通：主智能体能列出、读别的任务，给它发消息、新建任务、等它这一轮做完。
// 读由 core 直接读会话记录；发消息和新建要客户端载入任务、起一轮（TaskBridge.act）
export interface TaskBridge {
  list(): Promise<SessionIndexEntry[]>
  record(id: string): Promise<{ title: string; cwd: string; running: boolean; turns: StoredTurn[] } | null>
  act(params: TaskActionParams): Promise<TaskActionResult>
}

// 一轮里最多发、建这么多次，免得任务之间互相触发停不下来
export const MAX_TASK_ACTIONS_PER_TURN = 5
const MAX_LISTED = 30
const MAX_REPLY_CHARS = 3_000
const MAX_MESSAGE_CHARS = 20_000
const WAIT_POLL_MS = 2_000
// 消息发出去后对方可能还没开始跑：这么久都没开始就当它没跑
const WAIT_START_GRACE_MS = 15_000
const DEFAULT_WAIT_MINUTES = 30
const MAX_WAIT_MINUTES = 120

const listInput = z.object({ query: z.string().optional().describe('Filter by title or project path') })
const readInput = z.object({ task_id: z.string().min(1), turns: z.number().int().min(1).max(5).optional().describe('How many recent turns to read (default 2)') })
const sendInput = z.object({ task_id: z.string().min(1), message: z.string().min(1).max(MAX_MESSAGE_CHARS) })
const createInput = z.object({
  message: z.string().min(1).max(MAX_MESSAGE_CHARS).describe('The first message of the new task'),
  project: z.string().optional().describe('Absolute project path; defaults to this task’s project'),
  title: z.string().max(80).optional(),
  design: z.boolean().optional().describe('Create a design task (canvas) instead of a coding task'),
})
const waitInput = z.object({ task_id: z.string().min(1), max_minutes: z.number().int().min(1).max(MAX_WAIT_MINUTES).optional() })

export const TASK_TOOLS = {
  tasks_list: tool({
    description: "List the user's other Diffra tasks (separate conversations, each with its own project and model): id, title, project, last activity and whether it is running.",
    inputSchema: listInput,
  }),
  task_read: tool({
    description: 'Read the recent turns of another task: what was asked, its final reply, how each turn ended and which files changed. Use it to check another task’s progress or result.',
    inputSchema: readInput,
  }),
  task_send: tool({
    description:
      'Send a message to another existing task, as if the user typed it there; it starts a turn in that task (queued if it is running). Use it to hand off work that belongs to that task. The other task does not reply to you: use task_wait or task_read for its result.',
    inputSchema: sendInput,
  }),
  task_create: tool({
    description:
      'Create a new task with a first message, for separate work that should have its own conversation (another project, or a long side job). For parts of the current job that should run in parallel and come back to you, use delegate instead.',
    inputSchema: createInput,
  }),
  task_wait: tool({
    description: 'Wait until another task finishes its current turn (no model calls while waiting), then return its latest turn like task_read.',
    inputSchema: waitInput,
  }),
} satisfies ToolSet

export const TASK_TOOL_CHARS = toolDefinitionChars(TASK_TOOLS)

export function isTaskTool(name: string): name is keyof typeof TASK_TOOLS {
  return name in TASK_TOOLS
}

function clip(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-max)}` : text
}

function outcomeOf(turn: StoredTurn): TurnOutcome | null {
  for (const update of [...turn.updates].reverse()) {
    if (update.sessionUpdate !== 'session_info_update') continue
    const outcome = (update._meta?.diffra as Record<string, unknown> | undefined)?.[TURN_OUTCOME_META_KEY]
    if (outcome) return outcome as TurnOutcome
  }
  return null
}

// 一轮的摘要：提问、最终回复（文字和完成卡的总结）、怎么结束的、改了哪些文件
function describeTurn(turn: StoredTurn): string {
  const reply = turn.updates.flatMap((update) => (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? [update.content.text] : [])).join('')
  const finish = turn.updates.flatMap((update) =>
    update.sessionUpdate === 'tool_call_update' && update.status === 'completed' && update.content ? update.content.flatMap((item) => (item.type === 'content' && item.content.type === 'text' ? [item.content.text] : [])) : [],
  )
  const changed = new Set<string>()
  for (const update of turn.updates) if (update.sessionUpdate === 'tool_call_update' || update.sessionUpdate === 'tool_call') for (const item of update.content ?? []) if (item.type === 'diff') changed.add(item.path)
  const outcome = outcomeOf(turn)
  const ended = !turn.endedAt ? 'still running' : outcome?.stop ? `stopped (${outcome.stop})` : outcome?.finish ? `finished (${outcome.finish})` : `ended (${turn.stopReason ?? 'unknown'})`
  return [
    `- Asked (${turn.startedAt}${turn.from ? `, sent by task ${turn.from.sessionId}` : ''}): ${clip(turn.prompt.trim(), 1_000)}`,
    `  Ended: ${ended}`,
    reply.trim() ? `  Reply: ${clip(reply.trim(), MAX_REPLY_CHARS)}` : '',
    !reply.trim() && finish.length > 0 ? `  Last result: ${clip(finish.at(-1)!.trim(), MAX_REPLY_CHARS)}` : '',
    changed.size > 0 ? `  Changed files: ${[...changed].join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

async function readTask(bridge: TaskBridge, id: string, turns: number): Promise<string> {
  const record = await bridge.record(id)
  if (!record) throw new Error(`No task with id ${id}. Use tasks_list to find it.`)
  const recent = record.turns.filter((turn) => turn.kind === 'prompt' || turn.kind === 'goal').slice(-turns)
  return [`Task ${id}: "${record.title}" in ${record.cwd}${record.running ? ' (running now)' : ''}`, ...(recent.length > 0 ? recent.map(describeTurn) : ['(no turns yet)'])].join('\n')
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

const TITLES: Record<keyof typeof TASK_TOOLS, string> = {
  tasks_list: '列出任务',
  task_read: '读取任务',
  task_send: '发给任务',
  task_create: '新建任务',
  task_wait: '等任务做完',
}

// 每轮用了几次发送、新建：按轮次 id 记，只留最近一轮
const actionCounts = new WeakMap<Session, { turnId: string; count: number }>()

export async function runTaskTool(
  session: Session,
  call: StepToolCall & { toolName: keyof typeof TASK_TOOLS },
  signal: AbortSignal,
  io: TurnIO,
): Promise<{ result: ToolResultPart; edited: boolean }> {
  const name = call.toolName
  const fail = async (message: string) => {
    await io.update({ sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: message } }] })
    return { result: errorResult(call, message), edited: false }
  }
  await io.update({ sessionUpdate: 'tool_call', toolCallId: call.toolCallId, title: TITLES[name], kind: name === 'task_send' || name === 'task_create' ? 'other' : 'read', status: 'in_progress', rawInput: call.input })
  const bridge = io.tasks
  if (!bridge) return fail('Talking to other tasks is not available here.')
  const done = async (text: string, title: string, meta?: Record<string, unknown>) => {
    await io.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: call.toolCallId,
      status: 'completed',
      title,
      content: [{ type: 'content', content: { type: 'text', text } }],
      ...(meta ? { _meta: { diffra: meta } } : {}),
    })
    return { result: textResult(call, text), edited: false }
  }
  try {
    if (name === 'tasks_list') {
      const { query } = listInput.parse(call.input)
      const words = query?.trim().toLowerCase()
      const entries = (await bridge.list())
        .filter((entry) => entry.id !== session.id && !entry.archived && (!words || entry.title.toLowerCase().includes(words) || entry.cwd.toLowerCase().includes(words)))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, MAX_LISTED)
      const lines = await Promise.all(entries.map(async (entry) => `${entry.id} · "${entry.title}" · ${entry.cwd} · updated ${entry.updatedAt}${(await bridge.record(entry.id))?.running ? ' · running' : ''}`))
      return done(lines.length > 0 ? lines.join('\n') : 'No other tasks.', `列出任务 · ${lines.length} 个`)
    }
    if (name === 'task_read') {
      const { task_id, turns } = readInput.parse(call.input)
      const record = await bridge.record(task_id)
      return done(await readTask(bridge, task_id, turns ?? 2), `读取任务 ${record?.title ?? task_id}`, { taskLink: { sessionId: task_id, title: record?.title ?? '' } })
    }
    if (name === 'task_wait') {
      const { task_id, max_minutes } = waitInput.parse(call.input)
      const first = await bridge.record(task_id)
      if (!first) return fail(`No task with id ${task_id}.`)
      const started = Date.now()
      const deadline = started + (max_minutes ?? DEFAULT_WAIT_MINUTES) * 60_000
      let seenRunning = first.running
      await io.update({ sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, title: `等任务做完 ${first.title}`, _meta: { diffra: { taskLink: { sessionId: task_id, title: first.title } } } })
      for (;;) {
        const record = await bridge.record(task_id)
        if (!record) return fail(`Task ${task_id} was deleted.`)
        if (record.running) seenRunning = true
        const finished = !record.running && (seenRunning || Date.now() - started > WAIT_START_GRACE_MS)
        if (finished) return done(await readTask(bridge, task_id, 1), `等任务做完 ${record.title}`, { taskLink: { sessionId: task_id, title: record.title } })
        if (signal.aborted) return fail('Cancelled by the user.')
        if (Date.now() > deadline) return fail(`Task ${task_id} is still running after ${max_minutes ?? DEFAULT_WAIT_MINUTES} minutes. Check later with task_read.`)
        await sleep(WAIT_POLL_MS, signal)
      }
    }
    // 发消息、新建任务：被别的任务叫起来的这一轮不能再往外发，免得互相触发；每轮有次数上限；按权限模式确认
    const current = session.turns.at(-1)
    if (current?.from) return fail('This turn was started by a message from another task, so it cannot send to or create tasks. Finish the work here; the sender reads your result.')
    const counted = actionCounts.get(session)
    const count = counted && counted.turnId === current?.id ? counted.count : 0
    if (count >= MAX_TASK_ACTIONS_PER_TURN) return fail(`At most ${MAX_TASK_ACTIONS_PER_TURN} task messages per turn.`)
    const from = { sessionId: session.id, title: session.title }
    let params: TaskActionParams
    let question: string
    if (name === 'task_send') {
      const { task_id, message } = sendInput.parse(call.input)
      if (task_id === session.id) return fail('That is this task. Send to a different task.')
      const record = await bridge.record(task_id)
      if (!record) return fail(`No task with id ${task_id}. Use tasks_list to find it.`)
      params = { sessionId: session.id, action: 'send', target: task_id, message, from }
      question = `向任务「${record.title}」发送消息`
    } else {
      const input = createInput.parse(call.input)
      const project = input.project ?? (session.noProject ? null : session.cwd)
      params = { sessionId: session.id, action: 'create', project, title: input.title ?? null, design: input.design ?? false, message: input.message, from }
      question = `新建${input.design ? '设计' : ''}任务${input.title ? `「${input.title}」` : ''}`
    }
    if (session.permissionMode !== 'full') {
      const choice = await io.requestPermission(
        { toolCallId: call.toolCallId, title: question, kind: 'other', status: 'pending', rawInput: call.input },
        [
          { optionId: PERMISSION_OPTIONS.allowOnce, name: '发送', kind: 'allow_once' },
          { optionId: PERMISSION_OPTIONS.reject, name: '不发', kind: 'reject_once' },
        ],
      )
      if (signal.aborted) return fail('Cancelled by the user.')
      if (choice !== PERMISSION_OPTIONS.allowOnce) return fail('The user declined. Do not send it again unless they ask.')
    }
    actionCounts.set(session, { turnId: current?.id ?? '', count: count + 1 })
    const result = await bridge.act(params)
    if (!result.ok) return fail(result.error)
    const verb = name === 'task_send' ? (result.queued ? 'Queued for' : 'Sent to') : 'Created'
    return done(
      `${verb} task ${result.sessionId} ("${result.title}"). It runs on its own; use task_wait or task_read to get its result.`,
      `${name === 'task_send' ? '发给任务' : '新建任务'} ${result.title}${result.queued ? '（排队中）' : ''}`,
      { taskLink: { sessionId: result.sessionId, title: result.title } },
    )
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}
