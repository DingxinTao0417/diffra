import { sign } from 'node:crypto'
import { authPayload, CLOSE, encodeFrame, decodeFrame, type FrameKind, RELAY_PROTOCOL, type ServerMessage, serverMessageSchema } from '@diffra/relay/protocol'
import type { RemoteRelayStatus } from '../../shared/remote'
import type { DeviceIdentity } from './identity'

// 主进程连中转的那条 WebSocket（Node 自带的客户端）：登录、白名单、在线状态、会合点、收发帧。
// 断了按 1 秒到 60 秒指数退避加抖动重连，重连后重新登记白名单和还没过期的会合点；中转说签名不对、版本不对就不再重试

const PING_MS = 25_000
// 这么久没收到中转的任何消息就当连接死了
const SILENCE_MS = 60_000
const BACKOFF_MIN_MS = 1000
const BACKOFF_MAX_MS = 60_000
const LOGIN_TIMEOUT_MS = 15_000
// 发出去的节奏：一台设备所有的出站流量走这一条连接，中转限每秒 50 帧、256 KB（突发 2 MB），超了直接断开。
// 这里排队按每秒 40 帧、200 KB（突发 80 帧、1.5 MB）匀速发；积压超过 8 MB 就不收了，调用方自己降级（比如断开同步、让对方重新取）
const FRAMES_PER_SECOND = 40
const FRAME_BURST = 80
const BYTES_PER_SECOND = 200 * 1024
const BYTE_BURST = 1536 * 1024
const MAX_QUEUED_BYTES = 8 * 1024 * 1024

class Bucket {
  private tokens: number
  private last = performance.now()

  constructor(
    private readonly rate: number,
    private readonly burst: number,
  ) {
    this.tokens = burst
  }

  // 还要等多少毫秒才够 amount（够了是 0）
  wait(amount: number): number {
    const now = performance.now()
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate)
    this.last = now
    return this.tokens >= amount ? 0 : Math.ceil(((amount - this.tokens) / this.rate) * 1000)
  }

  take(amount: number): void {
    this.tokens -= amount
  }
}

export interface RelayEvents {
  status(status: RemoteRelayStatus): void
  presence(deviceId: string, online: boolean): void
  frame(kind: FrameKind, from: string, payload: Buffer): void
  undeliverable(to: string): void
  rendezvous(id: string, opened: boolean): void
}

export class RelayClient {
  private socket: WebSocket | null = null
  private running = false
  private ready = false
  private attempts = 0
  private retryTimer: NodeJS.Timeout | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private loginTimer: NodeJS.Timeout | null = null
  private lastHeard = 0
  private allow: string[] = []
  private readonly rendezvous = new Map<string, number>()
  private readonly online = new Set<string>()
  private status: RemoteRelayStatus = { state: 'off' }
  private outbox: Buffer[] = []
  private outboxBytes = 0
  private pumpTimer: NodeJS.Timeout | null = null
  private readonly frames = new Bucket(FRAMES_PER_SECOND, FRAME_BURST)
  private readonly bytes = new Bucket(BYTES_PER_SECOND, BYTE_BURST)

  constructor(
    private readonly url: string,
    private readonly identity: DeviceIdentity,
    private readonly events: RelayEvents,
  ) {}

  get state(): RemoteRelayStatus {
    return this.status
  }

  isOnline(deviceId: string): boolean {
    return this.online.has(deviceId)
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.attempts = 0
    this.connect()
  }

  stop(): void {
    this.running = false
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.drop()
    this.setStatus({ state: 'off' })
  }

  // 整份替换：会和哪些设备互通
  setAllow(peers: string[]): void {
    this.allow = [...new Set(peers)]
    if (this.ready) this.control({ type: 'allow', peers: this.allow })
  }

  openRendezvous(id: string, expiresAt: number): void {
    this.rendezvous.set(id, expiresAt)
    if (this.ready) this.sendRendezvous(id, expiresAt)
  }

  closeRendezvous(id: string): void {
    if (this.rendezvous.delete(id) && this.ready) this.control({ type: 'rendezvous-close', id })
  }

  // 没连上或者积压太多时发不出去，返回 false。按顺序排队匀速发
  send(kind: FrameKind, to: string, payload: Uint8Array): boolean {
    if (!this.ready || !this.socket) return false
    const frame = encodeFrame(kind, Buffer.from(to, 'hex'), payload)
    if (this.outboxBytes + frame.length > MAX_QUEUED_BYTES) return false
    this.outbox.push(frame)
    this.outboxBytes += frame.length
    this.pump()
    return true
  }

  private pump(): void {
    if (this.pumpTimer) return
    while (this.outbox.length > 0 && this.socket?.readyState === WebSocket.OPEN) {
      const frame = this.outbox[0]!
      const wait = Math.max(this.frames.wait(1), this.bytes.wait(frame.length))
      if (wait > 0) {
        this.pumpTimer = setTimeout(() => {
          this.pumpTimer = null
          this.pump()
        }, wait)
        return
      }
      this.frames.take(1)
      this.bytes.take(frame.length)
      this.outbox.shift()
      this.outboxBytes -= frame.length
      this.socket.send(frame)
    }
  }

