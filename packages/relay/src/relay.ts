import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type RawData, WebSocket, WebSocketServer } from 'ws'
import { CLOSE, type ClientMessage, clientMessageSchema, decodeFrame, deviceIdOf, encodeFrame, FRAME, MAX_CONTROL_CHARS, MAX_FRAME_BYTES, RELAY_PATH, RELAY_PROTOCOL, type ServerMessage, verifyAuth } from './protocol.ts'

// 中转服务：只在内存里记谁在线、白名单和会合点，不存盘、不记内容。重启后设备重连时重新登记。
// 上限和限速都在这里（服务器和更新源共用 30 Mbps，见 docs/decisions.md「设备连接」）；超了就断开，客户端退避重连、重新握手

export interface RelayLimits {
  authTimeoutMs: number
  // 同一个 IP 同时连着的（含还没登录的）、登录了的设备总数、还没登录的连接总数
  maxPerIp: number
  maxDevices: number
  maxPending: number
  // 每台设备：每秒帧数、每秒字节数（都按令牌桶，允许突发）
  framesPerSecond: number
  frameBurst: number
  bytesPerSecond: number
  byteBurst: number
  // 所有设备加起来
  globalBytesPerSecond: number
  globalByteBurst: number
  // 收件方还没发出去的数据超过这么多就断开它：丢帧会让加密通道对不上，不如让它重连
  maxBufferedBytes: number
  // 会合点：每个 IP 每小时能开几个、每台设备同时开几个、每个能有几台设备来、最多转几帧
  rendezvousPerIpPerHour: number
  rendezvousPerDevice: number
  rendezvousSenders: number
  rendezvousFrames: number
  heartbeatMs: number
}

export const DEFAULT_LIMITS: RelayLimits = {
  authTimeoutMs: 10_000,
  maxPerIp: 10,
  maxDevices: 500,
  maxPending: 200,
  framesPerSecond: 50,
  frameBurst: 100,
  bytesPerSecond: 256 * 1024,
  byteBurst: 2 * 1024 * 1024,
  globalBytesPerSecond: 1_250_000,
  globalByteBurst: 4 * 1024 * 1024,
  maxBufferedBytes: 4 * 1024 * 1024,
  rendezvousPerIpPerHour: 20,
  rendezvousPerDevice: 3,
  rendezvousSenders: 3,
  rendezvousFrames: 32,
  heartbeatMs: 25_000,
}

export interface RelayOptions {
  host: string
  port: number
  // 在 nginx 后面时为 true：只认从本机来的连接带的 X-Real-IP
  trustProxy: boolean
  // 健康检查返回的版本标识，发布脚本据此确认新版本已经在跑
  release: string
  limits?: Partial<RelayLimits>
  // 只记连接、断开（设备 ID 前 8 位和 IP）和错误，不记内容和大小
  log(line: string): void
}

export interface Relay {
  listen(): Promise<number>
  close(): Promise<void>
}

class Bucket {
  private tokens: number
  private last = performance.now()
  private readonly rate: number
  private readonly burst: number

  constructor(rate: number, burst: number) {
    this.rate = rate
    this.burst = burst
    this.tokens = burst
  }

  take(amount: number): boolean {
    const now = performance.now()
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate)
    this.last = now
    if (this.tokens < amount) return false
    this.tokens -= amount
    return true
  }
}

interface Connection {
  socket: WebSocket
  ip: string
  nonce: Buffer
  deviceId: string | null
  allow: Set<string>
  frames: Bucket
  bytes: Bucket
  alive: boolean
  authTimer: NodeJS.Timeout
}

