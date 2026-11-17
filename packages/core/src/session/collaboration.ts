import { randomUUID, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { type ModelMessage, tool, type ToolResultPart } from 'ai'
import { z } from 'zod'
import { AGENT_META_KEY } from '../protocol.js'
import { COLLABORATION_META_KEY, COLLABORATION_PARALLELISM, COLLABORATION_ROLES, type CollaborationAction, type CollaborationView, type CollaborationWorker } from '../collaboration-types.js'
import { createLanguageModel } from '../models/operations.js'
import { createTeamTask, taskViews, updateTeamTask } from './collaboration-board.js'
import { describeOutcome, newTeam, runWorker, type Worker } from './agents.js'
import { errorResult, textResult, type ActiveModel, type StepToolCall, type TurnIO } from './loop.js'
import { Session } from './session.js'
import { freshWorldState } from './world-state.js'
import { disposeWorkerWorktree, integrateWorkerWorktree, inspectWorkerChanges, prepareWorkerWorktree, refreshWorkerWorktree, restoreWorkerWorktree } from './collaboration-worktrees.js'
import { captureBaseline } from './worktrees.js'
import { isReadOnlyCommand } from '../permissions.js'
import { screenshotMessage } from './browser.js'

const LEAD = 'lead'
const MAX_MESSAGE_LENGTH = 20_000
const MAX_PENDING_MESSAGES = 256
const WAIT_TIMEOUT_MS = 120_000
const MAX_WAIT_TIMEOUT_MS = 3_600_000
const workerId = z.string().trim().min(1).max(128)
const messageInput = z.object({ agent: workerId, message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH) })
const createInput = z.object({ subject: z.string().trim().min(1).max(200), description: z.string().max(20_000).default(''), blockedBy: z.array(workerId).max(256).optional(), writeScopes: z.array(z.string().min(1).max(1024)).max(50).optional() })
const updateInput = z.object({ taskId: workerId, expectedRevision: z.number().int().positive(), action: z.enum(['claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete']), owner: workerId.optional(), subject: z.string().min(1).max(200).optional(), description: z.string().max(20_000).optional(), blockedBy: z.array(workerId).max(256).optional(), writeScopes: z.array(z.string().min(1).max(1024)).max(50).optional() })
const delegateInput = z.object({ name: z.string().trim().min(1).max(16), task: z.string().trim().min(1), files: z.array(z.string().min(1)).max(50).optional(), nodes: z.array(z.string().min(1)).max(50).optional(), agent: z.string().max(32).optional(), background: z.boolean().optional(), role: z.enum(COLLABORATION_ROLES).optional(), context: z.enum(['fresh', 'fork']).optional() })

export const COLLABORATION_TOOLS = {
  send_message: tool({ description: 'Send a durable message to a worker or lead. Running workers read it at their next step; inactive workers continue with their own saved context. This does not return their answer.', inputSchema: messageInput }),
  list_agents: tool({ description: 'List collaboration workers, stable ids, roles, execution states and unmerged isolated changes. Activity is separate from task completion and acceptance.', inputSchema: z.object({}) }),
  wait_agents: tool({ description: 'Wait without model polling until the specified workers settle or new input arrives. Omit agents to wait for the next worker result. Then read results and integrate changes.', inputSchema: z.object({ agents: z.array(workerId).max(256).optional(), timeout_ms: z.number().int().min(1).max(MAX_WAIT_TIMEOUT_MS).optional() }) }),
  interrupt_agent: tool({ description: 'Interrupt just this worker activation, keeping its context, messages and isolated changes for explicit continuation.', inputSchema: z.object({ agent: workerId }) }),
  integrate_agent: tool({ description: 'Integrate a completed worker worktree into the project after conflict, file-scope and protected-path checks. Conflicts preserve the worktree and never overwrite project changes.', inputSchema: z.object({ agent: workerId }) }),
  team_task_create: tool({ description: 'Create a shared execution task with dependencies and advisory write scopes. This is not the user personal todo list and does not start a worker.', inputSchema: createInput }),
  team_task_list: tool({ description: 'Read the shared task DAG, ownership, revisions, readiness and write-scope overlap warnings.', inputSchema: z.object({}) }),
  team_task_get: tool({ description: 'Read one shared execution task and its revision before updating or claiming it.', inputSchema: z.object({ taskId: workerId }) }),
  team_task_update: tool({ description: 'Compare-and-set a shared task using its expectedRevision. Claim ready work, release, complete, reopen or edit your task. Only lead may reassign.', inputSchema: updateInput }),
}

export function collaborationView(session: Session): CollaborationView {
  const state = session.collaboration
  return {
    parallelism: COLLABORATION_PARALLELISM,
    workers: state.workers.map(({ messages: _messages, compaction: _compaction, worktree, ...worker }) => ({ ...worker, isolated: worktree !== null, hasUnmergedChanges: worktree !== null && (worktree.currentTree ? worktree.currentTree !== (worktree.integratedTree ?? worktree.baseTree) : worktree.integratedTree === null && worker.edited.length > 0) })),
    tasks: taskViews(state), messages: state.messages, acceptance: state.acceptance,
  }
}

