import { createServer, type Server, type Socket } from 'node:net'
import { app } from 'electron'
import { BRIDGE_PROTOCOL, type BridgeCall, type BridgeTask, type DiffraMessage, type ExtensionMessage, type ExternalBrowserKind } from '../shared/browser-bridge'
import type { BridgeEndpoint } from './native-host-registry'

const CALL_TIMEOUT_MS = 30_000
// 连上来的宿主要在这么久里报上令牌
const AUTH_TIMEOUT_MS = 5_000
// 一行消息的上限（整页截图的 base64 可能有十几 MB）
const MAX_LINE_CHARS = 128 * 1024 * 1024

// 一个浏览器（一个配置文件）里的扩展经宿主连上来的一条连接
export class BridgeConnection {
  private static nextConnectionId = 1
  readonly id = BridgeConnection.nextConnectionId++
  browser: ExternalBrowserKind = 'chrome'
  extensionVersion = ''
  // 扩展的协议版本和 Diffra 的不一致：能连上，但不用它，界面提示更新
  outdated = false
  // 这个浏览器的窗口最近一次切到前台的时间；有多个连着时用最近的
  lastFocus = Date.now()
  private nextCallId = 1
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
  closed = false

  constructor(private readonly socket: Socket) {}

  send(message: DiffraMessage): void {
    if (!this.closed) this.socket.write(`${JSON.stringify(message)}\n`)
  }

  call<T>(call: BridgeCall, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
    if (this.closed) return Promise.reject(new Error('浏览器扩展已经断开了'))
    const id = this.nextCallId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`浏览器扩展 ${timeoutMs / 1000} 秒没有回应（${call.method}）`))
      }, timeoutMs)
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      this.send({ type: 'call', id, ...call })
    })
  }

  reply(message: Extract<ExtensionMessage, { type: 'reply' }>): void {
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error !== undefined) pending.reject(new Error(message.error))
    else pending.resolve(message.result)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('浏览器扩展已经断开了'))
    }
    this.pending.clear()
    this.socket.destroy()
  }
}

export interface BridgeListener {
  // 连接变了（连上、断开、打过招呼）
  connections(): void
  message(connection: BridgeConnection, message: ExtensionMessage): void
  closed(connection: BridgeConnection): void
}

// 命名管道服务：只接受报对令牌的宿主，打过招呼的才算连上
export class BridgeServer {
  private server: Server | null = null
  private readonly live = new Set<BridgeConnection>()
  private tasks: BridgeTask[] = []

  constructor(private readonly listener: BridgeListener) {}

  start(endpoint: BridgeEndpoint): void {
    this.server = createServer((socket) => this.accept(socket, endpoint.token))
    this.server.on('error', (error) => console.error('[browser-bridge] 管道服务出错', error))
    this.server.listen(endpoint.pipe)
  }

  stop(): void {
    for (const connection of this.live) connection.close()
    this.server?.close()
  }

  connections(): BridgeConnection[] {
    return [...this.live].filter((connection) => !connection.closed && connection.extensionVersion !== '')
  }

  // 扩展弹窗里「交给 Diffra」能选的任务
  setTasks(tasks: BridgeTask[]): void {
    this.tasks = tasks
    for (const connection of this.connections()) connection.send({ type: 'tasks', tasks })
  }

  private accept(socket: Socket, token: string): void {
    const connection = new BridgeConnection(socket)
    let authed = false
    let rest = ''
    const authTimer = setTimeout(() => socket.destroy(), AUTH_TIMEOUT_MS)
    socket.setEncoding('utf8')
    socket.on('data', (data: string) => {
      rest += data
      if (rest.length > MAX_LINE_CHARS) return socket.destroy()
      let index
      while ((index = rest.indexOf('\n')) >= 0) {
        const line = rest.slice(0, index)
        rest = rest.slice(index + 1)
        let message: ExtensionMessage
        try {
          message = JSON.parse(line) as ExtensionMessage
        } catch {
          continue
        }
        if (!authed) {
          if (message.type !== 'host' || message.token !== token) return socket.destroy()
          authed = true
          clearTimeout(authTimer)
          this.live.add(connection)
          continue
        }
        this.handle(connection, message)
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      clearTimeout(authTimer)
      connection.close()
      if (this.live.delete(connection)) {
        this.listener.closed(connection)
        this.listener.connections()
      }
    })
  }

  private handle(connection: BridgeConnection, message: ExtensionMessage): void {
    switch (message.type) {
      case 'hello':
        connection.browser = message.browser
        connection.extensionVersion = message.extensionVersion
        connection.outdated = message.protocol !== BRIDGE_PROTOCOL
        connection.lastFocus = Date.now()
        connection.send({ type: 'welcome', protocol: BRIDGE_PROTOCOL, diffraVersion: app.getVersion() })
        connection.send({ type: 'tasks', tasks: this.tasks })
        this.listener.connections()
        return
      case 'reply':
        return connection.reply(message)
      case 'focus':
        connection.lastFocus = Date.now()
        return
      default:
        this.listener.message(connection, message)
    }
  }
}
