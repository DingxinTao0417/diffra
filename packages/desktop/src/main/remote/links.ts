import { FRAME } from '@diffra/relay/protocol'
import { Handshake } from '@diffra/remote'
import { REMOTE_PROLOGUE } from '@diffra/remote/messages'
import { logRemote } from '../app-log'
import { DIRECT, SecureChannel, withKind } from './channel'
import type { DeviceIdentity } from './identity'
import type { RemoteTransport } from './transport'

// 配对之后的会话通道：两边都知道对方的长期公钥，用 Noise KK 握手，每次连接一把新的临时密钥。
// 连接端（看对方的一方）发起；被连接端只认还被授权的设备，不认的明确回「拒绝」和原因（不沉默，否则连接端只能干等 10 秒，
// 互相配对时对方在中转上又显示在线，分不清怎么了）。被连接端关掉通道时（撤销、关总开关、出错）告诉连接端，免得它拿着失效的通道一直等。
// 拒绝和关闭的通知没有加密认证，中转能伪造，最多让连接端以为连不上，和中转丢帧一样，不扩大权限。断线、出错都整条丢掉，连接端下次要用时重新握手

const OPEN_TIMEOUT_MS = 10_000
const REFUSALS = { off: 1, 'not-granted': 2 } as const

// host：对方看本机（本机是被连接端）；guest：本机看对方
export type LinkRole = 'host' | 'guest'
export type Refusal = keyof typeof REFUSALS
// 建通道没成的原因：中转没连上或断了、中转送不到对方、对方 10 秒没回、握手失败、对方关了「允许连接本机」、对方没授权本机、本机没有对方的公钥
export type OpenFailure = 'relay' | 'offline' | 'timeout' | 'handshake' | Refusal | 'unknown-peer'
export type OpenResult = { ok: true } | { ok: false; reason: OpenFailure }

export interface LinksDeps {
  identity: DeviceIdentity
  relay: RemoteTransport
  // 本机是被连接端：这台设备现在还能看本机吗（总开关开着、在授权列表里），能的话给它配对时的长期公钥
  guestKey(deviceId: string): Buffer | null
  // 不能看本机时为什么
  refusal(deviceId: string): Refusal
  // 本机是连接端：自己连接的这台设备的长期公钥
  hostKey(deviceId: string): Buffer | null
  opened(deviceId: string, role: LinkRole): void
  message(deviceId: string, role: LinkRole, message: unknown): void
  closed(deviceId: string, role: LinkRole): void
}

const short = (deviceId: string) => deviceId.slice(0, 8)

export class Links {
  private readonly channels: Record<LinkRole, Map<string, SecureChannel>> = { host: new Map(), guest: new Map() }
  private readonly opening = new Map<string, { handshake: Handshake; timer: NodeJS.Timeout; waiters: Array<(result: OpenResult) => void> }>()

  constructor(private readonly deps: LinksDeps) {}

  has(deviceId: string, role: LinkRole): boolean {
    return this.channels[role].has(deviceId)
  }

  // 本机要看对方：建通道；已经有了直接用，正在建就一起等
  open(deviceId: string): Promise<OpenResult> {
    if (this.channels.guest.has(deviceId)) return Promise.resolve({ ok: true })
    const pending = this.opening.get(deviceId)
    if (pending) return new Promise((resolve) => pending.waiters.push(resolve))
    const key = this.deps.hostKey(deviceId)
    if (!key) return Promise.resolve({ ok: false, reason: 'unknown-peer' })
    const handshake = new Handshake({ pattern: 'KK', initiator: true, prologue: REMOTE_PROLOGUE, staticKey: this.deps.identity.noise, remoteStatic: key })
    return new Promise((resolve) => {
      this.opening.set(deviceId, { handshake, waiters: [resolve], timer: setTimeout(() => this.fail(deviceId, 'timeout'), OPEN_TIMEOUT_MS) })
      if (!this.deps.relay.send(FRAME.direct, deviceId, withKind(DIRECT.open, handshake.writeMessage()))) this.fail(deviceId, 'relay')
    })
  }

  // 发不出去（积压太多、断了）就丢掉这条通道：一条消息可能已经发出去一半，对方拼不回来
  send(deviceId: string, role: LinkRole, message: unknown, options?: { compress?: boolean }): boolean {
    const channel = this.channels[role].get(deviceId)
    if (!channel) return false
    if (channel.send(message, options)) return true
    logRemote(`发给 ${short(deviceId)} 的消息发不出去（积压太多或断了），丢掉通道`)
    this.close(deviceId, role)
    return false
  }