function repairInterruptedTools(messages: ModelMessage[]): void {
  const answered = new Set<string>()
  for (const message of messages) if (message.role === 'tool') for (const part of message.content) if (part.type === 'tool-result') answered.add(part.toolCallId)
  const repaired: ModelMessage[] = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (!message) continue
    repaired.push(message)
    if (message.role !== 'assistant' || typeof message.content === 'string') continue
    const pending = message.content.flatMap((part) => part.type === 'tool-call' && !answered.has(part.toolCallId) ? [part] : [])
    if (pending.length > 0) repaired.push({ role: 'tool', content: pending.map((part) => ({ type: 'tool-result', toolCallId: part.toolCallId, toolName: part.toolName, output: { type: 'error-text', value: 'This call was interrupted before its result was recorded. Side effects may already exist. Inspect the actual state before retrying.' } })) })
  }
  messages.splice(0, messages.length, ...repaired)
}

interface RunningWorker {
  controller: AbortController
  promise: Promise<void>
  child: Session | null
}

const runtimes = new WeakMap<Session, CollaborationRuntime>()
export function collaborationRuntime(session: Session): CollaborationRuntime {
  let runtime = runtimes.get(session)
  if (!runtime) {
    runtime = new CollaborationRuntime(session)
    runtimes.set(session, runtime)
  }
  return runtime
}

export class CollaborationRuntime {
  private readonly running = new Map<string, RunningWorker>()
  private readonly wakeups = new Set<() => void>()
  private io: TurnIO | null = null
  private active: ActiveModel | null = null
  private signal: AbortSignal | null = null
  private persistTail: Promise<void> = Promise.resolve()
  private pumpTail: Promise<void> = Promise.resolve()
  private turnId = ''
  private restored = false
  private closing = false
  private readonly waiting = new Map<string, string[]>()
  private readonly permissions = { chain: Promise.resolve<unknown>(null) }

  constructor(private readonly parent: Session) {}

  async bind(active: ActiveModel, signal: AbortSignal, io: TurnIO): Promise<void> {
    this.closing = false
    this.active = active
    this.signal = signal
    this.io = io
    this.turnId = this.parent.turns.at(-1)?.id ?? randomUUID()
    if (!this.restored) {
      for (const worker of this.parent.collaboration.workers) if (worker.worktree) {
        try {
          await restoreWorkerWorktree(worker.worktree, this.parent.cwd, this.parent.worktreesRoot ?? join(tmpdir(), 'diffra-worker-worktrees', this.parent.id))
        } catch (error) {
          worker.status = 'interrupted'
          worker.issues = `独立工作区未通过恢复校验，现场已保留：${error instanceof Error ? error.message : String(error)}`
        }
      }
      this.restored = true
    }
    await this.publish()
    await this.pump()
  }

  private requireIO(): TurnIO {
    if (!this.io) throw new Error('协作尚未绑定到正在执行的任务')
    return this.io
  }

  private wake(): void {
    for (const done of this.wakeups) done()
    this.wakeups.clear()
  }

  async publish(): Promise<void> {
    const io = this.requireIO()
    const save = this.persistTail.then(async () => {
      await io.persist?.()
      await io.update({ sessionUpdate: 'session_info_update', _meta: { diffra: { [COLLABORATION_META_KEY]: structuredClone(collaborationView(this.parent)) } } })
    })
    this.persistTail = save.catch((error: unknown) => { console.error(`[collaboration] 会话 ${this.parent.id} 保存失败`, error) })
    await save
    this.wake()
  }

  private resolveWorker(id: string): CollaborationWorker {
    const worker = this.parent.collaboration.workers.find((item) => item.id === id || item.name === id)
    if (!worker) throw new Error(`没有队友 ${id}，先调用 list_agents`)
    return worker
  }

  async delegate(call: StepToolCall): Promise<ToolResultPart> {
    try {
      const input = delegateInput.parse(call.input)
      if (this.parent.collaboration.workers.some((worker) => worker.name === input.name)) throw new Error(`队友名称已存在：${input.name}，请发送消息续聊或使用不同名称。`)
      const custom = input.agent ? this.parent.agentTypes.find((type) => type.name === input.agent) : null
      if (input.agent && !custom) throw new Error(`未知工人类型 ${input.agent}`)
      const role = input.role ?? (custom?.readOnly ? 'explorer' : 'implementer')
      const worker: CollaborationWorker = {
        id: randomUUID(), name: input.name, color: ['#2563EB', '#D97706', '#16A34A', '#DB2777', '#7C3AED', '#0891B2', '#DC2626', '#65A30D'][this.parent.collaboration.workers.length % COLLABORATION_PARALLELISM] ?? '#2563EB',
        task: input.task, role, typeName: custom?.name ?? null, readOnly: Boolean(custom?.readOnly) || role === 'explorer' || role === 'reviewer', context: input.context ?? 'fresh',
        files: input.files ?? [], nodes: input.nodes ?? [], cardId: call.toolCallId, turnId: this.turnId, status: 'queued', activation: 0, messages: [], summary: null, issues: null, verdict: null, checks: [], startedAt: null, endedAt: null, tokens: 0, edited: [], worktree: null, resultRevision: 0, notifiedRevision: 0,
      }
      if (!worker.readOnly && !this.parent.design && worker.files.length === 0) throw new Error('可写工人必须明确 files 写入范围；需要整个项目时传 ["."]。')
      this.parent.collaboration.workers.push(worker)
      if (role === 'implementer') this.parent.collaboration.acceptance.status = 'pending'
      await this.card(worker, true)
      await this.publish()
      await this.pump()
      if (input.background === false) {
        await this.wait([worker.id], MAX_WAIT_TIMEOUT_MS)
        return textResult(call, JSON.stringify(this.result(worker)))
      }
      return textResult(call, `Started worker ${worker.name} (${worker.id}) in the background. Continue independent work; collect results with wait_agents and integrate_agent. Writable work is isolated until integrated.`)
    } catch (error) {
      return errorResult(call, error instanceof Error ? error.message : String(error))
    }
  }

