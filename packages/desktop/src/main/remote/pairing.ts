import { deviceIdOf, FRAME } from '@diffra/relay/protocol'
import { createInvite, decodeInvite, encodeInvite, Handshake, pairingPskOf, rendezvousIdOf } from '@diffra/remote'
import { eventSchema, type Hello, helloSchema, REMOTE_PROLOGUE } from '@diffra/remote/messages'
import { DIRECT, SecureChannel, withKind } from './channel'
import type { DeviceIdentity } from './identity'
import type { RelayClient } from './relay-client'

// 配对（docs/decisions.md「设备连接」）：被连接端生成邀请串、在中转上开会合点；连接端粘贴邀请串，经会合点用 Noise XXpsk3 握手。
// 握手后两边各发一条 hello（名称和 Ed25519 公钥），用「Ed25519 公钥 + 握手里的 X25519 长期公钥」算出设备 ID 核对：
// 连接端核对邀请串里的被连接端设备 ID（服务器换不了钥匙），被连接端核对中转报来的发件设备 ID。之后交给被连接端的人点允许或拒绝

const HANDSHAKE_TIMEOUT_MS = 20_000
// 一个邀请串上同时握手的设备数、握手失败几次作废（中转那边也限每个会合点 3 台设备）
const MAX_GUESTS = 3
const MAX_FAILURES = 3

export interface PairedDevice {
  deviceId: string
  name: string
  signingKey: string
  noiseKey: string
}

export function helloOf(identity: DeviceIdentity, name: string, appVersion: string): Hello {
  return { type: 'hello', protocol: 1, appVersion: appVersion.slice(0, 40), name, signingKey: identity.signingKey.toString('base64') }
}

// 对方报的 Ed25519 公钥和握手里证明过的 X25519 长期公钥，算出来的设备 ID 要和预期的一致
function verifyHello(raw: unknown, remoteStatic: Uint8Array | null, expected: string): PairedDevice {
  const hello = helloSchema.parse(raw)
  if (!remoteStatic) throw new Error('握手没拿到对方的长期公钥')
  const signingKey = Buffer.from(hello.signingKey, 'base64')
  if (deviceIdOf(signingKey, remoteStatic).toString('hex') !== expected) throw new Error('对方的密钥和设备 ID 对不上，可能被冒充，已中止配对')
  return { deviceId: expected, name: hello.name, signingKey: hello.signingKey, noiseKey: Buffer.from(remoteStatic).toString('base64') }
}

interface Guest {
  handshake: Handshake
  channel: SecureChannel | null
  device: PairedDevice | null
}

export interface PairingHostDeps {
  identity: DeviceIdentity
  relay: RelayClient
  hello(): Hello
  ttlMs: number
  // 邀请串、待确认的请求变了
  changed(): void
}

// 被连接端：一个邀请串、在它上面连进来的设备、等本机的人确认的请求
export class PairingHost {
  private invite: { text: string; psk: Uint8Array; rendezvous: string; expiresAt: number; failures: number; used: boolean; timer: NodeJS.Timeout } | null = null
  private readonly guests = new Map<string, Guest>()

  constructor(private readonly deps: PairingHostDeps) {}

  get current(): { text: string; expiresAt: string } | null {
    return this.invite ? { text: this.invite.text, expiresAt: new Date(this.invite.expiresAt).toISOString() } : null
  }

  // 握手和 hello 都对上、等本机确认的设备
  get requests(): PairedDevice[] {
    return [...this.guests.values()].flatMap((guest) => (guest.device ? [guest.device] : []))
  }

  get rendezvous(): string | null {
    return this.invite?.rendezvous ?? null
  }

  create(): void {
    this.cancel()
    const invite = createInvite(Buffer.from(this.deps.identity.deviceId, 'hex'))
    const expiresAt = Date.now() + this.deps.ttlMs
    const rendezvous = Buffer.from(rendezvousIdOf(invite.secret)).toString('hex')
    this.invite = { text: encodeInvite(invite), psk: pairingPskOf(invite.secret), rendezvous, expiresAt, failures: 0, used: false, timer: setTimeout(() => this.cancel(), this.deps.ttlMs) }
    this.deps.relay.openRendezvous(rendezvous, expiresAt)
    this.deps.changed()
  }

  // 作废邀请串：会合点关掉，没确认的请求一起作废
  cancel(): void {
    const invite = this.invite
    if (!invite) return
    clearTimeout(invite.timer)
    this.deps.relay.closeRendezvous(invite.rendezvous)
    this.invite = null
    this.guests.clear()
    this.deps.changed()
  }

  // 本机的人点了允许或拒绝：告诉对方，邀请串用完作废
  respond(deviceId: string, approved: boolean): PairedDevice | null {
    const guest = this.guests.get(deviceId)
    if (!guest?.device || !guest.channel) return null
    guest.channel.send({ type: 'event', event: 'pair.result', approved })
    const device = guest.device
    this.cancel()
    return device
  }

