import { FRAME } from '@diffra/relay/protocol'
import { Handshake } from '@diffra/remote'
import { REMOTE_PROLOGUE } from '@diffra/remote/messages'
import { DIRECT, SecureChannel, withKind } from './channel'
import type { DeviceIdentity } from './identity'
import type { RelayClient } from './relay-client'

// 配对之后的会话通道：两边都知道对方的长期公钥，用 Noise KK 握手，每次连接一把新的临时密钥。
// 连接端（看对方的一方）发起；被连接端只认还被授权的设备，公钥对不上握手就失败。断线、出错都整条丢掉，连接端下次要用时重新握手

const OPEN_TIMEOUT_MS = 10_000

// host：对方看本机（本机是被连接端）；guest：本机看对方
export type LinkRole = 'host' | 'guest'

export interface LinksDeps {
  identity: DeviceIdentity
  relay: RelayClient
  // 本机是被连接端：这台设备现在还能看本机吗（总开关开着、在授权列表里），能的话给它配对时的长期公钥
  guestKey(deviceId: string): Buffer | null
  // 本机是连接端：自己连接的这台设备的长期公钥
  hostKey(deviceId: string): Buffer | null
  opened(deviceId: string, role: LinkRole): void
  message(deviceId: string, role: LinkRole, message: unknown): void
  closed(deviceId: string, role: LinkRole): void
}

export class Links {
  private readonly channels: Record<LinkRole, Map<string, SecureChannel>> = { host: new Map(), guest: new Map() }
  private readonly opening = new Map<string, { handshake: Handshake; timer: NodeJS.Timeout; waiters: Array<(ok: boolean) => void> }>()

  constructor(private readonly deps: LinksDeps) {}

  has(deviceId: string, role: LinkRole): boolean {
    return this.channels[role].has(deviceId)
  }

  // 本机要看对方：建通道；已经有了直接用，正在建就一起等
  open(deviceId: string): Promise<boolean> {
    if (this.channels.guest.has(deviceId)) return Promise.resolve(true)
    const pending = this.opening.get(deviceId)
    if (pending) return new Promise((resolve) => pending.waiters.push(resolve))
    const key = this.deps.hostKey(deviceId)
    if (!key) return Promise.resolve(false)
    const handshake = new Handshake({ pattern: 'KK', initiator: true, prologue: REMOTE_PROLOGUE, staticKey: this.deps.identity.noise, remoteStatic: key })
    return new Promise((resolve) => {
      this.opening.set(deviceId, { handshake, waiters: [resolve], timer: setTimeout(() => this.settle(deviceId, false), OPEN_TIMEOUT_MS) })
      if (!this.deps.relay.send(FRAME.direct, deviceId, withKind(DIRECT.open, handshake.writeMessage()))) this.settle(deviceId, false)
    })
  }

  send(deviceId: string, role: LinkRole, message: unknown, options?: { compress?: boolean }): boolean {
    return this.channels[role].get(deviceId)?.send(message, options) ?? false
  }

  close(deviceId: string, role: LinkRole): void {
    if (role === 'guest') this.settle(deviceId, false)
    if (this.channels[role].delete(deviceId)) this.deps.closed(deviceId, role)
  }

  closeAll(): void {
    for (const deviceId of [...this.opening.keys()]) this.settle(deviceId, false)
    for (const role of ['host', 'guest'] as const) for (const deviceId of [...this.channels[role].keys()]) this.close(deviceId, role)
  }

  // 直发帧（第一个字节已经去掉）
  receive(from: string, kind: number, body: Buffer): void {
    try {
      switch (kind) {
        case DIRECT.open: {
          const key = this.deps.guestKey(from)
          if (!key) return
          const handshake = new Handshake({ pattern: 'KK', initiator: false, prologue: REMOTE_PROLOGUE, staticKey: this.deps.identity.noise, remoteStatic: key })
          handshake.readMessage(body)
          const reply = handshake.writeMessage()
          // 对方重连：旧通道作废
          this.close(from, 'host')
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
          this.settle(from, true)
          this.deps.opened(from, 'guest')
          return
        }
        case DIRECT.toHost:
        case DIRECT.toGuest: {
          const role: LinkRole = kind === DIRECT.toHost ? 'host' : 'guest'
          const message = this.channels[role].get(from)?.receive(body)
          if (message !== undefined) this.deps.message(from, role, message)
          return
        }
      }
    } catch (error) {
      console.error('[remote] 会话通道出错，丢掉重来', error)
      if (kind === DIRECT.accept) this.settle(from, false)
      else if (kind === DIRECT.open || kind === DIRECT.toHost) this.close(from, 'host')
      else if (kind === DIRECT.toGuest) this.close(from, 'guest')
    }
  }

  private settle(deviceId: string, ok: boolean): void {
    const pending = this.opening.get(deviceId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.opening.delete(deviceId)
    for (const waiter of pending.waiters) waiter(ok)
  }
}