  private result(worker: CollaborationWorker) {
    return { id: worker.id, name: worker.name, status: worker.status, summary: worker.summary, issues: worker.issues, verdict: worker.verdict, edited: worker.edited, checks: worker.checks, isolated: worker.worktree !== null }
  }

  private async card(worker: CollaborationWorker, first = false): Promise<void> {
    await this.requireIO().update({
      sessionUpdate: first ? 'tool_call' : 'tool_call_update', toolCallId: worker.cardId, title: `子智能体 ${worker.name}`, kind: 'other',
      status: worker.status === 'running' || worker.status === 'queued' ? 'in_progress' : worker.status === 'completed' ? 'completed' : 'failed',
      ...(worker.summary ? { content: [{ type: 'content', content: { type: 'text', text: `${worker.summary}${worker.issues ? `\n待处理：${worker.issues}` : ''}` } }] } : {}),
      _meta: { diffra: { [AGENT_META_KEY]: { id: worker.id, workerId: worker.id, name: worker.name, color: worker.color, task: worker.task, files: worker.files, nodes: worker.nodes, role: worker.role, isolated: worker.worktree !== null, workspace: worker.worktree?.cwd ?? this.parent.cwd, activation: worker.activation, tokens: worker.tokens, edited: worker.edited, ...(worker.startedAt === null ? {} : { startedAt: worker.startedAt }), ...(worker.endedAt === null ? {} : { endedAt: worker.endedAt }) } } },
    })
  }

  private pump(): Promise<void> {
    const run = this.pumpTail.then(async () => {
      if (!this.signal || this.signal.aborted || this.closing) return
      while (this.running.size < COLLABORATION_PARALLELISM) {
        const worker = this.parent.collaboration.workers.find((item) => item.status === 'queued' && !this.running.has(item.id))
        if (!worker) break
        const controller = new AbortController()
        const entry: RunningWorker = { controller, child: null, promise: Promise.resolve() }
        this.running.set(worker.id, entry)
        worker.status = 'running'
        entry.promise = this.execute(worker, entry, AbortSignal.any([controller.signal, this.signal])).catch(async (error: unknown) => {
          worker.status = controller.signal.aborted || this.signal?.aborted ? 'interrupted' : 'failed'
          worker.issues = error instanceof Error ? error.message : String(error)
          worker.summary ??= '工人没有正常交回结果；上下文和独立改动已保留。'
          worker.endedAt = Date.now()
          worker.resultRevision++
          await this.card(worker)
          await this.publish()
        }).finally(() => {
          this.running.delete(worker.id)
          this.wake()
          if (!this.closing && worker.status === 'completed' && this.parent.collaboration.messages.some((message) => message.recipient === worker.id && message.status === 'pending')) worker.status = 'queued'
          void this.pump().catch((error: unknown) => console.error(`[collaboration] 会话 ${this.parent.id} 调度失败`, error))
        })
      }
    })
    this.pumpTail = run.catch((error: unknown) => { console.error(`[collaboration] 会话 ${this.parent.id} 调度失败`, error) })
    return run
  }

