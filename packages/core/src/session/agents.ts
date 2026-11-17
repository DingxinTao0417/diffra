import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { SessionUpdate, ToolCallUpdate } from '@agentclientprotocol/sdk'
import { type ModelMessage, tool, type ToolChoice, type ToolResultPart, type ToolSet } from 'ai'
import { z } from 'zod'
import { toModelError } from '../models/errors.js'
import { ToolError } from '../tools/types.js'
import { type AgentType, EXPLORE_AGENT } from '../subagents.js'
import { AGENT_META_KEY, type AgentCardMeta, type AgentTag, PARENT_TOOL_CALL_META_KEY, type PromptImage } from '../protocol.js'
import { screenshotMessage } from './browser.js'
import { designInstructions, designTools } from './design.js'
import {
  type ActiveModel,
  type AgentScope,
  CONTEXT_STOP_RATIO,
  DEFAULT_CONTEXT_WINDOW,
  assistantText,
  callSignature,
  describeCall,
  errorResult,
  type PrefetchedReads,
  prefetchReads,
  reportInvalidCall,
  runToolCall,
  STUCK_REPEATS,
  type StepToolCall,
  streamModelStep,
  textResult,
  INTERRUPTION_NOTE,
  TRUNCATION_NOTE,
  type TurnIO,
} from './loop.js'
import type { Session } from './session.js'
import { isPolling, newSpinTracker, noteCall, noteEdit, noteText, takeSpinReminders } from './spin.js'
import { isReadOnlyCommand } from '../permissions.js'
import { READ_ONLY_TOOLS, readOnlyCommandProblem } from './read-only.js'
import { freshWorldState } from './world-state.js'
import { toolDefinitionChars, TOOLS } from './tools.js'

// 子智能体（工人）：主智能体用 delegate 把一块独立的活交出去，几个工人并行做，做完交回结果，主智能体再整合、检查、收尾。
// 工人有自己的对话，只能改自己认领的文件（同一目录、按文件认领，不用 worktree）；交回结果就停，也不能再派工人。
// 工人的工具调用照常发给界面，带上所属卡片（parentToolCallId）和自己的名字、颜色，界面收进那张卡片里
export const DELEGATE_TOOL = 'delegate'
export const MAX_PARALLEL_WORKERS = 4
export const MAX_WORKERS_PER_TURN = 8
export const WORKER_MAX_STEPS = 40
const REPORT_TOOL = 'report'
// 工人没交结果时带回它最近写的几段话：给主智能体的和卡片上显示的各有长度上限
const KEPT_NOTES = 5
const MAX_NOTES_CHARS = 2000
const MAX_UI_NOTES_CHARS = 300
const DESIGN_EVAL_TOOL = 'design_eval'
const NEWLINE = String.fromCharCode(10)
// 设计页里的内部动作：认领节点、工人结束（释放锁、收起光标）
export const DESIGN_AGENT_CLAIM = '__agent_claim'
export const DESIGN_AGENT_DONE = '__agent_done'
const CLAIM_TOOL = 'claim_files'
// 区分度高、深浅色下都看得清的几种颜色，按派出顺序轮流用
export const AGENT_COLORS = ['#2563EB', '#D97706', '#16A34A', '#DB2777', '#7C3AED', '#0891B2', '#DC2626', '#65A30D']
const WORKER_TOOL_NAMES = ['exec_command', 'write_stdin', 'apply_patch'] as const

const delegateInput = z.object({
  name: z.string().trim().min(1).max(16).describe('Short name for this worker, shown to the user, e.g. "API" or "Settings page"'),
  task: z
    .string()
    .min(1)
    .describe('Everything the worker needs: the goal, the relevant files and functions, interfaces it must keep, and what to report back. It does not see this conversation.'),
  files: z
    .array(z.string().min(1))
    .max(50)
    .optional()
    .describe('Files or directories (relative to the project) this worker owns and may change. Give each worker a different set.'),
  nodes: z
    .array(z.string().min(1))
    .max(50)
    .optional()
    .describe('Design tasks only: IDs of the canvas nodes (frames, sections) this worker owns. It can change them and everything inside them, plus the new nodes it creates.'),
  agent: z.string().trim().min(1).max(32).optional().describe('Worker type, only when the project defines worker types and one of them fits this part (see the tool description)'),
})

const reportInput = z.object({
  summary: z.string().min(1).describe("What you did, in the user's language: the changes, decisions, and how you checked them"),
  issues: z.string().optional().describe('Anything left unresolved, needed from other parts, or that the coordinator should check'),
})

