import { connect, createServer, type Server, type TLSSocket } from 'node:tls'
import { decodeFrame, encodeFrame, FRAME, type FrameKind, MAX_FRAME_BYTES } from '@diffra/relay/protocol'
import { z } from 'zod'
import type { RemoteRelayStatus } from '../../shared/remote'
import { certificateFingerprint, isPrivateAddress, type LanCertificate } from './lan-tls.ts'
import type { RemoteTransport, TransportEvents } from './transport.ts'

// 局域网设备连接（v2 · M6）的传输：每台设备开一个 TLS 服务（自签证书，双方都出示证书），设备之间直连，不经任何服务器。
// - 只接受、只连私有地址（lan-tls.ts 的 isPrivateAddress）。
// - 连上后先报 hello（自己的设备 ID）：配过对的设备要出示配对时记下的那张证书（指纹对得上）才算连上；
//   没配过对的只能带着本机正开着的配对会合点连进来，只收配对的帧。
// - 帧和中转的一样（encodeFrame），外面套 4 字节长度和 1 字节类型；20 秒一次 ping，60 秒没动静就断开。
// - 自己连的设备（连接端）断了按 1 秒到 30 秒退避重连；发现服务又看到它时马上重连。
// 上面的 Noise 加密、配对、授权都不变。不引 Electron，scripts/lan.test.ts 在同一台机器上起两个实例测
const HELLO_TIMEOUT_MS = 10_000
const PING_MS = 20_000
const SILENCE_MS = 60_000
const CONNECT_TIMEOUT_MS = 10_000
const BACKOFF_MIN_MS = 1000
const BACKOFF_MAX_MS = 30_000
const MAX_CONNECTIONS = 32
const MAX_PER_ADDRESS = 4
const MAX_QUEUED_BYTES = 8 * 1024 * 1024
const MAX_ENVELOPE_BYTES = 1 + MAX_FRAME_BYTES

const ENVELOPE = { hello: 0, frame: 1, ping: 2, pong: 3, welcome: 4 } as const

const helloSchema = z.object({
  t: z.literal('hello'),
  v: z.literal(1),
  id: z.string().regex(/^[0-9a-f]{32}$/),
  rendezvous: z.string().regex(/^[0-9a-f]{32}$/).nullable(),
})

const welcomeSchema = z.object({ ok: z.boolean(), reason: z.string().max(200).nullable() })

// 连不上、被拒绝的原因，配对时原样给用户看
export class LanError extends Error {}

export interface LanTarget {
  deviceId: string
  address: string
  port: number
}

export interface LanTransportOptions {
  deviceId: string
  certificate: LanCertificate
  // 监听的地址和端口：平时 0.0.0.0 和随机端口（发现服务里报出去）；测试用 127.0.0.1
  bind: string
  port: number
  // 配过对的设备记下的证书指纹；没配过的是 null
  pinned(deviceId: string): string | null
  events: TransportEvents
}

class Connection {
  readonly socket: TLSSocket
  readonly inbound: boolean
  readonly address: string
  readonly tls: string
  deviceId: string | null = null
  // 配对用的连接：带着哪个会合点
  rendezvous: string | null = null
  ready = false
  lastHeard = Date.now()
  private buffer = Buffer.alloc(0)

  constructor(socket: TLSSocket, inbound: boolean, tls: string) {
    this.socket = socket
    this.inbound = inbound
    this.address = socket.remoteAddress ?? ''
    this.tls = tls
  }

  write(type: number, body: Uint8Array): boolean {
    if (this.socket.destroyed || this.socket.writableLength > MAX_QUEUED_BYTES) return false
    const header = Buffer.alloc(5)
    header.writeUInt32BE(body.length + 1, 0)
    header[4] = type
    this.socket.write(Buffer.concat([header, body]))
    return true
  }

  writeJson(type: number, value: unknown): boolean {
    return this.write(type, Buffer.from(JSON.stringify(value), 'utf8'))
  }

  // 收到的字节拼成一条条信封；格式不对返回 null（调用方断开）
  take(chunk: Buffer): Array<{ type: number; body: Buffer }> | null {
    this.lastHeard = Date.now()
    this.buffer = Buffer.concat([this.buffer, chunk])
    const envelopes: Array<{ type: number; body: Buffer }> = []
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32BE(0)
      if (size < 1 || size > MAX_ENVELOPE_BYTES) return null
      if (this.buffer.length < 4 + size) break
      envelopes.push({ type: this.buffer[4]!, body: this.buffer.subarray(5, 4 + size) })
      this.buffer = this.buffer.subarray(4 + size)
    }
    return envelopes
  }
}