  private async execute(saved: CollaborationWorker, entry: RunningWorker, signal: AbortSignal): Promise<void> {
    const parent = this.parent
    const io = this.requireIO()
    const active = this.active
    if (!active) throw new Error('没有可用的协作模型')
    saved.activation++
    if (saved.activation > 1) {
      saved.cardId = `worker-${saved.id}-${saved.activation}`
      saved.turnId = this.turnId
      await this.card(saved, true)
    }
    saved.startedAt = Date.now()
    saved.endedAt = null
    saved.verdict = null
    saved.checks = []
    await this.publish()
    signal.throwIfAborted()
    if ((!saved.readOnly || saved.role === 'tester') && !parent.design) {
      const root = parent.worktreesRoot ?? join(tmpdir(), 'diffra-worker-worktrees', parent.id)
      if (!saved.worktree) saved.worktree = await prepareWorkerWorktree(parent.cwd, root, saved.id)
      else if ((await inspectWorkerChanges(saved.worktree)).paths.length === 0) await refreshWorkerWorktree(saved.worktree, parent.cwd, signal)
    }
    const cwd = saved.worktree?.cwd ?? parent.cwd
    const configured = parent.config.collaborationModels?.[saved.role]
    const selected: ActiveModel = configured ? { config: configured, language: createLanguageModel(configured.endpoint, configured.modelId, configured.reasoningEffort, configured.maxOutputTokens) } : active
    const linkedPaths = saved.worktree?.links.map((path) => relative(cwd, join(saved.worktree!.dir, path)).split(sep).join('/')).filter((path) => path !== '..' && !path.startsWith('../')) ?? []
    const child = new Session({ cwd, config: { ...parent.config, model: selected.config, readOnlyPaths: [...parent.config.readOnlyPaths, ...linkedPaths], checkpointDir: null, memoryDir: null, collaboration: { enabled: false, isolation: 'worktree', acceptance: 'required', maxParallel: 8 } }, environment: parent.environment, checkpoints: null, rulePacks: parent.rulePacks, systemPrompt: parent.workerPrompt, workerPrompt: parent.workerPrompt, model: selected.language, readRoots: parent.readRoots, agentTypes: parent.agentTypes, worktreesRoot: parent.worktreesRoot ?? undefined })
    entry.child = child
    child.userLanguage = parent.userLanguage
    child.compaction = saved.compaction ?? null
    child.permissionMode = parent.permissionMode
    child.design = parent.design
    child.activeTurn = new AbortController()
    const abortChild = () => child.activeTurn?.abort()
    signal.addEventListener('abort', abortChild, { once: true })
    if (signal.aborted) abortChild()
    const custom = saved.typeName ? parent.agentTypes.find((item) => item.name === saved.typeName) : null
    const worker: Worker = { tag: { id: saved.id, name: saved.name, color: saved.color }, task: saved.task, nodes: saved.nodes, cardId: saved.cardId, edited: new Set(saved.edited), boundary: [], steps: 0, type: saved.readOnly ? { name: custom?.name ?? saved.role, description: custom?.description ?? saved.role, readOnly: true, instructions: custom?.instructions ?? '' } : custom ?? null, notes: [], startedAt: saved.startedAt, endedAt: null, tokens: saved.tokens }
    const team = newTeam()
    for (const path of saved.files) team.claims.set(path, worker.tag)
    if (saved.messages.length === 0) {
      if (saved.context === 'fork') {
        const start = parent.messageStarts.get(parent.turns.at(-1)?.id ?? '') ?? 0
        saved.messages.push(...structuredClone(parent.messages.slice(0, start)))
      }
      const current = parent.turns.at(-1)?.prompt ?? ''
      const requirements = parent.turns.filter((turn) => turn.kind === 'prompt' || turn.kind === 'goal').map((turn) => turn.prompt).join('\n\n--- Next user request ---\n\n')
      saved.messages.push(await freshWorldState(child), { role: 'user', content: `${saved.task}\n\nCurrent user request and constraints (do not ignore):\n${current}\n\nUser requests and constraints in order (later requests supersede conflicts):\n${requirements}\n\nYou are ${saved.name}, id ${saved.id}. Coordinator id: lead. Your workspace: ${cwd}. ${saved.worktree ? 'This is an isolated Git worktree, not an OS sandbox. Do not write original project paths, linked dependencies, Git metadata, or files outside the assigned scope. Do not commit, push, or publish.' : 'You have no isolated code workspace; follow your read-only or design-node restrictions.'}` })
      const images = parent.turns.flatMap((turn) => turn.images ?? [])
      if (images.length > 0) {
        if (!selected.config.supportsImages) throw new Error('当前协作模型不支持用户提供的参考图片；请选择支持视觉的角色模型，不会丢弃图片后继续。')
        saved.messages.push(screenshotMessage(images))
      }
    } else {
      repairInterruptedTools(saved.messages)
      saved.messages.push(await freshWorldState(child))
    }
    await this.card(saved)
    await this.publish()
    const trackedIO: TurnIO = {
      ...io,
      update: async (update) => {
        if (update.sessionUpdate === 'tool_call_update') {
          const meta = update._meta?.diffra
          const succeeded = typeof meta === 'object' && meta !== null && 'commandSucceeded' in meta ? meta.commandSucceeded : undefined
          if (typeof succeeded === 'boolean' && typeof meta === 'object' && meta !== null && 'executedCommand' in meta && typeof meta.executedCommand === 'string') saved.checks.push({ command: meta.executedCommand, succeeded, ...('commandWorkdir' in meta && typeof meta.commandWorkdir === 'string' ? { workdir: meta.commandWorkdir } : {}) })
        }
        await io.update(update)
      },
      requestPermission: (toolCall, options) => {
        const asked = this.permissions.chain.then(() => {
          signal.throwIfAborted()
          return io.requestPermission(toolCall, options, signal)
        })
        this.permissions.chain = asked.catch(() => null)
        return asked
      },
      persist: () => this.publish(),
    }
    try {
      const outcome = await runWorker(child, team, worker, selected, signal, trackedIO, {
        role: saved.role, tools: this.workerTools(), messages: saved.messages,
        receive: () => this.receive(saved.id, saved.messages),
        save: async () => { saved.tokens = worker.tokens; saved.edited = [...worker.edited]; saved.compaction = child.compaction; await this.publish() },
        execute: (call, workerIO) => this.tool(call, saved.id, workerIO, signal),
        beforeWrite: (target) => {
          if (saved.role === 'tester') throw new Error('测试工人不能修改实现文件；需要修复时向主智能体报告。')
          const path = relative(cwd, target.absolute).split(sep).join('/')
          const fold = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
          if (isAbsolute(path) || path === '..' || path.startsWith('../') || !saved.files.some((scope) => scope === '.' || fold(path) === fold(scope.replace(/\\/g, '/').replace(/\/$/, '')) || fold(path).startsWith(`${fold(scope.replace(/\\/g, '/').replace(/\/$/, ''))}/`))) throw new Error(`${target.display} is outside this worker's assigned files. Ask the coordinator to change the scope; do not modify it.`)
        },
      })
      const described = describeOutcome(worker, outcome)
      saved.status = signal.aborted ? 'interrupted' : described.ok ? 'completed' : 'failed'
      saved.summary = outcome.kind === 'reported' ? outcome.summary : described.text
      saved.issues = outcome.kind === 'reported' ? outcome.issues : described.ok ? null : described.text
      saved.verdict = outcome.kind === 'reported' ? outcome.verdict ?? null : null
      saved.tokens = worker.tokens
      saved.edited = [...worker.edited]
      await child.execSessions.killOwner(saved.id)
      if (saved.worktree) {
        const inspected = await inspectWorkerChanges(saved.worktree)
        saved.edited = inspected.paths
        saved.worktree.currentTree = inspected.tree
        if (saved.role === 'tester' && inspected.paths.length > 0) {
          saved.status = 'failed'
          saved.verdict = 'changes_required'
          saved.issues = `验证期间修改了文件，不能接受这份测试结论：${inspected.paths.join('、')}。请报告问题并让实现工人修复。`
        }
      }
    } finally {
      signal.removeEventListener('abort', abortChild)
      await child.execSessions.killOwner(saved.id)
      child.activeTurn = null
      entry.child = null
      saved.endedAt = Date.now()
      saved.resultRevision++
      await this.card(saved)
      await this.publish()
    }
  }