const claimInput = z.object({ files: z.array(z.string().min(1)).min(1).max(50).describe('Files or directories, relative to the project') })

// 设计任务里工人按画布上的节点分工；普通任务按文件。
// types 是能派的工人类型：内置的 explore 和项目里自定义的（.diffra/agents），都在 subagents.ts；列在工具说明里，主智能体用 agent 参数选。
// 主智能体只靠这段说明判断派不派（第 449 步）：先讲代价，再分开列该派和不该派的情况，拿不准就自己做
export function delegateTool(design = false, types: AgentType[] = []) {
  const explore = types.some((type) => type.name === EXPLORE_AGENT)
  return tool({
    description: [
      'Hand a self-contained piece of work to a worker agent that runs in its own context and reports back.',
      'A worker costs more than it looks: it starts knowing only what you write in task, has to find everything else again, and you get back only its report.',
      ...(types.length > 0
        ? [
            `Worker types (pass one as agent when it fits; omit agent for a general worker that can change files): ${types.map((type) => `${type.name}${type.readOnly ? ' (read-only)' : ''} — ${type.description}`).join('; ')}.`,
          ]
        : []),
      ...(design
        ? [
            'In this design task, set up the variables, components and page frames yourself first, then give each worker its own frames or sections in nodes (several workers can work on the same page in different sections). Workers can read the whole document but only change their own nodes and the nodes they create.',
          ]
        : [
            `Use it when: (1) answering a question or preparing a change needs a broad look through code you do not know yet (several modules, many files) and you only need the conclusion${explore ? `: send an ${EXPLORE_AGENT} worker and keep your own context for the work itself` : ''}; ` +
              '(2) a larger change splits into independent parts that touch different files: one worker per part, each owning a different set of files (workers can read everything but only change what they own).',
            'Do not use it when: a few tool calls would do; you have not looked at the project yourself yet (list the files first: a small project does not need a worker); you already know which file or symbol to look at (read or search it yourself); the task is small or a single-file change; the parts depend on each other or touch the same files. When unsure, do the work yourself.',
          ]),
      'Call delegate several times in one step to run up to 4 workers in parallel (at most 8 per turn); the step waits until all of them report back.',
      'In task, write: the goal and what it is for, what you already know or have ruled out, where to start (files, functions), what must not change, and what to report back.',
      'Workers only report back: after they report, read their results, check the claims you are going to rely on, make the parts fit together, and verify before you end your turn.',
    ].join(' '),
    inputSchema: delegateInput,
  })
}

// 上下文明细里 delegate 工具定义占的字数
export function delegateChars(design: boolean, types: AgentType[] = []): number {
  return toolDefinitionChars({ [DELEGATE_TOOL]: delegateTool(design, types) })
}

const WORKER_TOOLS: ToolSet = {
  ...Object.fromEntries(WORKER_TOOL_NAMES.map((name) => [name, TOOLS[name]])),
  [CLAIM_TOOL]: tool({ description: 'Claim more files or directories before changing them. Files another worker owns are refused.', inputSchema: claimInput }),
  [REPORT_TOOL]: tool({ description: 'Finish your part and report back to the coordinator. Call it exactly once, at the end.', inputSchema: reportInput }),
}


// 一轮里的认领表和工人记录：认领在工人交回结果时释放，同一轮后面派的工人可以接着认领
export interface Team {
  // 项目相对路径（/ 分隔，目录不带结尾的 /）→ 认领它的工人
  claims: Map<string, AgentTag>
  // 这一轮派过的工人数，用来分颜色和限数
  count: number
  // 工人用 apply_patch 改的文件，按时间顺序；判断命令改了哪些文件时排除同一时段别的工人自己改的
  edits: Array<{ agentId: string; path: string }>
  // 所有工人的权限确认排成一队：界面上一个任务同一时间只显示一张确认卡，同时发出的第二个请求会把第一个顶掉，被顶掉的那个工人就一直等着
  permissions: { chain: Promise<unknown> }
}

export function newTeam(): Team {
  return { claims: new Map(), count: 0, edits: [], permissions: { chain: Promise.resolve() } }
}

function projectPath(session: Session, input: string): string | null {
  const absolute = resolve(session.cwd, input)
  const path = relative(session.cwd, absolute)
  if (path === '' || path.startsWith('..') || isAbsolute(path)) return null
  return path.split(sep).join('/').replace(/\/+$/, '')
}