  // 会合点上来的帧（from 是中转报的发件设备）
  receive(from: string, payload: Buffer): void {
    const invite = this.invite
    if (!invite || Date.now() > invite.expiresAt) return
    const guest = this.guests.get(from)
    try {
      if (!guest) {
        // 邀请串只能用一次：已经有设备握手成功，别人再来不理
        if (invite.used || this.guests.size >= MAX_GUESTS) return
        const handshake = new Handshake({ pattern: 'XXpsk3', initiator: false, prologue: REMOTE_PROLOGUE, staticKey: this.deps.identity.noise, psk: invite.psk })
        handshake.readMessage(payload)
        this.guests.set(from, { handshake, channel: null, device: null })
        // 连接端先把本机放进了它的白名单，可以直接回
        this.deps.relay.send(FRAME.direct, from, withKind(DIRECT.pairing, handshake.writeMessage()))
        return
      }
      if (!guest.channel) {
        // 第三条：预共享密钥对不上就在这里失败
        guest.handshake.readMessage(payload)
        guest.channel = new SecureChannel(guest.handshake.split(), (data) => this.deps.relay.send(FRAME.direct, from, withKind(DIRECT.pairing, data)))
        invite.used = true
        for (const other of [...this.guests.keys()]) if (other !== from) this.guests.delete(other)
        return
      }
      const message = guest.channel.receive(payload)
      if (message === undefined) return
      if (guest.device) {
        // 连接端放弃了：收起确认弹窗，邀请串已经用过，一起作废，免得本机的人之后点允许留下一条对方没存的授权
        if (eventSchema.safeParse(message).data?.event === 'pair.cancel') this.cancel()
        return
      }
      guest.device = verifyHello(message, guest.handshake.remoteStatic(), from)
      guest.channel.send(this.deps.hello())
      this.deps.changed()
    } catch (error) {
      console.error('[remote] 配对握手失败', error)
      this.guests.delete(from)
      invite.failures++
      if (invite.failures >= MAX_FAILURES) this.cancel()
      else this.deps.changed()
    }
  }
}

export interface PairWithInviteDeps {
  identity: DeviceIdentity
  relay: RelayClient
  hello(): Hello
  // 收被连接端直发过来的配对帧（已经去掉第一个字节）；null 是不收了
  listen(from: string, handler: ((payload: Buffer) => void) | null): void
  // 会合点送不到（过期、关了、满了）
  listenUndeliverable(id: string, handler: (() => void) | null): void
  // 连接端要先把被连接端放进自己的白名单，对方才能直接回
  allowHost(deviceId: string | null): void
  signal: AbortSignal
  // 等对方的人确认，最多等多久
  approvalTimeoutMs: number
}

// 连接端：凭邀请串和被连接端配对，对方点了允许才返回
export async function pairWithInvite(text: string, deps: PairWithInviteDeps): Promise<PairedDevice> {
  const invite = decodeInvite(text)
  const host = Buffer.from(invite.deviceId).toString('hex')
  if (host === deps.identity.deviceId) throw new Error('这是本机自己的邀请串，要在另一台电脑上粘贴')
  const rendezvous = Buffer.from(rendezvousIdOf(invite.secret)).toString('hex')
  const handshake = new Handshake({ pattern: 'XXpsk3', initiator: true, prologue: REMOTE_PROLOGUE, staticKey: deps.identity.noise, psk: pairingPskOf(invite.secret) })

  const inbox: Buffer[] = []
  let wake: (() => void) | null = null
  let failure: Error | null = null
  const fail = (error: Error) => {
    failure ??= error
    wake?.()
  }
  const next = async (timeoutMs: number, timeoutMessage: string): Promise<Buffer> => {
    const deadline = Date.now() + timeoutMs
    while (inbox.length === 0) {
      if (failure) throw failure
      if (deps.signal.aborted) throw new Error('已取消')
      const left = deadline - Date.now()
      if (left <= 0) throw new Error(timeoutMessage)
      await new Promise<void>((resolve) => {
        wake = resolve
        setTimeout(resolve, Math.min(left, 500))
      })
      wake = null
    }
    return inbox.shift()!
  }
  const send = (kind: typeof FRAME.direct | typeof FRAME.rendezvous, to: string, payload: Uint8Array) => {
    if (!deps.relay.send(kind, to, payload)) throw new Error('和中转服务断开了，稍后再试')
  }

  deps.allowHost(host)
  deps.listen(host, (payload) => {
    inbox.push(payload)
    wake?.()
  })
  deps.listenUndeliverable(rendezvous, () => fail(new Error('邀请串已经失效：过期了、被用过了，或者对方作废了。请对方重新生成一个')))
  let paired = false
  let channel: SecureChannel | null = null
  try {
    send(FRAME.rendezvous, rendezvous, handshake.writeMessage())
    handshake.readMessage(await next(HANDSHAKE_TIMEOUT_MS, '对方没有回应：邀请串可能已经失效，或者对方的 Diffra 没开、没打开「允许连接本机」'))
    send(FRAME.rendezvous, rendezvous, handshake.writeMessage())
    const opened = new SecureChannel(handshake.split(), (data) => deps.relay.send(FRAME.rendezvous, rendezvous, data))
    channel = opened
    if (!opened.send(deps.hello())) throw new Error('和中转服务断开了，稍后再试')

    const read = async (timeoutMs: number, timeoutMessage: string): Promise<unknown> => {
      for (;;) {
        const message = opened.receive(await next(timeoutMs, timeoutMessage))
        if (message !== undefined) return message
      }
    }
    // 预共享密钥不对时对方不回 hello，这里超时
    const device = verifyHello(await read(HANDSHAKE_TIMEOUT_MS, '对方没有回应：邀请串可能抄错了或已经被别人用过'), handshake.remoteStatic(), host)
    const result = eventSchema.parse(await read(deps.approvalTimeoutMs, '对方一直没有确认，邀请串已经过期'))
    if (result.event !== 'pair.result') throw new Error('对方发来的消息不对，已中止配对')
    if (!result.approved) throw new Error('对方拒绝了这次配对')
    paired = true
    return device
  } finally {
    // 握手完了却没配成（取消、等太久、出错）：告诉对方，免得对方之后点允许留下一条本机没存的授权。尽力发，发不出去也不管
    if (!paired) channel?.send({ type: 'event', event: 'pair.cancel' })
    deps.listen(host, null)
    deps.listenUndeliverable(rendezvous, null)
    if (!paired) deps.allowHost(null)
  }
}
