import { randomUUID } from 'node:crypto'
import type * as acp from '@agentclientprotocol/sdk'
import type { Checkpoints } from '../checkpoint.js'
import {
  type CheckpointChange,
  formatSteps,
  MODEL_SILENCE_META_KEY,
  type PermissionMode,
  type PromptImage,
  restoreNotice,
  type SessionAgentRef,
  type ExternalAgentSpec,
  STEPS_CARD_TITLE,
  type StepItem,
  type StoredTurn,
  type TaskSource,
  TURN_OUTCOME_META_KEY,
  type TurnOutcome,
} from '../protocol.js'
import type { SessionRecord } from '../session/store.js'
import { newTaskState, TASK_STATE_META_KEY, type TaskState } from '../session/task-state.js'
import { ExternalAgentError, ExternalAgentProcess } from './connection.js'

const TITLE_CHARS = 40
// 停止后等智能体自己收尾（回 cancelled）的时间，到了还没回就结束进程；DIFFRA_EXTERNAL_CANCEL_GRACE_MS 只给测试缩短用
function cancelGraceMs(): number {
  return Number(process.env.DIFFRA_EXTERNAL_CANCEL_GRACE_MS) || 10_000
}
// 一轮结束后进程空闲这么久就结束，下次发消息时重新起、接上原来的会话
const IDLE_MS = 15 * 60_000
// 跑着的一轮里没写进记录的更新，隔这么久存一次盘，应用崩了也不会整轮丢掉
const PERSIST_EVERY_MS = 10_000

// 和 Diffra 自己的智能体一样，这么久一点输出都没有就提示可能卡住了；DIFFRA_MODEL_SILENCE_MS 只给测试缩短用
function silenceMs(): number {
  return Number(process.env.DIFFRA_MODEL_SILENCE_MS) || 3 * 60_000
}

// 外接智能体发来的东西里的 _meta.diffra 去掉：界面按它认 Diffra 自己的卡片、任务状态和结论，不能让外部进程冒充
function withoutDiffraMeta<T extends { _meta?: { [key: string]: unknown } | null }>(value: T): T {
  if (!value._meta || !('diffra' in value._meta)) return value
  const { diffra: _diffra, ...rest } = value._meta
  return { ...value, _meta: rest }
}

const REVERT_NOTE =
  '[Note from Diffra] The user reverted all file changes made since an earlier point in this conversation. ' +
  'Files may differ from what you saw before; read them again before editing.\n\n'

export interface ExternalTurnIO {
  // 记进这一轮之后推给客户端
  notify(update: acp.SessionUpdate): Promise<void>
  persist(): Promise<void>
  // 转给客户端的确认请求（会话 id 已经换成 Diffra 的）
  askClient(toolCall: acp.ToolCallUpdate, options: acp.PermissionOption[], signal: AbortSignal): Promise<acp.RequestPermissionResponse>
}

export interface ExternalSessionOptions {
  id?: string
  cwd: string
  agent: SessionAgentRef
  // 设置里已经删掉了这个智能体时为 null：照样能打开看历史，发消息时说明
  spec: ExternalAgentSpec | null
  permissionMode: PermissionMode
  checkpoints: Checkpoints | null
  noProject: boolean
  record?: SessionRecord
}

