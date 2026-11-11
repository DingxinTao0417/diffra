import { createHash } from 'node:crypto'
import { EXTERNAL_ACCESS_SCOPE, PERMISSION_OPTIONS, type RemoteSnapshot, type SessionUpdate, type StoredSessionSummary, type StoredTurn, UPDATE_SEQ_META_KEY } from '@diffra/core/types'
import { type RemoteEvent, type RemoteSnapshotPage, type RequestCall, requestSchema, type SessionList } from '@diffra/remote/messages'
import { redactText, redactToolCall, redactTurn, redactUpdate } from '@diffra/remote/redact'
import type { RemoteAction, RemoteActionResult, RemoteProjectGrant } from '../../shared/remote'
import type { SessionEvent } from '../session-events'
import type { StoredGrant } from './state'

// 被连接端的会话同步（docs/decisions.md「设备连接」）：给授权的设备列会话、发快照分页、推实时更新。
// 每个请求都按授权重新检查：会话的项目要在这台设备的授权里，归档、无项目、设计任务不给看。发出去的都先脱敏（@diffra/remote/redact）。
// 订阅时先开始缓存实时更新再取快照，快照回来后只补发序号比它大的（core 的 seq，见 UPDATE_SEQ_META_KEY），不丢不重；
// 实时更新按 150 毫秒攒一批发，连续的文字片段合成一条：中转限每台设备每秒 50 帧。
// 远程操作（发消息、新建、停止、回答权限请求）要项目开放了「可查看和操作」，经本机界面做（deps.act）；
// 权限请求只发给正看着这个会话、能操作的设备，只能「允许一次」或「拒绝」，项目外的文件访问只在本机确认

const FLUSH_MS = 150
const BATCH_MAX = 500
const CHANGED_INTERVAL_MS = 1000
const PAGE_TURNS = 10
const PAGE_CHARS = 1_000_000
// 每台设备每分钟最多 30 次操作，其中新建任务最多 5 个
const OPS_PER_MINUTE = 30
const CREATES_PER_MINUTE = 5
const NOT_FOUND = '没有这个会话，或者读不出来'
const VIEW_ONLY = '对方只开放了查看，不能操作'

export interface HostSyncDeps {
  // 这台设备现在的授权（总开关关着或不在列表里是 null）
  grant(deviceId: string): StoredGrant | null
  send(deviceId: string, message: unknown, options?: { compress?: boolean }): boolean
  // 发不出去（积压太多）、请求格式不对：断开它，让它重新连、重新订阅
  drop(deviceId: string): void
  listSessions(): Promise<StoredSessionSummary[]>
  snapshot(params: { sessionId: string; before?: number; maxTurns: number; maxChars: number }): Promise<RemoteSnapshot>
  // 远程操作交给本机界面做
  act(action: RemoteAction): Promise<RemoteActionResult>
  // 替本机的人回答权限请求；已经有人答过了返回 false
  answerPermission(requestId: string, optionId: string): boolean
  audit(deviceId: string, name: string, action: string): void
}

// 发出去的一页：轮次是脱敏后的 StoredTurn（连接端按 snapshotSchema 校验）
type Page = Omit<RemoteSnapshotPage, 'turns'> & { turns: Array<StoredTurn & { omittedImages?: number }> }

type Pending = { kind: 'update'; seq: number; update: SessionUpdate } | { kind: 'turn'; event: Extract<SessionEvent, { type: 'turn-started' }> }

interface Subscription {
  sessionId: string
  // 快照回来之前是 null：期间的动静先攒在 pending
  ready: { cwd: string; epoch: string } | null
  pending: Pending[]
  queue: Array<{ seq: number; update: SessionUpdate }>
}

type PermissionRequest = Extract<RemoteEvent, { event: 'permission.request' }>

interface PendingPermission {
  sessionId: string
  request: PermissionRequest
  // 发给过哪些设备：只有它们能答，答完了要告诉它们
  sentTo: Set<string>
}

interface Device {
  subscriptions: Map<string, Subscription>
  flushTimer: NodeJS.Timeout | null
  changedAt: number
  changedTimer: NodeJS.Timeout | null
}

