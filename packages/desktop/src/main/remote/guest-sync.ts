import {
  createResultSchema,
  eventSchema,
  okSchema,
  promptResultSchema,
  type RemoteResumed,
  type RemoteSnapshotPage,
  type RequestCall,
  responseSchema,
  type SessionList,
  sessionListSchema,
  snapshotSchema,
  subscribeResultSchema,
  type RemoteToolOutput,
  branchesSchema,
  commandsListSchema,
  modelsListSchema,
  restorePreviewSchema,
  sessionDetailsSchema,
  sessionDiffSchema,
  skillsListSchema,
  terminalOpenedSchema,
  toolOutputSchema,
} from '@diffra/remote/messages'
import type { z } from 'zod'
import type { RemoteSyncEvent } from '../../shared/remote'
import { logRemote } from '../app-log'
import type { OpenFailure, OpenResult } from './links'

// 连接端：向被连接端发请求、收它推来的动静。对方来的一律按 @diffra/remote/messages 校验，不合格的丢掉。
// 订阅归界面管：通道断了告诉界面，等对方重新在线后界面自己重新订阅、整页换掉

const REQUEST_TIMEOUT_MS = 30_000

// 建不起通道时照实说原因
const OPEN_FAILURES: Record<OpenFailure, string> = {
  relay: '和中转服务断开了，或者对方刚掉线，正在重连',
  offline: '对方现在不在线，等对方上线后再试',
  timeout: '对方 10 秒没有回应：可能刚掉线，或者网络不好',
  handshake: '和对方的加密握手失败：对方可能重置过本机身份，要重新配对',
  off: '对方关掉了「允许连接本机」',
  'not-granted': '对方没有授权本机，或者已经撤销，要对方重新开放',
  'unknown-peer': '本机没有这台设备的密钥，要重新添加',
}

// 走通用请求（call）的方法和它们回复的格式
const RESULT_SCHEMAS: Partial<Record<RequestCall['method'], z.ZodType>> = {
  'session.details': sessionDetailsSchema,
  'session.diff': sessionDiffSchema,
  'session.prompt': promptResultSchema,
  'models.list': modelsListSchema,
  'skills.list': skillsListSchema,
  'commands.list': commandsListSchema,
  'session.restorePreview': restorePreviewSchema,
  'session.setModel': okSchema,
  'session.setPermissionMode': okSchema,
  'session.compact': okSchema,
  'session.regenerate': okSchema,
  'session.restore': okSchema,
  'project.branches': branchesSchema,
  'project.switchBranch': okSchema,
  'terminal.open': terminalOpenedSchema,
  'terminal.input': okSchema,
  'terminal.resize': okSchema,
  'terminal.close': okSchema,
}

export interface GuestSyncDeps {
  open(deviceId: string): Promise<OpenResult>
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

  // resume：断线前看到的位置，对方接得上就只补发后面的
  subscribe(deviceId: string, sessionId: string, resume?: { epoch: string; seq: number }): Promise<RemoteSnapshotPage | RemoteResumed> {
    return this.request(deviceId, { method: 'session.subscribe', sessionId, ...(resume ? { resume } : {}) }, subscribeResultSchema)
  }

  page(deviceId: string, sessionId: string, before: number): Promise<RemoteSnapshotPage> {
    return this.request(deviceId, { method: 'session.page', sessionId, before }, snapshotSchema)
  }

  call(deviceId: string, call: RequestCall): Promise<unknown> {
    const schema = RESULT_SCHEMAS[call.method]
    if (!schema) return Promise.reject(new Error(`不支持的请求：${call.method}`))
    return this.request(deviceId, call, schema)
  }

  toolOutput(deviceId: string, sessionId: string, turn: number, turnId: string, toolCallId: string): Promise<RemoteToolOutput> {
    return this.request(deviceId, { method: 'session.toolOutput', sessionId, turn, turnId, toolCallId }, toolOutputSchema)
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

  async forget(deviceId: string): Promise<void> {
    await this.request(deviceId, { method: 'device.forget' }, okSchema)
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
    logRemote('对方发来的消息格式不对，丢掉')
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
    const opened = await this.deps.open(deviceId)
    if (!opened.ok) {
      const message = OPEN_FAILURES[opened.reason]
      // 被明确拒绝：告诉界面，它那边把这台设备的列表收起来、不自动重试
      if (opened.reason === 'off' || opened.reason === 'not-granted') this.deps.publish({ deviceId, refused: opened.reason, message })
      throw new Error(message)
    }
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