  // 被连接端关掉通道时告诉连接端（notify）；连接端关自己这头不用说
  close(deviceId: string, role: LinkRole, notify = true): void {
    if (role === 'guest') this.settle(deviceId, { ok: false, reason: 'relay' })
    if (!this.channels[role].delete(deviceId)) return
    if (role === 'host' && notify) this.deps.relay.send(FRAME.direct, deviceId, withKind(DIRECT.closed, Buffer.alloc(0)))
    this.deps.closed(deviceId, role)
  }

  // 中转说送不到对方（对方不在中转上，或者对方的白名单里没有本机）：正在建的通道马上失败，不干等
  undeliverable(deviceId: string): void {
    this.fail(deviceId, 'offline')
  }

  closeAll(): void {
    for (const deviceId of [...this.opening.keys()]) this.fail(deviceId, 'relay')
    for (const role of ['host', 'guest'] as const) for (const deviceId of [...this.channels[role].keys()]) this.close(deviceId, role, false)
  }

  // 直发帧（第一个字节已经去掉）
  receive(from: string, kind: number, body: Buffer): void {
    try {
      switch (kind) {
        case DIRECT.open: {
          const key = this.deps.guestKey(from)
          if (!key) {
            const refusal = this.deps.refusal(from)
            logRemote(`拒绝 ${short(from)} 建通道：${refusal === 'off' ? '没开「允许连接本机」' : '没有授权它'}`)
            this.deps.relay.send(FRAME.direct, from, withKind(DIRECT.deny, Buffer.from([REFUSALS[refusal]])))
            return
          }
          const handshake = new Handshake({ pattern: 'KK', initiator: false, prologue: REMOTE_PROLOGUE, staticKey: this.deps.identity.noise, remoteStatic: key })
          handshake.readMessage(body)
          const reply = handshake.writeMessage()
          // 对方重连：旧通道作废（对方正在重建，不用再通知）
          this.close(from, 'host', false)
          this.channels.host.set(from, new SecureChannel(handshake.split(), (data) => this.deps.relay.send(FRAME.direct, from, withKind(DIRECT.toGuest, data))))
          this.deps.relay.send(FRAME.direct, from, withKind(DIRECT.accept, reply))
          this.deps.opened(from, 'host')
          return
        }
        case DIRECT.accept: {
          const pending = this.opening.get(from)
          if (!pending) return
          pending.handshake.readMessage(body)
          this.channels.guest.set(from, new SecureChannel(pending.handshake.split(), (data) => this.deps.relay.send(FRAME.direct, from, withKind(DIRECT.toHost, data))))
          this.settle(from, { ok: true })
          this.deps.opened(from, 'guest')
          return
        }
        case DIRECT.deny: {
          const refusal = (Object.keys(REFUSALS) as Refusal[]).find((name) => REFUSALS[name] === body[0]) ?? 'not-granted'
          if (this.opening.has(from)) logRemote(`${short(from)} 拒绝了本机建通道：${refusal === 'off' ? '对方没开「允许连接本机」' : '对方没有授权本机'}`)
          this.fail(from, refusal)
          return
        }
        case DIRECT.closed:
          if (this.channels.guest.has(from)) logRemote(`${short(from)} 关掉了通道`)
          this.close(from, 'guest', false)
          return
        case DIRECT.toHost:
        case DIRECT.toGuest: {
          const role: LinkRole = kind === DIRECT.toHost ? 'host' : 'guest'
          const channel = this.channels[role].get(from)
          // 本机这头已经没有通道（撤销过、出过错）对方还在用：告诉它重建
          if (!channel) {
            if (role === 'host') this.deps.relay.send(FRAME.direct, from, withKind(DIRECT.closed, Buffer.alloc(0)))
            return
          }
          const message = channel.receive(body)
          if (message !== undefined) this.deps.message(from, role, message)
          return
        }
      }
    } catch (error) {
      logRemote(`和 ${short(from)} 的通道出错（帧种类 ${kind}），丢掉重来`, error)
      if (kind === DIRECT.accept) this.fail(from, 'handshake')
      else if (kind === DIRECT.open || kind === DIRECT.toHost) this.close(from, 'host')
      else if (kind === DIRECT.toGuest) this.close(from, 'guest')
    }
  }

  private fail(deviceId: string, reason: OpenFailure): void {
    if (this.opening.has(deviceId) && reason !== 'off' && reason !== 'not-granted') logRemote(`和 ${short(deviceId)} 建通道没成：${reason}`)
    this.settle(deviceId, { ok: false, reason })
  }

  private settle(deviceId: string, result: OpenResult): void {
    const pending = this.opening.get(deviceId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.opening.delete(deviceId)
    for (const waiter of pending.waiters) waiter(result)
  }
}
