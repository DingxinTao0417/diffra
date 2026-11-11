import {
  createResultSchema,
  eventSchema,
  okSchema,
  promptResultSchema,
  type RemoteSnapshotPage,
  type RequestCall,
  responseSchema,
  type SessionList,
  sessionListSchema,
  snapshotSchema,
} from '@diffra/remote/messages'
import type { z } from 'zod'
import type { RemoteSyncEvent } from '../../shared/remote'

// 连接端：向被连接端发请求、收它推来的动静。对方来的一律按 @diffra/remote/messages 校验，不合格的丢掉。
// 订阅归界面管：通道断了告诉界面，等对方重新在线后界面自己重新订阅、整页换掉

const REQUEST_TIMEOUT_MS = 30_000

export interface GuestSyncDeps {
  open(deviceId: string): Promise<boolean>
  send(deviceId: string, message: unknown): boolean
  publish(event: RemoteSyncEvent): void
}

interface Waiting {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

export class GuestSync {
  private nextId = 1
  private readonly waiting = new Map<string, Map<number, Waiting>>()

  constructor(private readonly deps: GuestSyncDeps) {}

  list(deviceId: string): Promise<SessionList> {
    return this.request(deviceId, { method: 'sessions.list' }, sessionListSchema)
  }

  subscribe(deviceId: string, sessionId: string): Promise<RemoteSnapshotPage> {
    return this.request(deviceId, { method: 'session.subscribe', sessionId }, snapshotSchema)
  }

  page(deviceId: string, sessionId: string, before: number): Promise<RemoteSnapshotPage> {
    return this.request(deviceId, { method: 'session.page', sessionId, before }, snapshotSchema)
  }

  prompt(deviceId: string, sessionId: string, text: string): Promise<{ queued: boolean }> {
    return this.request(deviceId, { method: 'session.prompt', sessionId, text, skills: [] }, promptResultSchema)
  }

  create(deviceId: string, projectId: string, text: string): Promise<{ sessionId: string }> {
    return this.request(deviceId, { method: 'session.create', projectId, text, skills: [] }, createResultSchema)
  }

  async cancel(deviceId: string, sessionId: string): Promise<void> {
    await this.request(deviceId, { method: 'session.cancel', sessionId }, okSchema)
  }

  async respondPermission(deviceId: string, requestId: string, optionId: 'allow_once' | 'reject'): Promise<void> {
    await this.request(deviceId, { method: 'permission.respond', requestId, optionId }, okSchema)
  }

  async unsubscribe(deviceId: string, sessionId: string): Promise<void> {
    // 对方不在线就不用退订了，通道断开时它那边已经清掉
    await this.request(deviceId, { method: 'session.unsubscribe', sessionId }, null).catch(() => {})
  }

  message(deviceId: string, raw: unknown): void {
    const response = responseSchema.safeParse(raw)
    if (response.success) {
      const waiting = this.waiting.get(deviceId)?.get(response.data.id)
      if (!waiting) return
      this.waiting.get(deviceId)?.delete(response.data.id)
      clearTimeout(waiting.timer)
      if (response.data.ok) waiting.resolve(response.data.value)
      else waiting.reject(new Error(response.data.error))
      return
    }
    const event = eventSchema.safeParse(raw)
    if (event.success) return this.deps.publish({ deviceId, event: event.data })
    console.error('[remote] 对方发来的消息格式不对，丢掉')
  }

  closed(deviceId: string): void {
    const waiting = this.waiting.get(deviceId)
    this.waiting.delete(deviceId)
    for (const item of waiting?.values() ?? []) {
      clearTimeout(item.timer)
      item.reject(new Error('和对方的连接断开了'))
    }
    this.deps.publish({ deviceId, disconnected: true })
  }

  private async request<T>(deviceId: string, call: RequestCall, schema: z.ZodType<T> | null): Promise<T> {
    if (!(await this.deps.open(deviceId))) throw new Error('对方不在线，或者对方已经不再授权本机')
    const id = this.nextId++
    const value = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.get(deviceId)?.delete(id)
        reject(new Error('对方没有回应'))
      }, REQUEST_TIMEOUT_MS)
      let waiting = this.waiting.get(deviceId)
      if (!waiting) {
        waiting = new Map()
        this.waiting.set(deviceId, waiting)
      }
      waiting.set(id, { resolve, reject, timer })
      if (!this.deps.send(deviceId, { type: 'request', id, call })) {
        clearTimeout(timer)
        waiting.delete(id)
        reject(new Error('和中转服务断开了'))
      }
    })
    if (!schema) return value as T
    const parsed = schema.safeParse(value)
    if (!parsed.success) throw new Error('对方回的内容格式不对')
    return parsed.data
  }
}