  // 等连上（已经连上直接返回）；超时或停了就报错
  waitOnline(timeoutMs: number): Promise<void> {
    if (this.ready) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const started = Date.now()
      const check = setInterval(() => {
        if (this.ready) {
          clearInterval(check)
          resolve()
        } else if (!this.running || Date.now() - started > timeoutMs) {
          clearInterval(check)
          reject(new Error(this.status.state === 'error' ? this.status.message : '连不上中转服务，检查一下网络'))
        }
      }, 100)
    })
  }

  private connect(): void {
    this.setStatus({ state: 'connecting' })
    let socket: WebSocket
    try {
      socket = new WebSocket(this.url)
    } catch (error) {
      console.error('[remote] 中转地址不对', error)
      return this.fail(`中转地址不对：${this.url}`)
    }
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    this.lastHeard = Date.now()
    this.loginTimer = setTimeout(() => socket.close(), LOGIN_TIMEOUT_MS)
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return
      this.lastHeard = Date.now()
      if (typeof event.data === 'string') return this.onControl(socket, event.data)
      const frame = decodeFrame(new Uint8Array(event.data as ArrayBuffer))
      if (frame) this.events.frame(frame.kind, frame.peer.toString('hex'), frame.payload)
    })
    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return
      this.drop()
      if (!this.running) return
      if (event.code === CLOSE.authFailed.code || event.code === CLOSE.version.code) return this.fail(event.reason || '中转服务拒绝了本机')
      this.scheduleRetry()
    })
    // 出错之后总会有 close，重连在那里做
    socket.addEventListener('error', () => {})
  }

  private onControl(socket: WebSocket, text: string): void {
    let message: ServerMessage
    try {
      message = serverMessageSchema.parse(JSON.parse(text))
    } catch (error) {
      console.error('[remote] 中转发来的消息格式不对', error)
      socket.close()
      return
    }
    switch (message.type) {
      case 'challenge':
        if (message.protocol !== RELAY_PROTOCOL) return this.fail('中转服务的协议版本和本机对不上，请更新 Diffra')
        this.control({
          type: 'auth',
          protocol: RELAY_PROTOCOL,
          signingKey: this.identity.signingKey.toString('base64'),
          noiseKey: Buffer.from(this.identity.noise.publicKey).toString('base64'),
          signature: sign(null, authPayload(Buffer.from(message.nonce, 'base64')), this.identity.signingPrivate).toString('base64'),
        })
        return
      case 'ready':
        if (this.loginTimer) clearTimeout(this.loginTimer)
        this.ready = true
        this.attempts = 0
        this.control({ type: 'allow', peers: this.allow })
        for (const [id, expiresAt] of this.rendezvous) this.sendRendezvous(id, expiresAt)
        this.pingTimer = setInterval(() => this.heartbeat(), PING_MS)
        this.setStatus({ state: 'online' })
        return
      case 'presence':
        if (message.online) this.online.add(message.deviceId)
        else this.online.delete(message.deviceId)
        this.events.presence(message.deviceId, message.online)
        return
      case 'undeliverable':
        this.events.undeliverable(message.to)
        return
      case 'rendezvous-opened':
      case 'rendezvous-refused':
        this.events.rendezvous(message.id, message.type === 'rendezvous-opened')
        return
      case 'pong':
        return
    }
  }

  private sendRendezvous(id: string, expiresAt: number): void {
    const ttlSeconds = Math.floor((expiresAt - Date.now()) / 1000)
    if (ttlSeconds < 1) {
      this.rendezvous.delete(id)
      return
    }
    this.control({ type: 'rendezvous-open', id, ttlSeconds: Math.min(ttlSeconds, 600) })
  }

  private heartbeat(): void {
    if (Date.now() - this.lastHeard > SILENCE_MS) {
      this.socket?.close()
      return
    }
    this.control({ type: 'ping' })
  }

  // 控制消息很少、很小，不排队（登录、白名单要先于排着的帧到）；也算进节奏里
  private control(message: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    const text = JSON.stringify(message)
    this.frames.take(1)
    this.bytes.take(text.length)
    this.socket.send(text)
  }

  // 收掉当前连接：大家都算下线
  private drop(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.loginTimer) clearTimeout(this.loginTimer)
    this.pingTimer = null
    this.loginTimer = null
    const socket = this.socket
    this.socket = null
    this.ready = false
    // 排着没发的帧属于旧连接上的加密通道，重连后通道要重建，一起丢掉
    if (this.pumpTimer) clearTimeout(this.pumpTimer)
    this.pumpTimer = null
    this.outbox = []
    this.outboxBytes = 0
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close()
    const offline = [...this.online]
    this.online.clear()
    for (const deviceId of offline) this.events.presence(deviceId, false)
  }

  private scheduleRetry(): void {
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempts)
    this.attempts++
    const delay = Math.round(base * (0.5 + Math.random()))
    this.setStatus({ state: 'connecting' })
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.running) this.connect()
    }, delay)
  }

  private fail(message: string): void {
    this.running = false
    this.drop()
    this.setStatus({ state: 'error', message })
  }

  private setStatus(status: RemoteRelayStatus): void {
    if (JSON.stringify(status) === JSON.stringify(this.status)) return
    this.status = status
    this.events.status(status)
  }
}