// 路径本身或它的上级目录被别人认领，或者它是目录、里面有别人认领的东西，都算冲突。Windows 上路径不分大小写
function ownerConflict(team: Team, agentId: string, path: string): AgentTag | null {
  const fold = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value)
  const target = fold(path)
  for (const [claimed, owner] of team.claims) {
    if (owner.id === agentId) continue
    const other = fold(claimed)
    if (other === target || target.startsWith(`${other}/`) || other.startsWith(`${target}/`)) return owner
  }
  return null
}

function claim(team: Team, tag: AgentTag, path: string): AgentTag | null {
  const conflict = ownerConflict(team, tag.id, path)
  if (!conflict) team.claims.set(path, tag)
  return conflict
}

function claimsOf(team: Team, agentId: string): string[] {
  return [...team.claims].flatMap(([path, owner]) => (owner.id === agentId ? [path] : []))
}

function release(team: Team, agentId: string): void {
  for (const [path, owner] of team.claims) if (owner.id === agentId) team.claims.delete(path)
}

interface Worker {
  tag: AgentTag
  task: string
  // 设计任务里负责的节点（设计页按它加锁）
  nodes: string[]
  // 界面卡片的 id（那次 delegate 调用）
  cardId: string
  // 改过的文件（项目相对路径），apply_patch 和命令改的都算
  edited: Set<string>
  // 命令改到别人认领的文件
  boundary: string[]
  steps: number
  // 工人类型（内置的 explore 或自定义的）；没指定就是通用工人
  type: AgentType | null
  // 最近几步里它说的话
  notes: string[]
  // 卡片上的用时和用量（第 659 步）：排队等别的工人时还没开始
  startedAt: number | null
  endedAt: number | null
  tokens: number
}

type WorkerOutcome =
  | { kind: 'reported'; summary: string; issues: string | null }
  | { kind: 'max-steps' }
  | { kind: 'stuck'; call: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string }

function cardMeta(team: Team, worker: Worker): AgentCardMeta {
  return {
    ...worker.tag,
    task: worker.task,
    files: claimsOf(team, worker.tag.id),
    nodes: worker.nodes,
    ...(worker.startedAt === null ? {} : { startedAt: worker.startedAt }),
    ...(worker.endedAt === null ? {} : { endedAt: worker.endedAt }),
    tokens: worker.tokens,
    edited: [...worker.edited],
  }
}

function withAgentMeta<T extends { _meta?: { [key: string]: unknown } | null }>(value: T, worker: Worker): T {
  const meta = value._meta ?? {}
  const diffra = typeof meta.diffra === 'object' && meta.diffra !== null ? (meta.diffra as Record<string, unknown>) : {}
  return { ...value, _meta: { ...meta, diffra: { ...diffra, [PARENT_TOOL_CALL_META_KEY]: worker.cardId, [AGENT_META_KEY]: worker.tag } } }
}

// 工人的输出：文字和思考不进主对话；工具调用带上所属卡片和工人；id 加前缀，免得和别的工人、主智能体的撞上。
// 模型没有输出的提示（工人只发这一种 session_info_update）同样带上工人，界面按工人分开记。
// 几个工人同时要确认权限时排队，一个一个问；用量记成子智能体
function workerIO(io: TurnIO, worker: Worker, permissions: { chain: Promise<unknown> }): TurnIO {
  const uiId = (id: string) => `${worker.tag.id}/${id}`
  return {
    update: async (update: SessionUpdate) => {
      if (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk' || update.sessionUpdate === 'usage_update') return
      if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        if (update.sessionUpdate === 'tool_call') worker.steps++
        await io.update(withAgentMeta({ ...update, toolCallId: uiId(update.toolCallId) }, worker))
        return
      }
      if (update.sessionUpdate === 'session_info_update') {
        await io.update(withAgentMeta(update, worker))
        return
      }
      await io.update(update)
    },
    requestPermission: (toolCall: ToolCallUpdate, options) => {
      const asked = permissions.chain.then(() => io.requestPermission(withAgentMeta({ ...toolCall, toolCallId: uiId(toolCall.toolCallId) }, worker), options))
      permissions.chain = asked.catch(() => null)
      return asked
    },
    recordUsage: (call) => {
      worker.tokens += (call.usage.inputTokens ?? 0) + (call.usage.outputTokens ?? 0)
      return io.recordUsage({ ...call, role: 'subagent' })
    },
    // 设计页按调用的工人加节点锁、画光标
    ...(io.design ? { design: (tool, args, signal) => io.design!(tool, args, signal, worker.tag) } : {}),
  }
}