  private workerTools() {
    const { integrate_agent: _integrate, interrupt_agent: _interrupt, ...tools } = COLLABORATION_TOOLS
    return tools
  }

  async receive(recipient: string, messages: ModelMessage[]): Promise<void> {
    const pending = this.parent.collaboration.messages.filter((message) => message.recipient === recipient && message.status === 'pending')
    if (pending.length === 0) return
    messages.push(...pending.map((message): ModelMessage => ({ role: 'user', content: `[Diffra] Message ${message.id} from ${message.sender}:\n${message.content}` })))
    for (const message of pending) message.status = 'delivered'
    await this.publish()
  }

  async collect(): Promise<boolean> {
    let changed = false
    await this.receive(LEAD, this.parent.messages)
    for (const worker of this.parent.collaboration.workers) {
      if (worker.resultRevision <= worker.notifiedRevision || worker.status === 'running' || worker.status === 'queued') continue
      this.parent.messages.push({ role: 'user', content: `[Diffra] Worker result (${worker.id}, activation ${worker.activation}):\n${JSON.stringify(this.result(worker))}\n${worker.worktree && worker.worktree.currentTree !== (worker.worktree.integratedTree ?? worker.worktree.baseTree) ? 'Changes remain isolated until integrate_agent succeeds. Review integration conflicts instead of overwriting.' : ''}` })
      worker.notifiedRevision = worker.resultRevision
      changed = true
    }
    if (changed) await this.publish()
    return changed
  }

  private async send(sender: string, target: string, content: string): Promise<string> {
    const recipient = target === LEAD ? LEAD : this.resolveWorker(target).id
    if (recipient === sender) throw new Error('不能给自己发协作消息')
    const state = this.parent.collaboration
    if (state.messages.filter((item) => item.status === 'pending').length >= MAX_PENDING_MESSAGES) throw new Error('协作消息队列已满，请先处理已有消息')
    const message = { id: randomUUID(), sender, recipient, content, createdAt: new Date().toISOString(), status: 'pending' as const }
    state.messages.push(message)
    try { await this.publish() } catch (error) { state.messages.splice(state.messages.indexOf(message), 1); throw error }
    if (recipient !== LEAD) {
      const worker = this.resolveWorker(recipient)
      if (!this.running.has(worker.id)) {
        worker.status = 'queued'
        await this.publish()
        await this.pump()
      }
    }
    this.wake()
    return message.id
  }