const normalize = (path: string) => {
  const trimmed = path.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

// 项目在两端之间只用不透明的 id，不发本机路径
export function projectIdOf(path: string): string {
  return createHash('sha256').update(`diffra-project\0${normalize(path)}`).digest('hex').slice(0, 16)
}

const folderName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path

function projectFor(grant: StoredGrant, cwd: string): RemoteProjectGrant | null {
  return grant.projects.find((project) => normalize(project.path) === normalize(cwd)) ?? null
}

function visible(grant: StoredGrant, session: { cwd: string; archived: boolean; design: boolean; noProject: boolean }): RemoteProjectGrant | null {
  if (session.archived || session.design || session.noProject) return null
  return projectFor(grant, session.cwd)
}

function seqOf(update: SessionUpdate): number {
  const diffra = update._meta?.diffra
  const seq = typeof diffra === 'object' && diffra !== null ? (diffra as Record<string, unknown>)[UPDATE_SEQ_META_KEY] : undefined
  return typeof seq === 'number' ? seq : Number.MAX_SAFE_INTEGER
}

// 只有 seq 的 _meta（主智能体的文字）可以合并；子智能体的片段带着它是谁，不合
function mergeable(update: SessionUpdate): update is Extract<SessionUpdate, { sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk' }> {
  if (update.sessionUpdate !== 'agent_message_chunk' && update.sessionUpdate !== 'agent_thought_chunk') return false
  if (update.content.type !== 'text') return false
  const diffra = update._meta?.diffra
  return Object.keys(update._meta ?? {}).every((key) => key === 'diffra') && (typeof diffra !== 'object' || diffra === null || Object.keys(diffra).every((key) => key === UPDATE_SEQ_META_KEY))
}

function merged(entries: Array<{ seq: number; update: SessionUpdate }>): Array<{ seq: number; update: SessionUpdate }> {
  const result: Array<{ seq: number; update: SessionUpdate }> = []
  for (const entry of entries) {
    const last = result.at(-1)
    if (last && mergeable(last.update) && mergeable(entry.update) && last.update.sessionUpdate === entry.update.sessionUpdate) {
      const text = (last.update.content as { text: string }).text + (entry.update.content as { text: string }).text
      last.update = { ...last.update, content: { type: 'text', text } }
      last.seq = entry.seq
    } else result.push({ ...entry })
  }
  return result
}

// 本机在等确认的权限请求里远程能答的部分；项目外的文件访问、没有远程能选的选项时不发
function remotePermission(event: Extract<SessionEvent, { type: 'permission' }>): PermissionRequest | null {
  const rawInput = event.toolCall.rawInput
  if (typeof rawInput === 'object' && rawInput !== null && 'scope' in rawInput && rawInput.scope === EXTERNAL_ACCESS_SCOPE) return null
  const options = event.options.flatMap((option) =>
    option.optionId === PERMISSION_OPTIONS.allowOnce || option.optionId === PERMISSION_OPTIONS.reject ? [{ optionId: option.optionId, name: option.name.slice(0, 200) }] : [],
  )
  if (options.length === 0) return null
  const toolCall = redactToolCall({ ...event.toolCall, title: event.toolCall.title?.slice(0, 2000) })
  return { type: 'event', event: 'permission.request', requestId: event.requestId, sessionId: event.sessionId, toolCall, options }
}

export class HostSync {
  private readonly devices = new Map<string, Device>()
  private readonly permissions = new Map<string, PendingPermission>()
  // 限流按设备记，断线重连不清零
  private readonly rates = new Map<string, { ops: number[]; creates: number[] }>()

  constructor(private readonly deps: HostSyncDeps) {}

  // 通道上来的请求
  async handle(deviceId: string, raw: unknown): Promise<void> {
    const parsed = requestSchema.safeParse(raw)
    if (!parsed.success) {
      console.error('[remote] 对方发来的请求格式不对，断开', parsed.error.issues.slice(0, 3))
      this.deps.drop(deviceId)
      return
    }
    const { id, call } = parsed.data
    try {
      const { value, compress, after } = await this.call(deviceId, call)
      if (!this.deps.send(deviceId, { type: 'response', id, ok: true, value }, { compress })) return this.deps.drop(deviceId)
      after?.()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.send(deviceId, { type: 'response', id, ok: false, error: message.slice(0, 2000) })
    }
  }

  private async call(deviceId: string, call: RequestCall): Promise<{ value: unknown; compress?: boolean; after?: () => void }> {
    const grant = this.deps.grant(deviceId)
    if (!grant) throw new Error('本机没有授权这台设备')
    switch (call.method) {
      case 'sessions.list':
        return { value: await this.list(grant) }
      case 'session.subscribe': {
        const device = this.device(deviceId)
        // 先登记、开始攒实时更新，再取快照
        const subscription: Subscription = { sessionId: call.sessionId, ready: null, pending: [], queue: [] }
        device.subscriptions.set(call.sessionId, subscription)
        try {
          const { page, cwd, epoch, seq, turnIds } = await this.page(grant, call.sessionId)
          return {
            value: page,
            compress: true,
            // 快照发出去之后再补发它之后的动静
            after: () => {
              if (device.subscriptions.get(call.sessionId) !== subscription) return
              subscription.ready = { cwd, epoch }
              for (const item of subscription.pending) {
                if (item.kind === 'update' && item.seq > seq) subscription.queue.push({ seq: item.seq, update: item.update })
                if (item.kind === 'turn' && !turnIds.has(item.event.turnId)) this.sendTurn(deviceId, subscription, item.event)
              }
              subscription.pending = []
              this.scheduleFlush(deviceId)
              for (const pending of this.permissions.values()) if (pending.sessionId === call.sessionId) this.offerPermission(deviceId, cwd, pending)
            },
          }
        } catch (error) {
          if (device.subscriptions.get(call.sessionId) === subscription) device.subscriptions.delete(call.sessionId)
          throw error
        }
      }
      case 'session.page':
        return { value: (await this.page(grant, call.sessionId, call.before)).page, compress: true }
      case 'session.unsubscribe':
        this.devices.get(deviceId)?.subscriptions.delete(call.sessionId)
        return { value: {} }
      case 'session.prompt': {
        const { project, title } = await this.operable(grant, call.sessionId)
        this.charge(deviceId, false)
        const result = await this.deps.act({ kind: 'send', sessionId: call.sessionId, text: call.text, skills: call.skills, source: { deviceId, name: grant.name } })
        if (!result.ok) throw new Error(result.error)
        this.deps.audit(deviceId, grant.name, `远程发消息：${folderName(project.path)}「${title}」`)
        return { value: { queued: result.queued } }
      }
      case 'session.create': {
        // 只认项目 id，不接受对方给的路径
        const project = grant.projects.find((item) => projectIdOf(item.path) === call.projectId)
        if (!project) throw new Error('没有这个项目')
        if (project.level !== 'control') throw new Error(VIEW_ONLY)
        this.charge(deviceId, true)
        const result = await this.deps.act({ kind: 'create', project: project.path, text: call.text, skills: call.skills, source: { deviceId, name: grant.name } })
        if (!result.ok) throw new Error(result.error)
        this.deps.audit(deviceId, grant.name, `远程新建任务：${folderName(project.path)}`)
        return { value: { sessionId: result.sessionId } }
      }
      case 'session.cancel': {
        const { project, title } = await this.operable(grant, call.sessionId)
        this.charge(deviceId, false)
        const result = await this.deps.act({ kind: 'cancel', sessionId: call.sessionId })
        if (!result.ok) throw new Error(result.error)
        this.deps.audit(deviceId, grant.name, `远程停止：${folderName(project.path)}「${title}」`)
        return { value: {} }
      }
      case 'permission.respond': {
        const pending = this.permissions.get(call.requestId)
        if (!pending?.sentTo.has(deviceId)) throw new Error('这个确认已经处理过了')
        const { project } = await this.operable(grant, pending.sessionId)
        // 关掉确认卡片不答也算拒绝，和本机一样
        const optionId = call.optionId ?? PERMISSION_OPTIONS.reject
        if (!pending.request.options.some((option) => option.optionId === optionId)) throw new Error('这个确认没有这个选项')
        this.charge(deviceId, false)
        if (!this.deps.answerPermission(call.requestId, optionId)) throw new Error('这个确认已经处理过了')
        this.deps.audit(deviceId, grant.name, `远程${optionId === PERMISSION_OPTIONS.reject ? '拒绝' : '允许一次'}：${folderName(project.path)}「${pending.request.toolCall.title ?? ''}」`)
        return { value: {} }
      }
    }
  }

  // 能操作的会话：看得到（同列表的规则），项目开放了「可查看和操作」。没授权和不存在说法一样
  private async operable(grant: StoredGrant, sessionId: string): Promise<{ project: RemoteProjectGrant; title: string }> {
    const session = (await this.deps.listSessions()).find((item) => item.sessionId === sessionId)
    const project = session ? visible(grant, session) : null
    if (!session || !project) throw new Error(NOT_FOUND)
    if (project.level !== 'control') throw new Error(VIEW_ONLY)
    return { project, title: session.title }
  }

  private charge(deviceId: string, create: boolean): void {
    const now = Date.now()
    const rate = this.rates.get(deviceId) ?? { ops: [], creates: [] }
    this.rates.set(deviceId, rate)
    rate.ops = rate.ops.filter((at) => now - at < 60_000)
    rate.creates = rate.creates.filter((at) => now - at < 60_000)
    if (rate.ops.length >= OPS_PER_MINUTE || (create && rate.creates.length >= CREATES_PER_MINUTE)) throw new Error('操作太频繁，过一会儿再试')
    rate.ops.push(now)
    if (create) rate.creates.push(now)
  }

  // 正看着这个会话、能操作的设备才发；每台只发一次
  private offerPermission(deviceId: string, cwd: string, pending: PendingPermission): void {
    const grant = this.deps.grant(deviceId)
    if (!grant || projectFor(grant, cwd)?.level !== 'control' || pending.sentTo.has(deviceId)) return
    pending.sentTo.add(deviceId)
    this.deps.send(deviceId, pending.request)
  }

  private async list(grant: StoredGrant): Promise<SessionList> {
    const sessions = await this.deps.listSessions()
    return {
      projects: grant.projects.map((project) => ({ id: projectIdOf(project.path), name: folderName(project.path), level: project.level })),
      sessions: sessions.flatMap((session) => {
        const project = visible(grant, session)
        if (!project) return []
        return [{ sessionId: session.sessionId, projectId: projectIdOf(project.path), title: redactText(session.title).slice(0, 200), updatedAt: session.updatedAt, running: session.running, turnCount: session.turnCount }]
      }),
    }
  }

  private async page(grant: StoredGrant, sessionId: string, before?: number): Promise<{ page: Page; cwd: string; epoch: string; seq: number; turnIds: Set<string> }> {
    const snapshot = await this.deps.snapshot({ sessionId, ...(before === undefined ? {} : { before }), maxTurns: PAGE_TURNS, maxChars: PAGE_CHARS }).catch((error: unknown) => {
      console.error('[remote] 读会话快照失败', error)
      throw new Error('没有这个会话，或者读不出来')
    })
    const project = visible(grant, snapshot)
    // 没授权和不存在说法一样，不让对方试探本机有哪些会话
    if (!project) throw new Error('没有这个会话，或者读不出来')
    const page: Page = {
      sessionId,
      projectId: projectIdOf(project.path),
      title: redactText(snapshot.title).slice(0, 200),
      running: snapshot.running,
      ...(snapshot.taskState ? { taskState: snapshot.taskState } : {}),
      totalTurns: snapshot.totalTurns,
      start: snapshot.start,
      turns: snapshot.turns.map(redactTurn),
      epoch: snapshot.epoch,
      seq: snapshot.seq,
    }
    return { page, cwd: snapshot.cwd, epoch: snapshot.epoch, seq: snapshot.seq, turnIds: new Set(snapshot.turns.map((turn) => turn.id)) }
  }

  // 主进程里会话的动静
  sessionEvent(event: SessionEvent): void {
    if (event.type === 'changed') return this.broadcastChanged()
    if (event.type === 'permission') {
      const request = remotePermission(event)
      if (!request) return
      const pending: PendingPermission = { sessionId: event.sessionId, request, sentTo: new Set() }
      this.permissions.set(event.requestId, pending)
      for (const [deviceId, device] of this.devices) {
        const ready = device.subscriptions.get(event.sessionId)?.ready
        if (ready) this.offerPermission(deviceId, ready.cwd, pending)
      }
      return
    }
    if (event.type === 'permission-settled') {
      const pending = this.permissions.get(event.requestId)
      this.permissions.delete(event.requestId)
      for (const deviceId of pending?.sentTo ?? []) this.deps.send(deviceId, { type: 'event', event: 'permission.settled', requestId: event.requestId })
      return
    }
    const sessionId = event.type === 'update' ? event.notification.sessionId : event.sessionId
    for (const [deviceId, device] of this.devices) {
      const subscription = device.subscriptions.get(sessionId)
      if (!subscription) continue
      switch (event.type) {
        case 'update': {
          const update = redactUpdate(event.notification.update)
          const seq = seqOf(event.notification.update)
          if (subscription.ready) {
            subscription.queue.push({ seq, update })
            this.scheduleFlush(deviceId)
          } else subscription.pending.push({ kind: 'update', seq, update })
          break
        }
        case 'turn-started':
          if (subscription.ready) this.sendTurn(deviceId, subscription, event)
          else subscription.pending.push({ kind: 'turn', event })
          break
        case 'reset':
          device.subscriptions.delete(sessionId)
          this.deps.send(deviceId, { type: 'event', event: 'session.reset', sessionId })
          break
      }
    }
    if (event.type === 'turn-started') this.broadcastChanged()
  }

  // 授权改了：已经看不到的会话让对方重新订阅（会被拒），列表也让它重新取
  grantsChanged(): void {
    for (const [deviceId, device] of this.devices) {
      const grant = this.deps.grant(deviceId)
      for (const [sessionId, subscription] of device.subscriptions) {
        if (grant && subscription.ready && projectFor(grant, subscription.ready.cwd)) continue
        if (!subscription.ready && grant) continue
        device.subscriptions.delete(sessionId)
        this.deps.send(deviceId, { type: 'event', event: 'session.reset', sessionId })
      }
    }
    this.broadcastChanged()
  }

  opened(deviceId: string): void {
    this.device(deviceId)
  }

  closed(deviceId: string): void {
    const device = this.devices.get(deviceId)
    if (!device) return
    if (device.flushTimer) clearTimeout(device.flushTimer)
    if (device.changedTimer) clearTimeout(device.changedTimer)
    this.devices.delete(deviceId)
  }

  private device(deviceId: string): Device {
    let device = this.devices.get(deviceId)
    if (!device) {
      device = { subscriptions: new Map(), flushTimer: null, changedAt: 0, changedTimer: null }
      this.devices.set(deviceId, device)
    }
    return device
  }

  // 一轮开始：先把攒着的上一轮的更新发掉，顺序不能乱
  private sendTurn(deviceId: string, subscription: Subscription, event: Extract<SessionEvent, { type: 'turn-started' }>): void {
    this.flushSubscription(deviceId, subscription)
    this.deps.send(deviceId, {
      type: 'event',
      event: 'turn.started',
      sessionId: subscription.sessionId,
      turnId: event.turnId,
      kind: event.kind,
      prompt: redactText(event.prompt),
      startedAt: event.startedAt,
      ...(event.from ? { from: { sessionId: event.from.sessionId, title: redactText(event.from.title).slice(0, 200) } } : {}),
      ...(event.remote ? { remote: event.remote } : {}),
    })
  }

  private scheduleFlush(deviceId: string): void {
    const device = this.devices.get(deviceId)
    if (!device || device.flushTimer) return
    device.flushTimer = setTimeout(() => {
      device.flushTimer = null
      for (const subscription of device.subscriptions.values()) this.flushSubscription(deviceId, subscription)
    }, FLUSH_MS)
  }

  private flushSubscription(deviceId: string, subscription: Subscription): void {
    if (!subscription.ready || subscription.queue.length === 0) return
    const updates = merged(subscription.queue)
    subscription.queue = []
    for (let start = 0; start < updates.length; start += BATCH_MAX) {
      const ok = this.deps.send(deviceId, { type: 'event', event: 'session.updates', sessionId: subscription.sessionId, epoch: subscription.ready.epoch, updates: updates.slice(start, start + BATCH_MAX) })
      if (!ok) return this.deps.drop(deviceId)
    }
  }

  // 列表可能变了：每台设备最多一秒说一次
  private broadcastChanged(): void {
    for (const [deviceId, device] of this.devices) {
      if (device.changedTimer) continue
      const wait = Math.max(0, device.changedAt + CHANGED_INTERVAL_MS - Date.now())
      device.changedTimer = setTimeout(() => {
        device.changedTimer = null
        device.changedAt = Date.now()
        this.deps.send(deviceId, { type: 'event', event: 'sessions.changed' })
      }, wait)
    }
  }
}