// 接在工人的系统提示词（prompt.ts 的 worker 那一份）后面
function workerRules(worker: Worker, owned: string[]): string {
  return [
    `You are "${worker.tag.name}", a worker agent. A coordinating agent gave you one part of a larger task; other workers may be handling other parts at the same time. You do not see the coordinator's conversation or the user's messages: the task below is everything you were told.`,
    `- When your part is done, call ${REPORT_TOOL} exactly once. The report is the only thing the coordinator receives, so put everything it needs in it.`,
    ...(worker.type?.readOnly
      ? ['- You are read-only: you can only run read-only commands with exec_command (rg, rg --files, sed -n, cat, ls, git log, git diff) and cannot change files. Investigate and report.']
      : [
          `- Change only files you own${owned.length > 0 ? ` (${owned.join(', ')})` : ''}. Reading any file is fine. To change another file, call ${CLAIM_TOOL} first; if another worker owns it, leave it alone and mention it in your report.`,
          '- Do not start long-running commands (dev servers, watchers); run only quick, targeted commands when they help. Say in your report what you ran and whether it passed.',
          '- Other workers may change other files while you work. If you need something from their part, do not build it yourself: describe it in your report.',
        ]),
    ...(worker.nodes.length > 0
      ? [`- On the design canvas you own these nodes: ${worker.nodes.join(', ')}. Build inside them; changing nodes other workers own is refused. You cannot use eval.`]
      : []),
  ].join('\n')
}