  private async waitInbox(recipient: string, timeout: number, signal: AbortSignal | null): Promise<void> {
    const deadline = Date.now() + timeout
    while (!signal?.aborted && !this.parent.collaboration.messages.some((message) => message.recipient === recipient && message.status === 'pending') && Date.now() < deadline) {
      await new Promise<void>((done) => {
        const finish = () => { clearTimeout(timer); this.wakeups.delete(finish); signal?.removeEventListener('abort', finish); done() }
        const timer = setTimeout(finish, deadline - Date.now())
        this.wakeups.add(finish)
        signal?.addEventListener('abort', finish, { once: true })
      })
    }
  }

  async wait(ids?: string[], timeout = WAIT_TIMEOUT_MS, signal = this.signal): Promise<void> {
    const targets = ids?.map((id) => this.resolveWorker(id).id)
    const deadline = Date.now() + timeout
    for (;;) {
      if (signal?.aborted) return
      if (!targets && this.parent.collaboration.messages.some((message) => message.recipient === LEAD && message.status === 'pending')) return
      if (targets ? targets.every((id) => !this.running.has(id) && this.resolveWorker(id).status !== 'queued') : this.running.size === 0 && !this.parent.collaboration.workers.some((worker) => worker.status === 'queued')) return
      if (Date.now() >= deadline) return
      await new Promise<void>((done) => {
        const finish = () => { clearTimeout(timer); this.wakeups.delete(finish); signal?.removeEventListener('abort', finish); done() }
        const timer = setTimeout(finish, Math.min(deadline - Date.now(), WAIT_TIMEOUT_MS))
        this.wakeups.add(finish)
        signal?.addEventListener('abort', finish, { once: true })
      })
      if (!targets && this.parent.collaboration.workers.some((worker) => worker.resultRevision > worker.notifiedRevision)) return
    }
  }

  async integrate(id: string): Promise<void> {
    const worker = this.resolveWorker(id)
    if (this.running.has(worker.id) || worker.status === 'queued') throw new Error('工人还没停止，不能整合')
    if (!worker.worktree) throw new Error('这个工人没有待整合的 worktree')
    if (worker.readOnly || worker.role === 'tester') throw new Error('探索、审查和测试工人的文件不能作为实现改动整合')
    const result = await integrateWorkerWorktree(worker.worktree, this.parent.cwd, worker.files, this.signal ?? undefined, this.parent.config.readOnlyPaths)
    if (result.paths.length > 0) this.parent.collaboration.requiresAcceptance = true
    worker.worktree.currentTree = result.tree
    for (const [index, change] of result.changes.entries()) {
      if (change.oldText === undefined || change.newText === undefined) continue
      await this.requireIO().update({ sessionUpdate: 'tool_call', toolCallId: `integrate-${worker.id}-${worker.activation}-${index}`, title: `整合 ${worker.name}：${change.path}`, kind: 'edit', status: 'completed', content: [{ type: 'diff', path: resolve(worker.worktree.repoRoot, change.path), oldText: change.oldText, newText: change.newText ?? '' }], _meta: { diffra: { [AGENT_META_KEY]: { id: worker.id, name: worker.name, color: worker.color } } } })
    }
    this.parent.collaboration.acceptance = { status: 'pending', fingerprint: null, reviewerId: null, testerId: null, reason: '整合后需要独立审查与测试。' }
    this.parent.collaboration.messages.push({ id: randomUUID(), sender: worker.id, recipient: LEAD, content: `Integrated ${worker.name}: ${result.paths.join(', ')}. Previous observations and acceptance are stale; reread changed files before editing.`, createdAt: new Date().toISOString(), status: 'pending' })
    await this.publish()
  }

  async control(action: CollaborationAction): Promise<void> {
    const worker = this.resolveWorker(action.workerId)
    if (action.action === 'interrupt') {
      this.running.get(worker.id)?.controller.abort()
      if (worker.status === 'queued') worker.status = 'interrupted'
      await this.publish()
      return
    }
    if (action.action === 'integrate') return this.integrate(worker.id)
    if (action.action === 'retry' || action.action === 'message') {
      const message = action.message?.trim() ?? (action.action === 'retry' ? 'Continue your interrupted work. Recheck the actual files and prior results before proceeding; do not repeat completed side effects.' : '')
      if (!message || message.length > MAX_MESSAGE_LENGTH) throw new Error('消息长度需要在 1–20000 字符之间')
      await this.send(LEAD, worker.id, message)
    }
  }