export class ExternalSession {
  readonly id: string
  readonly cwd: string
  readonly createdAt: string
  private updatedAt: string
  title: string
  archived: boolean
  readonly noProject: boolean
  readonly agent: SessionAgentRef
  spec: ExternalAgentSpec | null
  externalSessionId: string | null
  readonly turns: StoredTurn[] = []
  readonly turnCheckpoints = new Map<string, string>()
  taskState: TaskState = newTaskState()
  permissionMode: PermissionMode
  readonly checkpoints: Checkpoints | null
  activeTurn: AbortController | null = null
  private process: ExternalAgentProcess | null = null
  private idleTimer: NodeJS.Timeout | null = null
  // 接上原来的会话时智能体重发的历史不转发
  private resuming = false
  // 撤销过文件：下一条消息前面告诉智能体
  private reverted = false
  private turnPending = false
  private stopPending = false
  // 正在跑的一轮：收到的更新、确认请求交给它
  private sink: { update(update: acp.SessionUpdate): void; ask(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> } | null = null

  constructor(options: ExternalSessionOptions) {
    const record = options.record
    this.id = record?.id ?? options.id ?? randomUUID()
    this.cwd = options.cwd
    this.createdAt = record?.createdAt ?? new Date().toISOString()
    this.updatedAt = record?.updatedAt ?? this.createdAt
    this.title = record?.title ?? ''
    this.archived = record?.archived ?? false
    this.noProject = record?.noProject ?? options.noProject
    this.agent = record?.agent ?? options.agent
    this.spec = options.spec
    this.externalSessionId = record?.externalSessionId ?? null
    this.permissionMode = options.permissionMode
    this.checkpoints = options.checkpoints
    if (record) {
      const state = record.taskState ?? newTaskState()
      this.taskState = state.status === 'running' && record.turns.at(-1)?.endedAt === null ? { ...state, status: 'blocked', reason: '应用退出时这一轮没跑完。' } : state
      for (const { checkpoint, gitBase: _gitBase, messageStart: _messageStart, ...turn } of record.turns) {
        this.turns.push(turn)
        if (checkpoint) this.turnCheckpoints.set(turn.id, checkpoint)
      }
    }
  }

  get running(): boolean {
    return this.activeTurn !== null
  }

  turnRequested(): void {
    this.turnPending = true
    this.stopPending = false
  }

  cancel(): void {
    if (this.activeTurn) this.activeTurn.abort()
    else if (this.turnPending) this.stopPending = true
  }

  private startTurn(id: string, prompt: string, images: PromptImage[], skills: string[], from?: TaskSource): void {
    if (!this.title) {
      const firstLine = prompt.trim().split(/\r?\n/)[0] ?? ''
      this.title = firstLine.length > TITLE_CHARS ? `${firstLine.slice(0, TITLE_CHARS)}…` : firstLine
    }
    this.turns.push({ id, kind: 'prompt', prompt, startedAt: new Date().toISOString(), endedAt: null, stopReason: null, updates: [], skills, images, ...(from ? { from } : {}) })
  }

  // 连续的文字片段并成一条，和 Diffra 自己的会话一样
  private recordUpdate(update: acp.SessionUpdate): void {
    const turn = this.turns.at(-1)
    if (!turn || turn.endedAt) return
    const last = turn.updates.at(-1)
    if (
      (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') &&
      last?.sessionUpdate === update.sessionUpdate &&
      last.content.type === 'text' &&
      update.content.type === 'text'
    ) {
      turn.updates[turn.updates.length - 1] = { ...last, content: { ...last.content, text: last.content.text + update.content.text } }
      return
    }
    if (update.sessionUpdate === 'usage_update') {
      const previous = turn.updates.findIndex((item) => item.sessionUpdate === 'usage_update')
      if (previous >= 0) turn.updates.splice(previous, 1)
    }
    turn.updates.push(update)
  }

  toRecord(touch = true): SessionRecord {
    if (touch) this.updatedAt = new Date().toISOString()
    return {
      version: 1,
      taskState: this.taskState,
      id: this.id,
      cwd: this.cwd,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      archived: this.archived,
      design: false,
      designStyle: null,
      noProject: this.noProject,
      agent: this.agent,
      externalSessionId: this.externalSessionId,
      turns: this.turns.map((turn) => ({ ...turn, checkpoint: this.turnCheckpoints.get(turn.id) ?? null, messageStart: null })),
      messages: [],
      compaction: null,
    }
  }

  // 进程转来的更新和确认请求：只认这个任务在智能体那边的会话
  private readonly handlers = {
    update: (sessionId: string, update: acp.SessionUpdate) => {
      if (this.resuming || sessionId !== this.externalSessionId) return
      this.sink?.update(withoutDiffraMeta(update))
    },
    permission: async (request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> => {
      if (request.sessionId !== this.externalSessionId || !this.sink) return { outcome: { outcome: 'cancelled' } }
      return this.sink.ask(request)
    },
  }

  private async ensureProcess(signal: AbortSignal, notice: (title: string, description: string) => Promise<void>): Promise<ExternalAgentProcess> {
    const spec = this.spec
    // 设置里改过命令、参数、环境变量的，换成新的进程（接着原来的会话）
    if (spec && this.process?.alive && JSON.stringify(this.process.spec) === JSON.stringify(spec)) return this.process
    await this.disposeProcess()
    if (!spec) throw new ExternalAgentError('not-installed', `这个任务用的外接智能体「${this.agent.name}」已经不在设置里了，到「设置 → 外接智能体」里加回来再继续`)
    const process = await ExternalAgentProcess.start(spec, this.cwd, this.handlers, signal)
    this.process = process
    void process.exited.then(() => {
      if (this.process === process) this.process = null
    })
    if (this.externalSessionId && process.loadSession) {
      this.resuming = true
      try {
        await process.resumeSession(this.externalSessionId, this.cwd)
        return process
      } catch (error) {
        if (error instanceof ExternalAgentError && (error.kind === 'auth' || error.kind === 'exited')) throw error
        await notice(`接不上和 ${spec.name} 原来的对话`, `这次开了新对话，之前的上下文它看不到。原因：${error instanceof Error ? error.message : String(error)}`)
      } finally {
        this.resuming = false
      }
    } else if (this.externalSessionId) {
      await notice(`${spec.name} 不支持接着原来的对话`, '这次开了新对话，之前的上下文它看不到。')
    }
    this.externalSessionId = await process.newSession(this.cwd)
    return process
  }

  // 一轮：打检查点 → 起进程（或接上）→ 发提问 → 转发更新和确认 → 算改了哪些文件、发结论
  // text 记进这一轮、显示给用户；agentText 是实际发给智能体的（选了 Skill 时前面带着 Skill 的说明），不给就是 text
  async runTurn(turnId: string, text: string, images: PromptImage[], skills: string[], io: ExternalTurnIO, from?: TaskSource, agentText?: string): Promise<acp.StopReason> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const controller = new AbortController()
    if (this.stopPending) controller.abort()
    this.turnPending = false
    this.stopPending = false
    this.activeTurn = controller
    this.startTurn(turnId, text, images, skills, from)
    let lastPersist = Date.now()
    const record = (update: acp.SessionUpdate) => {
      this.recordUpdate(update)
      void io.notify(update).catch(() => {})
      if (Date.now() - lastPersist > PERSIST_EVERY_MS) {
        lastPersist = Date.now()
        void io.persist()
      }
    }
    const notice = async (title: string, description: string, severity: 'info' | 'warning' | 'error' = 'warning') =>
      record({ sessionUpdate: 'notice', severity, title, description } as acp.SessionUpdate)
    await io.persist()

    // 很久没有输出时提示；又有输出时收回
    let lastActivity = Date.now()
    let silent = false
    const silence = (since: string | null) => record({ sessionUpdate: 'session_info_update', _meta: { diffra: { [MODEL_SILENCE_META_KEY]: since } } })
    const activity = () => {
      lastActivity = Date.now()
      if (silent) {
        silent = false
        silence(null)
      }
    }
    const watchdog = setInterval(() => {
      if (!silent && Date.now() - lastActivity >= silenceMs()) {
        silent = true
        silence(new Date(lastActivity).toISOString())
      }
    }, Math.min(30_000, Math.max(50, silenceMs() / 4)))
    watchdog.unref()

    // 智能体的步骤清单（ACP 的 plan）画成和 Diffra 一样的步骤卡片
    const stepsId = `${turnId}:steps`
    let stepsShown = false
    this.sink = {
      update: (update) => {
        activity()
        if (update.sessionUpdate === 'plan') {
          const steps: StepItem[] = update.entries.map((entry) => ({ content: entry.content, status: entry.status }))
          const done = steps.filter((step) => step.status === 'completed').length
          record({
            sessionUpdate: stepsShown ? 'tool_call_update' : 'tool_call',
            toolCallId: stepsId,
            title: STEPS_CARD_TITLE,
            kind: 'think',
            status: done === steps.length ? 'completed' : 'in_progress',
            content: [{ type: 'content', content: { type: 'text', text: formatSteps(steps) } }],
          })
          stepsShown = true
          return
        }
        // 可用命令、模式这些是智能体自己的界面状态，Diffra 不显示，也不记进轮次
        if (update.sessionUpdate === 'available_commands_update' || update.sessionUpdate === 'current_mode_update' || update.sessionUpdate === 'user_message_chunk') return
        record(update)
      },
      ask: async (request) => {
        activity()
        // 完全放行：选它给的「允许」（优先只允许这一次），不再问
        if (this.permissionMode === 'full') {
          const allow = request.options.find((option) => option.kind === 'allow_once') ?? request.options.find((option) => option.kind === 'allow_always')
          if (allow) return { outcome: { outcome: 'selected', optionId: allow.optionId } }
        }
        const response = await io.askClient(withoutDiffraMeta(request.toolCall), request.options, controller.signal)
        activity()
        return response
      },
    }

    let stopReason: acp.StopReason = 'end_turn'
    const outcome: TurnOutcome = { finish: null, stop: null }
    let base: string | null = null
    try {
      if (this.checkpoints) {
        base = await this.checkpoints.snapshot().catch((error: unknown) => {
          console.error('[external] 打检查点失败', error)
          return null
        })
        if (base) this.turnCheckpoints.set(turnId, base)
      }
      if (controller.signal.aborted) throw new ExternalAgentError('exited', '已停止')
      const process = await this.ensureProcess(controller.signal, (title, description) => notice(title, description, 'info'))
      if (images.length > 0 && !process.images) throw new ExternalAgentError('unsupported', `${process.spec.name} 不收图片，去掉图片再发`)
      const prompt: acp.ContentBlock[] = [
        { type: 'text', text: (this.reverted ? REVERT_NOTE : '') + (agentText ?? text) },
        ...images.map((image) => ({ type: 'image' as const, mimeType: image.mimeType, data: image.data })),
      ]
      this.reverted = false
      stopReason = await this.promptUntilStopped(process, prompt, controller.signal)
    } catch (error) {
      if (controller.signal.aborted) stopReason = 'cancelled'
      else {
        const failure = error instanceof ExternalAgentError ? error : new ExternalAgentError('start-failed', error instanceof Error ? error.message : String(error))
        outcome.stop = 'agent-error'
        outcome.agentError = { kind: failure.kind, message: failure.message }
        await notice(failure.message, failure.detail ? `最后的输出：\n${failure.detail}` : '', 'error')
        // 进程坏了就不留着，下次重新起
        if (failure.kind === 'exited' || failure.kind === 'timeout') await this.disposeProcess()
      }
    } finally {
      clearInterval(watchdog)
      if (silent && stopReason !== 'cancelled') silence(null)
      this.sink = null
    }
    if (stopReason === 'cancelled') outcome.stop = 'cancelled'
    if (!outcome.stop) {
      const changes = base && this.checkpoints ? await this.checkpoints.changesSince(base).catch(() => null) : null
      const edited = changes ? changes.length > 0 : this.turns.at(-1)!.updates.some((update) => (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') && update.content?.some((content) => content.type === 'diff'))
      // Diffra 不管外接智能体怎么收尾，改过文件就算「没经过 Diffra 的自动验证」
      outcome.finish = edited ? 'unverified' : 'no-edits'
    }
    this.taskState = {
      status: outcome.stop === 'cancelled' ? 'cancelled' : outcome.stop ? 'blocked' : 'completed',
      needsVerification: false,
      reason: outcome.agentError?.message ?? null,
    }
    record({
      sessionUpdate: 'session_info_update',
      _meta: { diffra: { [TASK_STATE_META_KEY]: { status: this.taskState.status, reason: this.taskState.reason, requirements: [], needsVerification: false }, [TURN_OUTCOME_META_KEY]: outcome } },
    })
    const turn = this.turns.at(-1)
    if (turn && !turn.endedAt) {
      turn.endedAt = new Date().toISOString()
      turn.stopReason = stopReason
    }
    this.activeTurn = null
    await io.persist()
    this.idleTimer = setTimeout(() => void this.disposeProcess(), IDLE_MS)
    this.idleTimer.unref()
    return stopReason
  }

  // 停止：先请智能体自己停，等它回 cancelled；等不到就结束进程
  private async promptUntilStopped(process: ExternalAgentProcess, prompt: acp.ContentBlock[], signal: AbortSignal): Promise<acp.StopReason> {
    const sessionId = this.externalSessionId!
    const running = process.prompt(sessionId, prompt)
    let grace: NodeJS.Timeout | null = null
    let onAbort: (() => void) | null = null
    const stopped = new Promise<acp.StopReason>((resolve) => {
      onAbort = () => {
        process.cancel(sessionId)
        grace = setTimeout(() => {
          if (this.process === process) void this.disposeProcess()
          resolve('cancelled')
        }, cancelGraceMs())
        grace.unref()
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const result = await Promise.race([running.catch((error: unknown) => (signal.aborted ? ('cancelled' as const) : Promise.reject(error))), stopped])
      return signal.aborted ? 'cancelled' : result
    } finally {
      if (grace) clearTimeout(grace)
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }

  async checkpointChanges(turnId: string): Promise<CheckpointChange[]> {
    const base = this.turnCheckpoints.get(turnId)
    if (!this.checkpoints || !base) throw new Error('这一轮没有检查点，无法撤销')
    return this.checkpoints.changesSince(base)
  }

  async checkpointDiff(turnId: string): Promise<string> {
    const base = this.turnCheckpoints.get(turnId)
    if (this.checkpoints && base) return this.checkpoints.diffSince(base)
    if (this.checkpoints && this.running && this.turns.at(-1)?.id === turnId) return ''
    throw new Error('这一轮没有检查点，看不了改动')
  }

  async restoreCheckpoint(turnId: string): Promise<CheckpointChange[]> {
    if (this.running) throw new Error('任务还在进行中，先停止再撤销')
    const changes = await this.checkpointChanges(turnId)
    await this.checkpoints!.restore(this.turnCheckpoints.get(turnId)!, changes)
    this.reverted = true
    this.taskState = { ...this.taskState, status: 'blocked', needsVerification: false, reason: '文件已撤销，原来的结论不再算数。' }
    const index = this.turns.findIndex((turn) => turn.id === turnId)
    const target = this.turns[index]
    if (target) {
      const restoredAt = new Date().toISOString()
      for (const turn of this.turns.slice(index)) turn.restoredAt = restoredAt
      target.updates.push({ sessionUpdate: 'notice', severity: 'info', ...restoreNotice(changes) } as acp.SessionUpdate)
    }
    return changes
  }

  private async disposeProcess(): Promise<void> {
    const process = this.process
    this.process = null
    await process?.dispose()
  }

  // 删除任务、core 退出：等进程退出再返回
  async dispose(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.activeTurn?.abort()
    await this.disposeProcess()
  }
}