const peerFingerprint = (socket: TLSSocket): string | null => {
  const raw = socket.getPeerCertificate(true)?.raw
  return raw && raw.length > 0 ? certificateFingerprint(raw) : null
}

export class LanTransport implements RemoteTransport {
  private server: Server | null = null
  private status: RemoteRelayStatus = { state: 'off' }
  private boundPort = 0
  private readonly connections = new Set<Connection>()
  private allow = new Set<string>()
  private readonly rendezvous = new Map<string, number>()
  private targets = new Map<string, LanTarget>()
  private readonly retry = new Map<string, { attempts: number; timer: NodeJS.Timeout | null; connecting: boolean }>()
  private pingTimer: NodeJS.Timeout | null = null
  private readonly options: LanTransportOptions

  constructor(options: LanTransportOptions) {
    this.options = options
  }

  get state(): RemoteRelayStatus {
    return this.status
  }

  // 实际监听的端口（发现服务里报出去）
  get port(): number {
    return this.boundPort
  }

  private setStatus(status: RemoteRelayStatus): void {
    this.status = status
    this.options.events.status(status)
  }

  start(): void {
    if (this.server) return
    this.setStatus({ state: 'connecting' })
    const { certificate } = this.options
    const server = createServer({ key: certificate.key, cert: certificate.cert, requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.3' }, (socket) => this.accept(socket))
    this.server = server
    server.on('tlsClientError', () => {})
    server.on('error', (error) => {
      console.error('[lan] 设备连接的服务出错', error)
      this.setStatus({ state: 'error', message: `局域网服务开不起来：${error.message}` })
    })
    server.listen(this.options.port, this.options.bind, () => {
      const address = server.address()
      this.boundPort = typeof address === 'object' && address ? address.port : 0
      this.setStatus({ state: 'online' })
      for (const target of this.targets.values()) this.dial(target.deviceId)
    })
    this.pingTimer = setInterval(() => this.heartbeat(), PING_MS)
    this.pingTimer.unref()
  }

  stop(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
    for (const state of this.retry.values()) if (state.timer) clearTimeout(state.timer)
    this.retry.clear()
    for (const connection of [...this.connections]) connection.socket.destroy()
    this.server?.close()
    this.server = null
    this.boundPort = 0
    if (this.status.state !== 'off') this.setStatus({ state: 'off' })
  }

  setAllow(peers: string[]): void {
    this.allow = new Set(peers)
    // 不在名单里了（撤销、删除）：断开
    for (const connection of [...this.connections]) {
      if (connection.ready && connection.deviceId && !connection.rendezvous && !this.allow.has(connection.deviceId)) connection.socket.destroy()
    }
  }

  // 本机去连的设备和它们现在的地址（发现服务给的，或者上次记下的）；新的、地址变了的马上连
  setTargets(targets: LanTarget[]): void {
    const next = new Map(targets.map((target) => [target.deviceId, target]))
    for (const id of this.targets.keys()) {
      if (next.has(id)) continue
      const state = this.retry.get(id)
      if (state?.timer) clearTimeout(state.timer)
      this.retry.delete(id)
    }
    const previous = this.targets
    this.targets = next
    for (const target of next.values()) {
      const old = previous.get(target.deviceId)
      if (!old || old.address !== target.address || old.port !== target.port) this.dial(target.deviceId, true)
    }
  }

  openRendezvous(id: string, expiresAt: number): void {
    this.rendezvous.set(id, expiresAt)
    this.options.events.rendezvous(id, true)
  }

  closeRendezvous(id: string): void {
    this.rendezvous.delete(id)
    for (const connection of [...this.connections]) if (connection.inbound && connection.rendezvous === id) connection.socket.destroy()
  }

  isOnline(deviceId: string): boolean {
    return [...this.connections].some((connection) => connection.ready && !connection.rendezvous && connection.deviceId === deviceId)
  }

  waitOnline(timeoutMs: number): Promise<void> {
    if (this.status.state === 'online') return Promise.resolve()
    return new Promise((resolve, reject) => {
      const started = Date.now()
      const check = setInterval(() => {
        if (this.status.state === 'online') {
          clearInterval(check)
          resolve()
        } else if (Date.now() - started > timeoutMs || this.status.state === 'error' || this.status.state === 'off') {
          clearInterval(check)
          reject(new LanError(this.status.state === 'error' ? this.status.message : '局域网服务没开起来'))
        }
      }, 50)
    })
  }

  // 配对时对方（或本机）出示的证书指纹，存进配对记录
  fingerprintOf(deviceId: string): string | null {
    return [...this.connections].find((connection) => connection.ready && connection.deviceId === deviceId)?.tls ?? null
  }

  send(kind: FrameKind, to: string, payload: Uint8Array): boolean {
    const frame = encodeFrame(kind, Buffer.from(to, 'hex'), payload)
    if (frame.length > MAX_FRAME_BYTES) return false
    // 会合点的帧走带着这个会合点连出去的配对连接；直发的帧走和那台设备的任何一条已连上的连接
    const connection =
      kind === FRAME.rendezvous
        ? [...this.connections].find((item) => item.ready && !item.inbound && item.rendezvous === to)
        : ([...this.connections].find((item) => item.ready && item.deviceId === to && !item.rendezvous) ?? [...this.connections].find((item) => item.ready && item.deviceId === to))
    return connection ? connection.write(ENVELOPE.frame, frame) : false
  }

  // 配完了（或者没配成）：关掉带着这个会合点连出去的配对连接
  closePairing(rendezvous: string): void {
    for (const connection of [...this.connections]) if (!connection.inbound && connection.rendezvous === rendezvous) connection.socket.destroy()
  }

  // 连接端配对：凭发现服务看到的地址和证书指纹连过去，带上会合点；对方拒绝时报原因
  async pair(target: LanTarget & { tls: string }, rendezvous: string): Promise<void> {
    if (!isPrivateAddress(target.address)) throw new LanError('只能连局域网里的设备')
    const connection = await this.open(target, target.tls, rendezvous)
    if (!connection) throw new LanError('连不上对方：对方的 Diffra 可能关了，或者不在同一个局域网')
  }

  private heartbeat(): void {
    for (const connection of [...this.connections]) {
      if (Date.now() - connection.lastHeard > SILENCE_MS) connection.socket.destroy()
      else connection.write(ENVELOPE.ping, Buffer.alloc(0))
    }
  }

  private accept(socket: TLSSocket): void {
    const address = socket.remoteAddress ?? ''
    const tls = peerFingerprint(socket)
    const fromAddress = [...this.connections].filter((connection) => connection.address === address).length
    if (!isPrivateAddress(address) || !tls || this.connections.size >= MAX_CONNECTIONS || fromAddress >= MAX_PER_ADDRESS) {
      socket.destroy()
      return
    }
    const connection = new Connection(socket, true, tls)
    this.track(connection)
    const timer = setTimeout(() => !connection.ready && socket.destroy(), HELLO_TIMEOUT_MS)
    socket.once('close', () => clearTimeout(timer))
  }

  private track(connection: Connection): void {
    const { socket } = connection
    this.connections.add(connection)
    socket.setKeepAlive(true, PING_MS)
    socket.on('data', (chunk: Buffer) => {
      const envelopes = connection.take(chunk)
      if (!envelopes) return void socket.destroy()
      for (const envelope of envelopes) this.handle(connection, envelope.type, envelope.body)
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      this.connections.delete(connection)
      const id = connection.deviceId
      if (connection.ready && id && !connection.rendezvous && !this.isOnline(id)) this.options.events.presence(id, false)
      if (connection.rendezvous && !connection.inbound) this.options.events.undeliverable(connection.rendezvous)
      if (id && this.targets.has(id) && !connection.rendezvous) this.dial(id)
    })
  }

  private handle(connection: Connection, type: number, body: Buffer): void {
    switch (type) {
      case ENVELOPE.ping:
        connection.write(ENVELOPE.pong, Buffer.alloc(0))
        return
      case ENVELOPE.pong:
        return
      case ENVELOPE.hello:
        if (connection.inbound && !connection.ready) this.hello(connection, body)
        return
      case ENVELOPE.welcome: {
        const waiter = this.welcomes.get(connection)
        this.welcomes.delete(connection)
        waiter?.(body)
        return
      }
      case ENVELOPE.frame: {
        if (!connection.ready || !connection.deviceId) return
        const frame = decodeFrame(body)
        if (!frame) return void connection.socket.destroy()
        // 配对连接：连进来的只能发这个会合点的帧；连出去的只收对方直发回来的
        if (connection.rendezvous) {
          if (connection.inbound ? frame.kind !== FRAME.rendezvous || frame.peer.toString('hex') !== connection.rendezvous : frame.kind !== FRAME.direct) return
        } else if (frame.kind !== FRAME.direct) return
        this.options.events.frame(frame.kind, connection.deviceId, frame.payload)
        return
      }
    }
  }

  private hello(connection: Connection, body: Buffer): void {
    let hello: z.infer<typeof helloSchema>
    try {
      hello = helloSchema.parse(JSON.parse(body.toString('utf8')))
    } catch {
      return void connection.socket.destroy()
    }
    const refuse = (reason: string) => {
      connection.writeJson(ENVELOPE.welcome, { ok: false, reason })
      connection.socket.end()
    }
    if (hello.id === this.options.deviceId) return refuse('这是本机自己')
    if (hello.rendezvous) {
      const expiresAt = this.rendezvous.get(hello.rendezvous)
      if (!expiresAt || Date.now() > expiresAt) return refuse('配对码不对，或者已经失效了')
      connection.deviceId = hello.id
      connection.rendezvous = hello.rendezvous
    } else {
      const pinned = this.options.pinned(hello.id)
      if (!this.allow.has(hello.id) || !pinned) return refuse('对方没有授权本机，或者还没配对')
      if (pinned !== connection.tls) return refuse('证书和配对时的对不上，可能被冒充，已拒绝')
      connection.deviceId = hello.id
    }
    connection.ready = true
    connection.writeJson(ENVELOPE.welcome, { ok: true, reason: null })
    if (!connection.rendezvous) this.options.events.presence(hello.id, true)
  }

  // 连出去：核对对方证书指纹，报 hello，等对方答应
  private open(target: LanTarget, expectedTls: string, rendezvous: string | null): Promise<Connection | null> {
    return new Promise((resolve, reject) => {
      if (!isPrivateAddress(target.address)) return resolve(null)
      const { certificate } = this.options
      let settled = false
      const finish = (value: Connection | null, error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve(value)
      }
      const socket = connect({ host: target.address, port: target.port, key: certificate.key, cert: certificate.cert, rejectUnauthorized: false, minVersion: 'TLSv1.3', checkServerIdentity: () => undefined })
      const timer = setTimeout(() => {
        socket.destroy()
        finish(null)
      }, CONNECT_TIMEOUT_MS)
      socket.on('error', () => finish(null))
      socket.once('secureConnect', () => {
        const tls = peerFingerprint(socket)
        if (tls !== expectedTls) {
          socket.destroy()
          return finish(null, new LanError('对方的证书和预期的对不上，可能被冒充，已中止'))
        }
        const connection = new Connection(socket, false, tls)
        connection.deviceId = target.deviceId
        connection.rendezvous = rendezvous
        // 第一条信封是对方的答复：答应了才算连上
        this.welcomes.set(connection, (body) => {
          let welcome: z.infer<typeof welcomeSchema>
          try {
            welcome = welcomeSchema.parse(JSON.parse(body.toString('utf8')))
          } catch {
            socket.destroy()
            return finish(null)
          }
          if (!welcome.ok) {
            socket.destroy()
            return finish(null, new LanError(welcome.reason ?? '对方拒绝了连接'))
          }
          connection.ready = true
          if (!rendezvous) this.options.events.presence(target.deviceId, true)
          finish(connection)
        })
        socket.once('close', () => {
          this.welcomes.delete(connection)
          finish(null)
        })
        this.track(connection)
        connection.writeJson(ENVELOPE.hello, { t: 'hello', v: 1, id: this.options.deviceId, rendezvous })
      })
    })
  }

  // 连出去、还没收到答复的连接
  private readonly welcomes = new Map<Connection, (body: Buffer) => void>()

  // 自己连的设备：没连上就连，失败退避重试
  private dial(deviceId: string, now = false): void {
    if (!this.server || this.status.state !== 'online') return
    const target = this.targets.get(deviceId)
    if (!target || this.isOnline(deviceId)) return
    const state = this.retry.get(deviceId) ?? { attempts: 0, timer: null, connecting: false }
    this.retry.set(deviceId, state)
    if (state.connecting) return
    if (state.timer) {
      if (!now) return
      clearTimeout(state.timer)
      state.timer = null
    }
    const delay = now ? 0 : Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** state.attempts) * (0.8 + Math.random() * 0.4)
    state.timer = setTimeout(() => {
      state.timer = null
      const current = this.targets.get(deviceId)
      const pinned = this.options.pinned(deviceId)
      if (!current || !pinned || this.isOnline(deviceId)) return
      state.connecting = true
      this.open(current, pinned, null).then(
        (connection) => {
          state.connecting = false
          if (connection) state.attempts = 0
          else {
            state.attempts++
            this.dial(deviceId)
          }
        },
        (error: unknown) => {
          state.connecting = false
          state.attempts++
          console.warn(`[lan] 连 ${deviceId.slice(0, 8)} 失败`, error instanceof Error ? error.message : error)
          this.dial(deviceId)
        },
      )
    }, delay)
    state.timer.unref()
  }
}