interface Rendezvous {
  owner: string
  senders: Set<string>
  frames: number
  timer: NodeJS.Timeout
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const HOUR_MS = 3_600_000

export function createRelay(options: RelayOptions): Relay {
  const limits = { ...DEFAULT_LIMITS, ...options.limits }
  const devices = new Map<string, Connection>()
  const pending = new Set<Connection>()
  const perIp = new Map<string, number>()
  const rendezvous = new Map<string, Rendezvous>()
  const rendezvousOpens = new Map<string, number[]>()
  const global = new Bucket(limits.globalBytesPerSecond, limits.globalByteBurst)

  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ ok: true, release: options.release }))
      return
    }
    response.writeHead(404).end()
  })
  // 内容是密文，压缩没用，还多一条解压炸弹的路
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false })

  const send = (connection: Connection, message: ServerMessage) => {
    if (connection.socket.readyState === WebSocket.OPEN) connection.socket.send(JSON.stringify(message))
  }
  const shut = (connection: Connection, why: { code: number; reason: string }) => connection.socket.close(why.code, why.reason)
  const short = (id: string | null) => (id ? id.slice(0, 8) : '-')

  const clientIp = (request: IncomingMessage): string => {
    const remote = request.socket.remoteAddress ?? ''
    const forwarded = request.headers['x-real-ip']
    if (options.trustProxy && LOOPBACK.has(remote) && typeof forwarded === 'string' && forwarded.length <= 64) return forwarded
    return remote
  }

  server.on('upgrade', (request, socket, head) => {
    if (new URL(request.url ?? '/', 'http://relay').pathname !== RELAY_PATH) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => accept(ws, clientIp(request)))
  })

  const accept = (socket: WebSocket, ip: string) => {
    // 先完成升级再关：客户端能拿到关闭码，知道是连接太多
    if ((perIp.get(ip) ?? 0) >= limits.maxPerIp || pending.size >= limits.maxPending) {
      socket.close(CLOSE.full.code, CLOSE.full.reason)
      return
    }
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1)
    const connection: Connection = {
      socket,
      ip,
      nonce: randomBytes(32),
      deviceId: null,
      allow: new Set(),
      frames: new Bucket(limits.framesPerSecond, limits.frameBurst),
      bytes: new Bucket(limits.bytesPerSecond, limits.byteBurst),
      alive: true,
      authTimer: setTimeout(() => shut(connection, CLOSE.authTimeout), limits.authTimeoutMs),
    }
    pending.add(connection)
    send(connection, { type: 'challenge', protocol: RELAY_PROTOCOL, nonce: connection.nonce.toString('base64') })
    socket.on('message', (data, isBinary) => {
      try {
        receive(connection, toBuffer(data), isBinary)
      } catch (error) {
        options.log(`error ${short(connection.deviceId)} ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
        shut(connection, CLOSE.protocol)
      }
    })
    socket.on('pong', () => (connection.alive = true))
    socket.on('error', (error) => options.log(`socket-error ${short(connection.deviceId)} ${error.message}`))
    socket.on('close', (code) => drop(connection, code))
  }

  const receive = (connection: Connection, data: Buffer, isBinary: boolean) => {
    if (!connection.frames.take(1) || !connection.bytes.take(data.length)) return shut(connection, CLOSE.rateLimited)
    if (!isBinary) return control(connection, data)
    const sender = connection.deviceId
    if (!sender) return shut(connection, CLOSE.protocol)
    const frame = decodeFrame(data)
    if (!frame) return shut(connection, CLOSE.protocol)
    if (!global.take(data.length)) return shut(connection, CLOSE.rateLimited)
    const target = frame.peer.toString('hex')
    const from = Buffer.from(sender, 'hex')
    if (frame.kind === FRAME.direct) {
      const recipient = devices.get(target)
      if (!recipient || !recipient.allow.has(sender)) return send(connection, { type: 'undeliverable', to: target })
      return forward(connection, recipient, encodeFrame(FRAME.direct, from, frame.payload), target)
    }
    const meeting = rendezvous.get(target)
    const owner = meeting ? devices.get(meeting.owner) : undefined
    if (!meeting || !owner || meeting.frames >= limits.rendezvousFrames || (!meeting.senders.has(sender) && meeting.senders.size >= limits.rendezvousSenders)) {
      return send(connection, { type: 'undeliverable', to: target })
    }
    meeting.senders.add(sender)
    meeting.frames++
    forward(connection, owner, encodeFrame(FRAME.rendezvous, from, frame.payload), target)
  }

  const forward = (from: Connection, to: Connection, frame: Buffer, target: string) => {
    if (to.socket.bufferedAmount > limits.maxBufferedBytes) {
      shut(to, CLOSE.slow)
      return send(from, { type: 'undeliverable', to: target })
    }
    to.socket.send(frame)
  }

  const control = (connection: Connection, data: Buffer) => {
    const text = data.toString('utf8')
    if (text.length > MAX_CONTROL_CHARS) return shut(connection, CLOSE.protocol)
    let parsed: ClientMessage
    try {
      const result = clientMessageSchema.safeParse(JSON.parse(text))
      if (!result.success) return shut(connection, CLOSE.protocol)
      parsed = result.data
    } catch {
      return shut(connection, CLOSE.protocol)
    }
    const self = connection.deviceId
    if (!self) return parsed.type === 'auth' ? authenticate(connection, parsed) : shut(connection, CLOSE.protocol)
    switch (parsed.type) {
      case 'auth':
        return shut(connection, CLOSE.protocol)
      case 'allow':
        return updateAllow(connection, self, new Set(parsed.peers))
      case 'rendezvous-open':
        return openRendezvous(connection, self, parsed.id, parsed.ttlSeconds)
      case 'rendezvous-close': {
        if (rendezvous.get(parsed.id)?.owner === self) closeRendezvous(parsed.id)
        return
      }
      case 'ping':
        return send(connection, { type: 'pong' })
    }
  }

  const authenticate = (connection: Connection, message: Extract<ClientMessage, { type: 'auth' }>) => {
    if (message.protocol !== RELAY_PROTOCOL) return shut(connection, CLOSE.version)
    const signingKey = Buffer.from(message.signingKey, 'base64')
    if (!verifyAuth(signingKey, connection.nonce, Buffer.from(message.signature, 'base64'))) return shut(connection, CLOSE.authFailed)
    const deviceId = deviceIdOf(signingKey, Buffer.from(message.noiseKey, 'base64')).toString('hex')
    const previous = devices.get(deviceId)
    if (!previous && devices.size >= limits.maxDevices) return shut(connection, CLOSE.full)
    clearTimeout(connection.authTimer)
    pending.delete(connection)
    connection.deviceId = deviceId
    // 新连接接替旧的：旧连接关闭时不再算这台设备下线
    devices.set(deviceId, connection)
    if (previous) shut(previous, CLOSE.replaced)
    send(connection, { type: 'ready', deviceId })
    options.log(`connect ${short(deviceId)} ${connection.ip}`)
  }

  const mutual = (a: Connection, b: Connection) => a.deviceId !== null && b.deviceId !== null && a.allow.has(b.deviceId) && b.allow.has(a.deviceId)

  // 两边都在线、互相在白名单里才算互通；名单改了，互通状态变了的两边都告诉一声
  const updateAllow = (connection: Connection, self: string, next: Set<string>) => {
    const affected = [...new Set([...connection.allow, ...next])].flatMap((id) => {
      const other = devices.get(id)
      return other ? [{ id, other, was: mutual(connection, other) }] : []
    })
    connection.allow = next
    for (const { id, other, was } of affected) {
      const now = mutual(connection, other)
      if (now === was) continue
      send(connection, { type: 'presence', deviceId: id, online: now })
      send(other, { type: 'presence', deviceId: self, online: now })
    }
  }

  const openRendezvous = (connection: Connection, owner: string, id: string, ttlSeconds: number) => {
    const now = Date.now()
    const opens = (rendezvousOpens.get(connection.ip) ?? []).filter((at) => now - at < HOUR_MS)
    const owned = [...rendezvous.values()].filter((meeting) => meeting.owner === owner).length
    const existing = rendezvous.get(id)
    if ((existing && existing.owner !== owner) || (!existing && owned >= limits.rendezvousPerDevice) || opens.length >= limits.rendezvousPerIpPerHour) {
      return send(connection, { type: 'rendezvous-refused', id })
    }
    opens.push(now)
    rendezvousOpens.set(connection.ip, opens)
    if (existing) clearTimeout(existing.timer)
    rendezvous.set(id, { owner, senders: existing?.senders ?? new Set(), frames: existing?.frames ?? 0, timer: setTimeout(() => closeRendezvous(id), ttlSeconds * 1000) })
    send(connection, { type: 'rendezvous-opened', id })
  }

  const closeRendezvous = (id: string) => {
    const meeting = rendezvous.get(id)
    if (!meeting) return
    clearTimeout(meeting.timer)
    rendezvous.delete(id)
  }

  const drop = (connection: Connection, code: number) => {
    clearTimeout(connection.authTimer)
    pending.delete(connection)
    const left = (perIp.get(connection.ip) ?? 1) - 1
    if (left > 0) perIp.set(connection.ip, left)
    else perIp.delete(connection.ip)
    const id = connection.deviceId
    if (!id || devices.get(id) !== connection) return
    devices.delete(id)
    for (const peer of connection.allow) {
      const other = devices.get(peer)
      if (other?.allow.has(id)) send(other, { type: 'presence', deviceId: id, online: false })
    }
    for (const [key, meeting] of rendezvous) if (meeting.owner === id) closeRendezvous(key)
    options.log(`disconnect ${short(id)} ${code}`)
  }

  // 心跳：上一轮 ping 没回 pong 的直接断掉；顺带清掉一小时前的会合点计数
  const heartbeat = setInterval(() => {
    for (const connection of [...pending, ...devices.values()]) {
      if (!connection.alive) {
        connection.socket.terminate()
        continue
      }
      connection.alive = false
      connection.socket.ping()
    }
    const now = Date.now()
    for (const [ip, opens] of rendezvousOpens) if (opens.every((at) => now - at >= HOUR_MS)) rendezvousOpens.delete(ip)
  }, limits.heartbeatMs)
  heartbeat.unref()

  return {
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(options.port, options.host, () => resolve((server.address() as AddressInfo).port))
      }),
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat)
        for (const meeting of rendezvous.values()) clearTimeout(meeting.timer)
        for (const socket of wss.clients) socket.terminate()
        wss.close()
        server.close(() => resolve())
      }),
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}