async function runWorker(session: Session, team: Team, worker: Worker, active: ActiveModel, signal: AbortSignal, io: TurnIO): Promise<WorkerOutcome> {
  const owned = claimsOf(team, worker.tag.id)
  const wio = workerIO(io, worker, team.permissions)
  const scope: AgentScope = {
    beforeWrite: (target) => {
      const path = projectPath(session, target.absolute)
      // 项目外的写入照常走外部路径的授权，不在认领范围里
      if (!path) return
      const conflict = claim(team, worker.tag, path)
      if (conflict) throw new ToolError(`${path} is owned by worker "${conflict.name}". Do not change it; mention what it needs in your report.`)
    },
    onEdited: (absolutePath) => {
      const path = projectPath(session, absolutePath)
      if (!path) return
      worker.edited.add(path)
      team.edits.push({ agentId: worker.tag.id, path })
    },
  }
  // 类型的说明接在工人规则后面；只读类型工具也只给读和搜索的
  const typeNote = worker.type ? `\n\nYou are a "${worker.type.name}" worker.\n${worker.type.instructions}` : ''
  const system = `${session.workerPrompt}${designInstructions(session)}\n\n${workerRules(worker, owned)}${typeNote}`
  const ownedLine = [
    worker.type?.readOnly ? '' : owned.length > 0 ? `Files you own: ${owned.join(', ')}` : `You do not own any files yet; call ${CLAIM_TOOL} before changing a file.`,
    worker.nodes.length > 0 ? `Nodes you own: ${worker.nodes.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(NEWLINE)
  // 设计任务的工人还能用设计工具（除了 eval：它能绕过节点锁）
  const designSet = Object.fromEntries(Object.entries(designTools(session)).filter(([name]) => name !== DESIGN_EVAL_TOOL))
  // 只读类型的工人：exec_command 只许跑只读命令，没有 apply_patch 和认领。用到时再拼：read-only.ts 和这里互相引用，模块加载时它可能还没准备好
  const baseTools: ToolSet = worker.type?.readOnly ? { ...READ_ONLY_TOOLS, [REPORT_TOOL]: WORKER_TOOLS[REPORT_TOOL]! } : WORKER_TOOLS
  const tools: ToolSet = { ...baseTools, ...(worker.type?.readOnly ? {} : designSet) }
  // 工人自己从头开对话：环境和项目说明文件全量给一份
  const messages: ModelMessage[] = [await freshWorldState(session), { role: 'user', content: `${worker.task}\n\n${ownedLine}` }]
  const window = active.config.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  let nearLimit = false
  // 和主循环一样的防打转（第 452 步）：同一个调用、同样的结果连着 3 次先提醒，提醒后还犯就停下这个工人；另有只提醒不停的几种（spin.ts）
  const repeats = new Map<string, number>()
  let warnedStuck = false
  const spin = newSpinTracker()
  for (let step = 0; step < WORKER_MAX_STEPS; step++) {
    // 最后一步或上下文快满时要求直接交结果
    const toolChoice: ToolChoice<ToolSet> = step === WORKER_MAX_STEPS - 1 || nearLimit ? { type: 'tool', toolName: REPORT_TOOL } : 'auto'
    const { toolCalls, inputTokens, answered, responseMessages, truncated, interrupted } = await streamModelStep(
      { model: active.language, system, messages, tools, toolChoice, usage: { role: 'subagent', provider: active.config.provider, modelId: active.config.modelId } },
      signal,
      wio,
      { key: worker.tag.id, handles: session.stepRetries },
    )
    messages.push(...responseMessages)
    nearLimit = inputTokens > window * CONTEXT_STOP_RATIO
    // 工人说的话不进主对话，留最近几段：没交结果就停下时带回给主智能体（第 451 步）
    const said = assistantText(responseMessages).trim()
    if (said) {
      worker.notes.push(said)
      if (worker.notes.length > KEPT_NOTES) worker.notes.shift()
      noteText(spin, said)
    }
    if (signal.aborted) return { kind: 'cancelled' }
    if (toolCalls.length === 0) {
      messages.push({ role: 'user', content: truncated ? (interrupted ? INTERRUPTION_NOTE : TRUNCATION_NOTE) : `Keep working with the tools, or call ${REPORT_TOOL} when your part is done.` })
      continue
    }
    const results: ToolResultPart[] = []
    const images: PromptImage[] = []
    let repeated: StepToolCall | null = null
    const prefetched: PrefetchedReads = new Map()
    for (const [index, call] of toolCalls.entries()) {
      if (answered.has(call.toolCallId)) {
        await reportInvalidCall(call, wio)
        continue
      }
      if (signal.aborted) {
        results.push(errorResult(call, 'Cancelled by the user.'))
        continue
      }
      if (call.toolName === REPORT_TOOL && !call.invalid) {
        const report = reportInput.safeParse(call.input)
        if (report.success) return { kind: 'reported', summary: report.data.summary, issues: report.data.issues?.trim() || null }
        results.push(errorResult(call, report.error.issues.map((issue) => issue.message).join('; ')))
        continue
      }
      if (call.toolName === CLAIM_TOOL && !call.invalid && Object.hasOwn(tools, CLAIM_TOOL)) {
        results.push(await claimFiles(session, team, worker, call, wio, io))
        continue
      }
      // 按这个工人实际拿到的工具判断：只读类型没有 apply_patch，命令也只能是只读的，模型硬调也不执行
      if (!Object.hasOwn(tools, call.toolName)) {
        results.push(errorResult(call, `You cannot use ${call.toolName}. Your tools: ${Object.keys(tools).join(', ')}.`))
        continue
      }
      const readOnlyProblem = worker.type?.readOnly ? readOnlyCommandProblem(call.toolName, call.input) : null
      if (readOnlyProblem) {
        results.push(errorResult(call, readOnlyProblem))
        continue
      }
      let outcome: Awaited<ReturnType<typeof runToolCall>>
      const command = call.toolName === 'exec_command' && !call.invalid && typeof call.input === 'object' && call.input !== null && 'cmd' in call.input && typeof call.input.cmd === 'string' ? call.input.cmd : null
      if (command !== null && !isReadOnlyCommand(command)) {
        outcome = { result: await runWorkerCommand(session, team, worker, call, signal, wio, scope), edited: false }
      } else {
        prefetchReads(session, toolCalls, index, answered, prefetched, signal, wio, scope)
        outcome = await (prefetched.get(call.toolCallId) ?? runToolCall(session, call, signal, wio, scope))
      }
      results.push(outcome.result)
      images.push(...(outcome.images ?? []))
      if (outcome.edited) {
        repeats.clear()
        noteEdit(spin)
      } else {
        noteCall(spin, call.toolName, call.input)
        if (!isPolling(call.toolName, call.input) || outcome.result.output.type === 'error-text') {
          const key = callSignature(call, outcome.result)
          const count = (repeats.get(key) ?? 0) + 1
          repeats.set(key, count)
          if (count >= STUCK_REPEATS) repeated = call
        }
      }
    }
    if (results.length > 0) messages.push({ role: 'tool', content: results })
    if (images.length > 0) messages.push(screenshotMessage(images))
    if (truncated && toolCalls.some((call) => answered.has(call.toolCallId))) messages.push({ role: 'user', content: TRUNCATION_NOTE })
    if (repeated && warnedStuck) return { kind: 'stuck', call: describeCall(repeated) }
    if (repeated) {
      warnedStuck = true
      repeats.clear()
      messages.push({
        role: 'user',
        content:
          `[Diffra] You made the same call ${STUCK_REPEATS} times and got the same result each time, without changing any file in between. ` +
          `Stop repeating it: try a different approach, or call ${REPORT_TOOL} and explain what is blocking you.`,
      })
    }
    for (const reminder of takeSpinReminders(spin)) messages.push({ role: 'user', content: reminder })
  }
  return { kind: 'max-steps' }
}

async function claimFiles(session: Session, team: Team, worker: Worker, call: StepToolCall, wio: TurnIO, io: TurnIO): Promise<ToolResultPart> {
  await wio.update({ sessionUpdate: 'tool_call', toolCallId: call.toolCallId, title: '认领文件', kind: 'other', status: 'in_progress', rawInput: call.input })
  const input = claimInput.safeParse(call.input)
  if (!input.success) {
    const message = input.error.issues.map((issue) => issue.message).join('; ')
    await wio.update({ sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: message } }] })
    return errorResult(call, message)
  }
  const granted: string[] = []
  const refused: string[] = []
  for (const raw of input.data.files) {
    const path = projectPath(session, raw)
    if (!path) {
      refused.push(`${raw} (outside the project)`)
      continue
    }
    const conflict = claim(team, worker.tag, path)
    if (conflict) refused.push(`${path} (owned by "${conflict.name}")`)
    else granted.push(path)
  }
  // 卡片上的认领清单整份重发
  await io.update({ sessionUpdate: 'tool_call_update', toolCallId: worker.cardId, _meta: { diffra: { [AGENT_META_KEY]: cardMeta(team, worker) } } })
  const text = [granted.length > 0 ? `Claimed: ${granted.join(', ')}.` : '', refused.length > 0 ? `Not claimed: ${refused.join(', ')}.` : ''].filter(Boolean).join(' ')
  await wio.update({
    sessionUpdate: 'tool_call_update',
    toolCallId: call.toolCallId,
    status: 'completed',
    title: `认领 ${input.data.files.join('、')}`,
    content: [{ type: 'content', content: { type: 'text', text: [granted.length > 0 ? `已认领：${granted.join('、')}` : '', refused.length > 0 ? `未认领：${refused.join('、')}` : ''].filter(Boolean).join('\n') } }],
  })
  return textResult(call, text)
}

// 命令可能改任何文件，认领拦不住：跑完对比工作区，把改到别人认领的文件记下来报告给主智能体。
// 同一时段别的工人用 apply_patch 改的文件不算在这条命令头上；两个工人的命令同时改了同一批文件时分不清是谁改的
async function runWorkerCommand(session: Session, team: Team, worker: Worker, call: StepToolCall, signal: AbortSignal, wio: TurnIO, scope: AgentScope): Promise<ToolResultPart> {
  const before = session.checkpoints ? await session.checkpoints.fingerprint().catch(() => null) : null
  const editsBefore = team.edits.length
  const outcome = await runToolCall(session, call, signal, wio, scope)
  if (!before || !session.checkpoints) return outcome.result
  const changes = await session.checkpoints.changesSince(before).catch(() => null)
  if (!changes) return outcome.result
  const editedByOthers = new Set(team.edits.slice(editsBefore).filter((edit) => edit.agentId !== worker.tag.id).map((edit) => edit.path))
  const crossed: string[] = []
  for (const change of changes) {
    if (editedByOthers.has(change.path)) continue
    worker.edited.add(change.path)
    const owner = ownerConflict(team, worker.tag.id, change.path)
    if (owner) crossed.push(`${change.path} (owned by "${owner.name}")`)
  }
  if (crossed.length === 0) return outcome.result
  worker.boundary.push(...crossed)
  const note = `\nThis command also changed files owned by other workers: ${crossed.join(', ')}. The coordinator will be told.`
  const output = outcome.result.output
  return { ...outcome.result, output: output.type === 'text' || output.type === 'error-text' ? { ...output, value: output.value + note } : output }
}

// 工人没交结果就停下时，它最近写过的话：查到了什么多半在这里面
function lastNotes(worker: Worker, max: number): string {
  const text = worker.notes.join(NEWLINE).trim()
  return text.length > max ? `…${text.slice(-max)}` : text
}

function describeOutcome(worker: Worker, outcome: WorkerOutcome): { text: string; ui: string; ok: boolean } {
  const changed = [...worker.edited]
  const files = changed.length > 0 ? `Changed files: ${changed.join(', ')}.` : 'Changed no files.'
  const boundary = worker.boundary.length > 0 ? ` Its commands also changed files owned by other workers: ${worker.boundary.join(', ')}; check them.` : ''
  const uiFiles = changed.length > 0 ? `\n改动：${changed.join('、')}` : ''
  const uiBoundary = worker.boundary.length > 0 ? `\n命令改到了别的智能体认领的文件：${worker.boundary.join('、')}` : ''
  const notes = lastNotes(worker, MAX_NOTES_CHARS)
  const noted = notes ? `\nIt did not report. What it wrote before it stopped (unverified, may be incomplete):\n${notes}` : ''
  const uiNotes = lastNotes(worker, MAX_UI_NOTES_CHARS)
  const uiNoted = uiNotes ? `\n\n停下前写的：${uiNotes}` : ''
  switch (outcome.kind) {
    case 'reported':
      return {
        text: `Worker "${worker.tag.name}" reported after ${worker.steps} tool calls.\nSummary: ${outcome.summary}${outcome.issues ? `\nOpen issues: ${outcome.issues}` : ''}\n${files}${boundary}`,
        ui: `${outcome.summary}${outcome.issues ? `\n\n待处理：${outcome.issues}` : ''}${uiFiles}${uiBoundary}`,
        ok: true,
      }
    case 'max-steps':
      return {
        text: `Worker "${worker.tag.name}" hit the step limit (${WORKER_MAX_STEPS}) without reporting. ${files}${boundary} Check its changes yourself.${noted}`,
        ui: `到了步数上限（${WORKER_MAX_STEPS} 步），没有交回结果。${uiFiles}${uiBoundary}${uiNoted}`,
        ok: false,
      }
    case 'stuck':
      return {
        text: `Worker "${worker.tag.name}" was stopped: it kept making the same call with the same result after a reminder (${outcome.call}). ${files}${boundary} Check its changes yourself.${noted}`,
        ui: `提醒过后仍在重复同样的操作，已停下。${uiFiles}${uiBoundary}${uiNoted}`,
        ok: false,
      }
    case 'cancelled':
      return { text: `Worker "${worker.tag.name}" was stopped by the user. ${files}`, ui: `已停止。${uiFiles}`, ok: false }
    case 'failed':
      return { text: `Worker "${worker.tag.name}" failed: ${outcome.message}. ${files}${boundary}${noted}`, ui: `出错：${outcome.message}${uiFiles}${uiBoundary}${uiNoted}`, ok: false }
  }
}

// 在设计页里给工人认领节点；返回没认领到的原因
async function claimDesignNodes(io: TurnIO, tag: AgentTag, nodes: string[], signal: AbortSignal): Promise<string[]> {
  try {
    const result = JSON.parse((await io.design!(DESIGN_AGENT_CLAIM, { nodes }, signal, tag)).text) as { refused?: unknown }
    return Array.isArray(result.refused) ? result.refused.map(String) : []
  } catch (error) {
    return [`the design canvas is not available (${error instanceof Error ? error.message : String(error)})`]
  }
}

// 工人结束：设计页释放它的节点锁、收起它的光标；不传 agent 是主智能体这一轮结束。任务停了也要做，所以不用这一轮的 signal
export async function endDesignAgent(io: TurnIO, agent?: AgentTag): Promise<void> {
  if (!io.design) return
  await io.design(DESIGN_AGENT_DONE, {}, AbortSignal.timeout(5000), agent).catch((error: unknown) => console.error('[agents] 设计页收尾失败', error))
}

// 同一步里连续的 delegate 一起跑：最多 4 个同时，其余排队；结果按调用顺序返回。edited 表示有工人改了文件
export async function runDelegates(
  session: Session,
  team: Team,
  calls: StepToolCall[],
  active: ActiveModel,
  signal: AbortSignal,
  io: TurnIO,
): Promise<Array<{ result: ToolResultPart; edited: boolean }>> {
  const outcomes: Array<{ result: ToolResultPart; edited: boolean } | null> = calls.map(() => null)
  const jobs: Array<{ index: number; worker: Worker }> = []
  for (const [index, call] of calls.entries()) {
    const input = delegateInput.safeParse(call.input)
    const fail = async (message: string) => {
      await io.update({ sessionUpdate: 'tool_call', toolCallId: call.toolCallId, title: '子智能体', kind: 'other', status: 'failed', rawInput: call.input, content: [{ type: 'content', content: { type: 'text', text: message } }] })
      outcomes[index] = { result: errorResult(call, message), edited: false }
    }
    if (!input.success) {
      await fail(`Invalid arguments: ${input.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
      continue
    }
    if (team.count >= MAX_WORKERS_PER_TURN) {
      await fail(`At most ${MAX_WORKERS_PER_TURN} workers per turn; do the rest yourself.`)
      continue
    }
    const type = input.data.agent ? (session.agentTypes.find((item) => item.name === input.data.agent) ?? null) : null
    if (input.data.agent && !type) {
      await fail(`Unknown worker type "${input.data.agent}". ${session.agentTypes.length > 0 ? `Available: ${session.agentTypes.map((item) => item.name).join(', ')}.` : 'This project defines no worker types; omit agent.'}`)
      continue
    }
    const tag: AgentTag = { id: randomUUID(), name: input.data.name, color: AGENT_COLORS[team.count % AGENT_COLORS.length]! }
    team.count++
    // 只读的工人不认领文件和节点：它不改东西，认领了反而挡住别的工人
    const nodes = session.design && !type?.readOnly ? [...new Set(input.data.nodes ?? [])] : []
    const worker: Worker = { tag, task: input.data.task, nodes, cardId: call.toolCallId, edited: new Set(), boundary: [], steps: 0, type, notes: [], startedAt: null, endedAt: null, tokens: 0 }
    // 先把要认领的都认领下来；和正在跑的工人冲突就不派这个工人
    const refused: string[] = []
    for (const raw of type?.readOnly ? [] : (input.data.files ?? [])) {
      const path = projectPath(session, raw)
      if (!path) {
        refused.push(`${raw} is outside the project`)
        continue
      }
      const conflict = claim(team, tag, path)
      if (conflict) refused.push(`${path} is already owned by worker "${conflict.name}"`)
    }
    // 设计节点在设计页里加锁：节点不存在、和别的工人的节点重叠（祖先或后代）都不派
    if (refused.length === 0 && nodes.length > 0 && io.design) {
      refused.push(...(await claimDesignNodes(io, tag, nodes, signal)))
      if (refused.length > 0) await endDesignAgent(io, tag)
    }
    if (refused.length > 0) {
      release(team, tag.id)
      await fail(`Worker "${tag.name}" was not started: ${refused.join('; ')}. Give each worker a different set of ${nodes.length > 0 ? 'files and nodes' : 'files'}.`)
      continue
    }
    await io.update({
      sessionUpdate: 'tool_call',
      toolCallId: call.toolCallId,
      title: `子智能体 ${tag.name}`,
      kind: 'other',
      status: 'in_progress',
      rawInput: call.input,
      _meta: { diffra: { [AGENT_META_KEY]: cardMeta(team, worker) } },
    })
    jobs.push({ index, worker })
  }

  let next = 0
  const runNext = async (): Promise<void> => {
    while (next < jobs.length) {
      const job = jobs[next++]!
      const { worker } = job
      let outcome: WorkerOutcome
      worker.startedAt = Date.now()
      await io.update({ sessionUpdate: 'tool_call_update', toolCallId: worker.cardId, _meta: { diffra: { [AGENT_META_KEY]: cardMeta(team, worker) } } })
      try {
        outcome = await runWorker(session, team, worker, active, signal, io)
      } catch (error) {
        outcome = signal.aborted ? { kind: 'cancelled' } : { kind: 'failed', message: toModelError(error, active.config.endpoint.apiKey, 0).message }
        if (!signal.aborted) console.error(`[agents] 子智能体 ${worker.tag.name} 出错`, error)
      }
      const described = describeOutcome(worker, outcome)
      worker.endedAt = Date.now()
      await io.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: worker.cardId,
        status: described.ok ? 'completed' : 'failed',
        content: [{ type: 'content', content: { type: 'text', text: described.ui } }],
        _meta: { diffra: { [AGENT_META_KEY]: cardMeta(team, worker) } },
      })
      release(team, worker.tag.id)
      if (session.design) await endDesignAgent(io, worker.tag)
      const call = calls[job.index]!
      outcomes[job.index] = { result: described.ok ? textResult(call, described.text) : errorResult(call, described.text), edited: worker.edited.size > 0 }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_WORKERS, jobs.length) }, () => runNext()))
  return outcomes.map((outcome, index) => outcome ?? { result: errorResult(calls[index]!, 'Not run.'), edited: false })
}