  async tool(call: StepToolCall, caller = LEAD, io = this.requireIO(), signal = this.signal): Promise<ToolResultPart> {
    const name = call.toolName
    await io.update({ sessionUpdate: 'tool_call', toolCallId: call.toolCallId, title: name, kind: 'other', status: 'in_progress', rawInput: call.input })
    try {
      let value: unknown
      if (name === 'send_message') {
        const input = messageInput.parse(call.input)
        value = { messageId: await this.send(caller, input.agent, input.message), status: 'accepted_and_saved' }
      } else if (name === 'list_agents') value = this.parent.collaboration.workers.map((worker) => this.result(worker))
      else if (name === 'wait_agents') {
        const input = z.object({ agents: z.array(workerId).max(256).optional(), timeout_ms: z.number().int().min(1).max(MAX_WAIT_TIMEOUT_MS).optional() }).parse(call.input)
        if (input.agents?.some((id) => this.resolveWorker(id).id === caller)) throw new Error('不能等待自己')
        const targets = input.agents?.map((id) => this.resolveWorker(id).id) ?? []
        const reaches = (start: string, seen = new Set<string>()): boolean => {
          if (start === caller) return true
          if (seen.has(start)) return false
          seen.add(start)
          return (this.waiting.get(start) ?? []).some((next) => reaches(next, seen))
        }
        if (targets.some((id) => reaches(id))) throw new Error('队友之间形成循环等待，请发送消息协调，而不是互相等待。')
        this.waiting.set(caller, targets)
        try {
          if (caller !== LEAD && !input.agents) await this.waitInbox(caller, input.timeout_ms ?? WAIT_TIMEOUT_MS, signal)
          else await this.wait(input.agents, input.timeout_ms, signal)
        } finally {
          this.waiting.delete(caller)
        }
        value = this.parent.collaboration.workers.filter((worker) => !input.agents || input.agents.some((id) => id === worker.id || id === worker.name)).map((worker) => this.result(worker))
      } else if (name === 'integrate_agent' || name === 'interrupt_agent') {
        if (caller !== LEAD) throw new Error('只有主智能体可以停止工人或整合改动')
        const input = z.object({ agent: workerId }).parse(call.input)
        await this.control({ action: name === 'integrate_agent' ? 'integrate' : 'interrupt', workerId: input.agent })
        value = { ok: true }
      } else if (name === 'team_task_create') value = createTeamTask(this.parent.collaboration, caller, createInput.parse(call.input))
      else if (name === 'team_task_update') {
        const input = updateInput.parse(call.input)
        if (input.owner && input.owner !== LEAD) input.owner = this.resolveWorker(input.owner).id
        value = updateTeamTask(this.parent.collaboration, caller, input)
      } else if (name === 'team_task_list') value = taskViews(this.parent.collaboration)
      else if (name === 'team_task_get') {
        const input = z.object({ taskId: workerId }).parse(call.input)
        value = this.parent.collaboration.tasks.find((item) => item.id === input.taskId)
        if (!value) throw new Error('任务不存在')
      } else throw new Error(`未知协作工具 ${name}`)
      await this.publish()
      const text = JSON.stringify(value)
      await io.update({ sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text } }] })
      return textResult(call, text)
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      await io.update({ sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, status: 'failed', content: [{ type: 'content', content: { type: 'text', text } }] })
      return errorResult(call, text)
    }
  }

  hasWork(): boolean {
    return this.running.size > 0 || this.parent.collaboration.workers.some((worker) => worker.status === 'queued')
  }

  async close(): Promise<void> {
    if (!this.io) return
    this.closing = true
    for (const entry of this.running.values()) entry.controller.abort()
    for (const worker of this.parent.collaboration.workers) if (worker.status === 'queued') worker.status = 'interrupted'
    await Promise.allSettled([...this.running.values()].map((entry) => entry.promise))
    await this.publish()
  }

  async dispose(): Promise<void> {
    if (this.io) await this.close()
    for (const worker of this.parent.collaboration.workers) if (worker.worktree) {
      await restoreWorkerWorktree(worker.worktree, this.parent.cwd, this.parent.worktreesRoot ?? join(tmpdir(), 'diffra-worker-worktrees', this.parent.id))
      await disposeWorkerWorktree(worker.worktree)
      worker.worktree = null
    }
  }

  private async fingerprint(): Promise<string> {
    if (this.parent.checkpoints) return this.parent.checkpoints.fingerprint()
    const baseline = await captureBaseline(this.parent.cwd)
    const hash = createHash('sha256').update(baseline.head).update(baseline.patch)
    for (const path of baseline.untracked) hash.update(path).update(await readFile(join(baseline.repoRoot, path)))
    return hash.digest('hex')
  }

  async accept(): Promise<'passed' | 'continue' | 'blocked'> {
    const state = this.parent.collaboration
    if (state.workers.length === 0) return 'passed'
    if (this.hasWork()) { await this.wait(undefined, MAX_WAIT_TIMEOUT_MS); await this.collect(); return 'continue' }
    const unmerged = state.workers.filter((worker) => worker.role === 'implementer' && worker.worktree && (worker.worktree.currentTree ? worker.worktree.currentTree !== (worker.worktree.integratedTree ?? worker.worktree.baseTree) : worker.worktree.integratedTree === null && worker.edited.length > 0))
    if (unmerged.length > 0) {
      this.parent.messages.push({ role: 'user', content: `[Diffra] Before completion, integrate required isolated implementations: ${unmerged.map((worker) => `${worker.name} (${worker.id})`).join(', ')}. Preserve conflicts and resolve them explicitly.` })
      return 'continue'
    }
    const unfinished = state.tasks.filter((task) => task.status !== 'completed' && task.status !== 'deleted')
    if (unfinished.length > 0) {
      state.acceptance = { ...state.acceptance, status: 'blocked', reason: `共享执行任务尚未完成：${unfinished.map((task) => task.subject).join('、')}` }
      await this.publish()
      return 'blocked'
    }
    const failed = state.workers.filter((worker) => worker.role === 'implementer' && worker.status !== 'completed')
    if (failed.length > 0) {
      state.acceptance = { ...state.acceptance, status: 'blocked', reason: `实现工人尚未交付：${failed.map((worker) => `${worker.name}（${worker.status}）`).join('、')}` }
      await this.publish()
      return 'blocked'
    }
    const implementers = state.workers.filter((worker) => worker.role === 'implementer' && (worker.edited.length > 0 || (worker.worktree !== null && worker.worktree.integratedTree !== null)))
    if (implementers.length === 0 && !state.requiresAcceptance) return 'passed'
    const fingerprint = await this.fingerprint()
    if (state.acceptance.status === 'passed' && state.acceptance.fingerprint === fingerprint) return 'passed'
    if (state.acceptance.fingerprint !== fingerprint) state.acceptance = { status: 'pending', fingerprint, reviewerId: null, testerId: null, reason: null }
    const request = this.parent.turns.at(-1)?.prompt ?? ''
    for (const role of ['reviewer', 'tester'] as const) {
      const id = role === 'reviewer' ? state.acceptance.reviewerId : state.acceptance.testerId
      const existing = id ? state.workers.find((worker) => worker.id === id) : null
      if (!existing) {
        state.acceptance.status = role === 'reviewer' ? 'reviewing' : 'testing'
        const baseName = role === 'reviewer' ? '独立审查' : '集成验证'
        const count = state.workers.filter((worker) => worker.role === role).length
        const marker = count === 0 ? baseName : `${baseName}-${count + 1}`
        const task = role === 'reviewer'
          ? `Independently review the integrated project against the current request. Read the actual final files and git diff, look for correctness, security, regressions, missed requirements and compatibility. Do not edit. Return report with verdict passed only when no blocking findings remain; otherwise changes_required or blocked, with exact evidence. User request:\n${request}`
          : `Independently verify the integrated project. Execute relevant targeted tests and the configured integration check; inspect results. Do not modify implementation source. Report actual commands and results. A passed verdict requires successfully executed verification, never just a claim. If infrastructure prevents testing report blocked. Configured check: ${this.parent.config.checks.beforeFinish ?? 'Inspect project instructions and scripts to find the correct relevant tests.'}\nUser request:\n${request}`
        const call = { toolCallId: `accept-${randomUUID()}`, toolName: 'delegate', invalid: null, input: { name: marker, task, role, files: ['.'], background: true, context: 'fresh' } }
        const before = state.workers.length
        await this.delegate(call)
        const created = state.workers[before]
        if (!created) throw new Error('验收工人没有启动')
        if (role === 'reviewer') state.acceptance.reviewerId = created.id
        else state.acceptance.testerId = created.id
        await this.publish()
        await this.wait([created.id], MAX_WAIT_TIMEOUT_MS)
        await this.collect()
        return 'continue'
      }
      const successfulChecks = existing.checks.filter((check) => check.succeeded)
      const inspected = successfulChecks.some((check) => /\b(?:cat|sed|rg|head|Get-Content)\b|\bgit\s+(?:diff|show)\b/i.test(check.command))
      const configuredCheck = this.parent.config.checks.beforeFinish?.trim()
      const verified = successfulChecks.some((check) => configuredCheck ? check.command.trim() === configuredCheck && resolve(check.workdir ?? '') === resolve(existing.worktree?.cwd ?? this.parent.cwd) : /^(?:(?:pnpm|npm|yarn|bun)(?:\s+--filter\s+\S+)?\s+(?:run\s+)?(?:test(?::[\w-]+)?|typecheck|check|build)\b|(?:pnpm|npm|yarn|bun|npx)\s+(?:exec\s+)?(?:vitest|jest|tsc)\b|node\s+--test\b|python(?:3)?\s+-m\s+(?:pytest|unittest)\b|pytest\b|cargo\s+(?:test|check)\b|go\s+test\b|mvn\s+(?:test|verify)\b)/i.test(check.command.trim()) && !isReadOnlyCommand(check.command))
      if (existing.status !== 'completed' || existing.verdict !== 'passed' || (role === 'reviewer' && !inspected) || (role === 'tester' && (!verified || existing.checks.some((check) => !check.succeeded)))) {
        state.acceptance.status = 'blocked'
        state.acceptance.reason = `${role === 'reviewer' ? '独立审查' : '测试验证'}未通过：${existing.issues ?? existing.summary ?? existing.status}`
        await this.publish()
        return 'blocked'
      }
    }
    if (await this.fingerprint() !== fingerprint) { state.acceptance.status = 'pending'; state.acceptance.fingerprint = null; await this.publish(); return 'continue' }
    state.acceptance.status = 'passed'
    state.acceptance.reason = '整合后的同一份改动已通过独立审查和实际测试验证。'
    await this.publish()
    return 'passed'
  }
}
