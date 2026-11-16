import { join } from 'node:path'
import type { AskAnswer, PromptImage, RemoteSnapshot, StoredSessionSummary } from '@diffra/core/types'
import { FRAME } from '@diffra/relay/protocol'
import { encodeInvite, fingerprintOf, InviteError, rendezvousIdOf } from '@diffra/remote'
import type { RemoteResumed, RemoteSnapshotPage, RemoteToolOutput, RequestCall, SessionList } from '@diffra/remote/messages'
import { REMOTE_LEVEL_LABELS, type RemoteAction, type RemoteActionResult, type RemoteTaskCall, type RemoteAddResult, type RemoteAuditEntry, type RemoteDeviceView, type RemoteProjectGrant, type RemoteRelayStatus, type RemoteSyncEvent, type RemoteView } from '../../shared/remote'
import type { SessionEvent } from '../session-events'
import { logRemote } from '../app-log'
import { DIRECT } from './channel'
import { GuestSync } from './guest-sync'
import { HostSync } from './host-sync'
import { createIdentity, deleteIdentity, type DeviceIdentity, encryptionUnavailable, loadIdentity, loadOrCreateCertificate } from './identity'
import { LanDiscovery } from './lan-discovery'
import { type LanCertificate, shortFingerprint } from './lan-tls'
import { LanTransport } from './lan-transport'
import { Links } from './links'
import { helloOf, lanPairingSecret, PairingHost, pairWithInvite } from './pairing'
import { RelayClient } from './relay-client'
import { AuditLog, RemoteStateStore, type StoredDevice } from './state'
import type { RemoteTransport, TransportEvents } from './transport'

// 局域网版（v2）的监听和发现：平时监听 0.0.0.0 的随机端口、发现服务用固定端口发组播和广播；测试里换成 127.0.0.1 和指定的地址
export interface LanOptions {
  bind: string
  port: number
  discoveryPort: number
  discoveryTargets: Array<{ address: string; port: number }>
  broadcast: boolean
}

export interface RemoteServiceOptions {
  // 局域网直连（v2）还是经中转（已下线）
  transport: 'lan' | 'relay'
  lan: LanOptions
  relayUrl: string
  appVersion: string
  inviteTtlMs: number
  defaultName: string
  publish(view: RemoteView): void
  // 被连接端推来的动静，转给界面
  publishSync(event: RemoteSyncEvent): void
  listSessions(): Promise<StoredSessionSummary[]>
  snapshot(params: { sessionId: string; before?: number; maxTurns: number; maxChars: number }): Promise<RemoteSnapshot>
  // 授权的设备要做的操作，交给本机界面做
  act(action: RemoteAction): Promise<RemoteActionResult>
  // 授权的设备要读、做的任务相关的事，交给本机界面做
  ask(call: RemoteTaskCall): Promise<unknown>
  // 替本机的人回答权限请求（提问还带答案）；已经有人答过了返回 false
  answerPermission(requestId: string, optionId: string, answers?: unknown[]): boolean
  // 提问图片压缩成发给远程的小图，压不了的是 null
  compressImages(images: PromptImage[]): Promise<Array<PromptImage | null>>
  branches(cwd: string): Promise<{ current: string | null; branches: string[] }>
  switchBranch(cwd: string, branch: string): Promise<void>
}

// 设备连接的总管：本机身份、中转连接、配对、授权、操作记录。
// 要不要连中转：开着「允许连接本机」、有自己连接的设备、或者正在添加设备时才连；白名单是授权的设备（开着总开关时）加上自己连接的设备
export class RemoteService {
  private identity: DeviceIdentity | null = null
  private relay: RemoteTransport | null = null
  // 局域网版：和 relay 是同一个对象；证书和发现服务
  private lan: LanTransport | null = null
  private certificate: LanCertificate | null = null
  private discovery: LanDiscovery | null = null
  private host: PairingHost | null = null
  private links: Links | null = null
  private readonly hostSync: HostSync
  private readonly guestSync: GuestSync
  private adding: { controller: AbortController; host: string | null } | null = null
  // 局域网版：「添加设备」开着，要听发现消息（平时不监听，免得没用这个功能的人也被防火墙问）
  private browsing = false
  private readonly directListeners = new Map<string, (payload: Buffer) => void>()
  private readonly undeliverableListeners = new Map<string, () => void>()

  private constructor(
    private readonly dir: string,
    private readonly store: RemoteStateStore,
    private readonly audit: AuditLog,
    private unavailable: string | null,
    private readonly options: RemoteServiceOptions,
  ) {
    this.hostSync = new HostSync({
      grant: (deviceId) => {
        const state = this.store.get()
        return state.allowIncoming ? (state.grants.find((grant) => grant.deviceId === deviceId) ?? null) : null
      },
      send: (deviceId, message, sendOptions) => this.links?.send(deviceId, 'host', message, sendOptions) ?? false,
      drop: (deviceId) => this.links?.close(deviceId, 'host'),
      listSessions: () => options.listSessions(),
      snapshot: (params) => options.snapshot(params),
      act: (action) => options.act(action),
      ask: (call) => options.ask(call),
      answerPermission: (requestId, optionId, answers) => options.answerPermission(requestId, optionId, answers),
      audit: (deviceId, name, action) => void this.audit.append({ deviceId, name, action }),
      forget: (deviceId) => void this.revoke(deviceId, '对方删除了本机，撤销授权'),
      activityChanged: () => this.changed(),
      branches: (cwd) => options.branches(cwd),
      switchBranch: (cwd, branch) => options.switchBranch(cwd, branch),
      compressImages: (images) => options.compressImages(images),
    })
    this.guestSync = new GuestSync({
      // 通道表是收到第一个直发帧时才建的，本机先开口时要在这里建；还没连中转就不建（不在这里起连接）
      open: (deviceId) => (this.identity && this.relay ? this.linksFor(this.identity).open(deviceId) : Promise.resolve({ ok: false, reason: 'relay' })),
      send: (deviceId, message) => this.links?.send(deviceId, 'guest', message) ?? false,
      publish: (event) => options.publishSync(event),
    })
  }

  // 本机的会话有动静：推给看着的设备
  sessionEvent(event: SessionEvent): void {
    this.hostSync.sessionEvent(event)
  }

  // 连接端：看对方授权给本机的会话
  remoteList(deviceId: string): Promise<SessionList> {
    this.requirePeer(deviceId)
    return this.guestSync.list(deviceId)
  }

  remoteSubscribe(deviceId: string, sessionId: string, resume?: { epoch: string; seq: number }): Promise<RemoteSnapshotPage | RemoteResumed> {
    this.requirePeer(deviceId)
    return this.guestSync.subscribe(deviceId, sessionId, resume)
  }

  remotePage(deviceId: string, sessionId: string, before: number): Promise<RemoteSnapshotPage> {
    this.requirePeer(deviceId)
    return this.guestSync.page(deviceId, sessionId, before)
  }

  // 新加的请求都走这里
  remoteCall(deviceId: string, call: RequestCall): Promise<unknown> {
    this.requirePeer(deviceId)
    return this.guestSync.call(deviceId, call)
  }

  remoteToolOutput(deviceId: string, sessionId: string, turn: number, turnId: string, toolCallId: string): Promise<RemoteToolOutput> {
    this.requirePeer(deviceId)
    return this.guestSync.toolOutput(deviceId, sessionId, turn, turnId, toolCallId)
  }

  remoteUnsubscribe(deviceId: string, sessionId: string): Promise<void> {
    return this.guestSync.unsubscribe(deviceId, sessionId)
  }

  // 连接端：操作对方开放了「可查看和操作」的会话，授权由对方检查
  remotePrompt(deviceId: string, sessionId: string, text: string): Promise<{ queued: boolean }> {
    this.requirePeer(deviceId)
    return this.guestSync.prompt(deviceId, sessionId, text)
  }

  remoteCreate(deviceId: string, projectId: string, text: string): Promise<{ sessionId: string }> {
    this.requirePeer(deviceId)
    return this.guestSync.create(deviceId, projectId, text)
  }

  remoteCancel(deviceId: string, sessionId: string): Promise<void> {
    this.requirePeer(deviceId)
    return this.guestSync.cancel(deviceId, sessionId)
  }

  remoteRespondPermission(deviceId: string, requestId: string, optionId: string, answers?: AskAnswer[]): Promise<void> {
    this.requirePeer(deviceId)
    return this.guestSync.respondPermission(deviceId, requestId, optionId, answers)
  }

  private requirePeer(deviceId: string): void {
    if (!this.store.get().peers.some((peer) => peer.deviceId === deviceId)) throw new Error('本机没有添加这台设备')
  }

  static async open(userDataDir: string, options: RemoteServiceOptions): Promise<RemoteService> {
    const dir = join(userDataDir, 'remote')
    const store = await RemoteStateStore.open(dir, options.defaultName)
    let unavailable = store.loadError ?? (await encryptionUnavailable())
    let identity: DeviceIdentity | null = null
    if (!unavailable) {
      try {
        identity = await loadIdentity(dir)
      } catch (error) {
        logRemote('读设备身份失败', error)
        unavailable = `读不出本机的设备身份：${error instanceof Error ? error.message : String(error)}`
      }
    }
    const service = new RemoteService(dir, store, new AuditLog(dir), unavailable, options)
    service.identity = identity
    if (identity && options.transport === 'lan') {
      try {
        service.certificate = await loadOrCreateCertificate(dir, identity)
      } catch (error) {
        logRemote('读证书失败', error)
        service.unavailable = `读不出本机的证书：${error instanceof Error ? error.message : String(error)}`
      }
    }
    service.sync()
    return service
  }

  view(): RemoteView {
    const state = this.store.get()
    const online = (deviceId: string) => this.relay?.isOnline(deviceId) ?? false
    const device = (item: StoredDevice): RemoteDeviceView => ({ deviceId: item.deviceId, fingerprint: fingerprintOf(Buffer.from(item.deviceId, 'hex')), name: item.name, pairedAt: item.pairedAt, online: online(item.deviceId), lastSeenAt: item.lastSeenAt })
    return {
      unavailable: this.unavailable,
      self: this.identity ? { deviceId: this.identity.deviceId, fingerprint: this.identity.fingerprint } : null,
      name: state.name,
      allowIncoming: state.allowIncoming,
      relay: this.relay?.state ?? { state: 'off' },
      invite: this.host?.current ?? null,
      requests: (this.host?.requests ?? []).map((request) => ({
        deviceId: request.deviceId,
        fingerprint: fingerprintOf(Buffer.from(request.deviceId, 'hex')),
        name: request.name,
        previous: state.grants.find((grant) => grant.deviceId === request.deviceId)?.projects ?? null,
      })),
      grants: state.grants.map((grant) => ({ ...device(grant), projects: grant.projects, ...this.hostSync.activity(grant.deviceId) })),
      peers: state.peers.map(device),
      lan:
        this.options.transport === 'lan'
          ? {
              certificate: this.certificate ? shortFingerprint(this.certificate.fingerprint) : null,
              discovered: (this.discovery?.list() ?? []).map((found) => ({
                deviceId: found.id,
                name: found.name,
                fingerprint: fingerprintOf(Buffer.from(found.id, 'hex')),
                certificate: shortFingerprint(found.tls),
                address: found.address,
                pairing: found.pairing,
                paired: state.peers.some((peer) => peer.deviceId === found.id),
              })),
            }
          : null,
    }
  }

  async setAllowIncoming(enabled: boolean): Promise<void> {
    if (enabled) await this.ensureIdentity()
    await this.store.update((state) => ({ ...state, allowIncoming: enabled }))
    if (!enabled) {
      this.host?.cancel()
      for (const grant of this.store.get().grants) this.links?.close(grant.deviceId, 'host')
    }
    this.hostSync.grantsChanged()
    this.sync()
  }

  async setName(name: string): Promise<void> {
    await this.store.update((state) => ({ ...state, name }))
    this.changed()
  }

  async createInvite(): Promise<void> {
    if (!this.store.get().allowIncoming) throw new Error('先打开「允许连接本机」')
    this.hostFor(await this.ensureIdentity()).create()
    // 局域网里马上报一次「正等着配对」
    this.discovery?.announce()
  }

  cancelInvite(): void {
    this.host?.cancel()
  }

  async respond(deviceId: string, approved: boolean, projects: RemoteProjectGrant[]): Promise<void> {
    // 局域网版：记下对方配对时出示的证书，以后只认这张
    const tls = this.lan?.fingerprintOf(deviceId) ?? null
    const device = this.host?.respond(deviceId, approved)
    if (!device) throw new Error('这个配对请求已经失效了')
    if (approved) {
      if (this.lan && !tls) throw new Error('对方的连接断了，请对方重新配对')
      const now = new Date().toISOString()
      await this.store.update((state) => ({
        ...state,
        // 重新配对：整条换掉，授权按这次选的
        grants: [...state.grants.filter((grant) => grant.deviceId !== device.deviceId), { ...device, pairedAt: now, lastSeenAt: now, projects, ...(tls ? { tls } : {}) }],
      }))
    }
    await this.audit.append({ deviceId: device.deviceId, name: device.name, action: approved ? `允许配对：${describe(projects)}` : '拒绝配对' })
    this.hostSync.grantsChanged()
    this.sync()
  }

  async updateGrant(deviceId: string, projects: RemoteProjectGrant[]): Promise<void> {
    const grant = this.store.get().grants.find((item) => item.deviceId === deviceId)
    if (!grant) throw new Error('这台设备已经不在授权列表里了')
    await this.store.update((state) => ({ ...state, grants: state.grants.map((item) => (item.deviceId === deviceId ? { ...item, projects } : item)) }))
    await this.audit.append({ deviceId, name: grant.name, action: `修改授权：${describe(projects)}` })
    this.hostSync.grantsChanged()
    this.changed()
  }

  // 撤销：从中转白名单里拿掉，对方马上看到本机下线
  async revoke(deviceId: string, action = '撤销授权'): Promise<void> {
    const grant = this.store.get().grants.find((item) => item.deviceId === deviceId)
    if (!grant) return
    await this.store.update((state) => ({ ...state, grants: state.grants.filter((item) => item.deviceId !== deviceId) }))
    await this.audit.append({ deviceId, name: grant.name, action })
    this.links?.close(deviceId, 'host')
    this.hostSync.grantsChanged()
    this.sync()
  }

  // 对方在线时先请它撤销对本机的授权；不在线就只删本机这边，对方的授权要对方自己撤销
  async removePeer(deviceId: string): Promise<void> {
    if (this.relay?.isOnline(deviceId)) await this.guestSync.forget(deviceId).catch((error: unknown) => logRemote('请对方撤销授权失败', error))
    await this.store.update((state) => ({ ...state, peers: state.peers.filter((item) => item.deviceId !== deviceId) }))
    this.links?.close(deviceId, 'guest')
    this.sync()
  }

  async addDevice(text: string, name: string | null): Promise<RemoteAddResult> {
    if (this.options.transport === 'lan') return { ok: false, error: '在局域网里看到的设备上输入对方的配对码来添加' }
    if (this.adding) return { ok: false, error: '正在添加另一台设备' }
    const controller = new AbortController()
    this.adding = { controller, host: null }
    try {
      const identity = await this.ensureIdentity()
      this.sync()
      const relay = this.relayFor(identity)
      await relay.waitOnline(15_000)
      const device = await pairWithInvite(text, {
        identity,
        relay,
        hello: () => helloOf(identity, this.store.get().name, this.options.appVersion),
        listen: (from, handler) => (handler ? this.directListeners.set(from, handler) : this.directListeners.delete(from)),
        listenUndeliverable: (id, handler) => (handler ? this.undeliverableListeners.set(id, handler) : this.undeliverableListeners.delete(id)),
        allowHost: (host) => {
          if (this.adding) this.adding.host = host
          this.sync()
        },
        signal: controller.signal,
        approvalTimeoutMs: this.options.inviteTtlMs + 60_000,
      })
      const now = new Date().toISOString()
      const saved = { ...device, name: name ?? device.name, pairedAt: now, lastSeenAt: now }
      await this.store.update((state) => ({ ...state, peers: [...state.peers.filter((item) => item.deviceId !== device.deviceId), saved] }))
      return { ok: true, device: { deviceId: saved.deviceId, fingerprint: fingerprintOf(Buffer.from(saved.deviceId, 'hex')), name: saved.name, pairedAt: now, online: relay.isOnline(saved.deviceId), lastSeenAt: now } }
    } catch (error) {
      if (!(error instanceof InviteError)) logRemote('添加设备失败', error)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      this.adding = null
      this.sync()
    }
  }

  // 局域网版：在局域网里看到的设备上输入它的配对码。核对的证书指纹是发现服务报的那张，配好后只认它
  async addLanDevice(hostId: string, code: string, name: string | null): Promise<RemoteAddResult> {
    if (this.adding) return { ok: false, error: '正在添加另一台设备' }
    const digits = code.replace(/\s+/g, '')
    if (!/^\d{6}$/.test(digits)) return { ok: false, error: '配对码是对方屏幕上的 6 位数字' }
    const controller = new AbortController()
    this.adding = { controller, host: null }
    let rendezvous: string | null = null
    try {
      const identity = await this.ensureIdentity()
      this.sync()
      const lan = this.lan
      if (!lan) throw new Error('局域网服务没开起来')
      await lan.waitOnline(15_000)
      const found = this.discovery?.get(hostId)
      if (!found) throw new Error('局域网里看不到这台设备了：确认对方开着 Diffra 和「允许连接本机」，并且在同一个局域网')
      if (!found.pairing) throw new Error('对方还没生成配对码')
      const secret = lanPairingSecret(digits, hostId)
      const pairing = Buffer.from(rendezvousIdOf(secret)).toString('hex')
      rendezvous = pairing
      await lan.pair({ deviceId: hostId, address: found.address, port: found.port, tls: found.tls }, pairing)
      const device = await pairWithInvite(encodeInvite({ secret, deviceId: Buffer.from(hostId, 'hex') }), {
        identity,
        relay: lan,
        hello: () => helloOf(identity, this.store.get().name, this.options.appVersion),
        listen: (from, handler) => (handler ? this.directListeners.set(from, handler) : this.directListeners.delete(from)),
        listenUndeliverable: (id, handler) => (handler ? this.undeliverableListeners.set(id, handler) : this.undeliverableListeners.delete(id)),
        allowHost: (host) => {
          if (this.adding) this.adding.host = host
          this.sync()
        },
        signal: controller.signal,
        approvalTimeoutMs: this.options.inviteTtlMs + 60_000,
      })
      const now = new Date().toISOString()
      const saved = { ...device, name: name ?? device.name, pairedAt: now, lastSeenAt: now, tls: found.tls, lan: { address: found.address, port: found.port } }
      await this.store.update((state) => ({ ...state, peers: [...state.peers.filter((item) => item.deviceId !== device.deviceId), saved] }))
      return { ok: true, device: { deviceId: saved.deviceId, fingerprint: fingerprintOf(Buffer.from(saved.deviceId, 'hex')), name: saved.name, pairedAt: now, online: lan.isOnline(saved.deviceId), lastSeenAt: now } }
    } catch (error) {
      if (!(error instanceof InviteError)) logRemote('添加局域网设备失败', error)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      if (rendezvous) this.lan?.closePairing(rendezvous)
      this.adding = null
      this.sync()
    }
  }

  cancelAdd(): void {
    this.adding?.controller.abort()
  }

  async browse(on: boolean): Promise<void> {
    if (on) await this.ensureIdentity()
    this.browsing = on
    this.sync()
  }

  // 换一套新密钥：设备 ID 变了，所有配对都作废
  async resetIdentity(): Promise<void> {
    this.host?.cancel()
    this.host = null
    this.links?.closeAll()
    this.links = null
    this.relay?.stop()
    this.relay = null
    this.lan = null
    this.discovery?.stop()
    this.discovery = null
    await this.store.update((state) => ({ ...state, allowIncoming: false, grants: [], peers: [] }))
    await deleteIdentity(this.dir)
    this.identity = null
    this.certificate = null
    if (this.unavailable === null) {
      this.identity = await createIdentity(this.dir)
      if (this.options.transport === 'lan') this.certificate = await loadOrCreateCertificate(this.dir, this.identity)
    }
    this.sync()
  }

  recentAudit(): Promise<RemoteAuditEntry[]> {
    return this.audit.recent()
  }

  private async ensureIdentity(): Promise<DeviceIdentity> {
    if (this.unavailable) throw new Error(this.unavailable)
    this.identity ??= await createIdentity(this.dir)
    if (this.options.transport === 'lan') this.certificate ??= await loadOrCreateCertificate(this.dir, this.identity)
    return this.identity
  }

  private hostFor(identity: DeviceIdentity): PairingHost {
    this.host ??= new PairingHost({
      identity,
      relay: this.relayFor(identity),
      code: this.options.transport === 'lan',
      hello: () => helloOf(identity, this.store.get().name, this.options.appVersion),
      ttlMs: this.options.inviteTtlMs,
      changed: () => {
        this.discovery?.announce()
        this.changed()
      },
    })
    return this.host
  }

  // 配过对的设备记下的证书指纹（授权给本机的、本机去连的）
  private pinned(deviceId: string): string | null {
    const state = this.store.get()
    return state.grants.find((item) => item.deviceId === deviceId)?.tls ?? state.peers.find((item) => item.deviceId === deviceId)?.tls ?? null
  }

  private relayFor(identity: DeviceIdentity): RemoteTransport {
    if (this.relay) return this.relay
    const events: TransportEvents = {
      status: (status: RemoteRelayStatus) => {
        // 中转那边会合点开不出来（比如每小时开得太多），邀请串就用不了
        if (status.state === 'error') this.host?.cancel()
        // 连接断了，加密通道都要重建
        if (status.state !== 'online') this.links?.closeAll()
        this.changed()
      },
      presence: (deviceId, online) => {
        if (!online) {
          this.links?.close(deviceId, 'host')
          this.links?.close(deviceId, 'guest')
        }
        void this.touch(deviceId)
      },
      frame: (kind, from, payload) => {
        if (kind === FRAME.rendezvous) {
          if (this.store.get().allowIncoming) this.host?.receive(from, payload)
          return
        }
        if (payload.length === 0) return
        const body = payload.subarray(1)
        if (payload[0] === DIRECT.pairing) this.directListeners.get(from)?.(body)
        else this.linksFor(identity).receive(from, payload[0]!, body)
      },
      undeliverable: (to) => {
        this.undeliverableListeners.get(to)?.()
        this.links?.undeliverable(to)
      },
      rendezvous: (id, opened) => {
        if (!opened && id === this.host?.rendezvous) {
          logRemote('中转拒绝开会合点')
          this.host.cancel()
        }
      },
    }
    if (this.options.transport === 'relay') {
      this.relay = new RelayClient(this.options.relayUrl, identity, events)
      return this.relay
    }
    const certificate = this.certificate
    if (!certificate) throw new Error('本机的证书还没准备好')
    const lan = new LanTransport({ deviceId: identity.deviceId, certificate, bind: this.options.lan.bind, port: this.options.lan.port, pinned: (deviceId) => this.pinned(deviceId), events })
    this.lan = lan
    this.relay = lan
    this.discovery = new LanDiscovery({
      port: this.options.lan.discoveryPort,
      bind: this.options.lan.bind,
      targets: this.options.lan.discoveryTargets,
      broadcast: this.options.lan.broadcast,
      self: () => identity.deviceId,
      // 开着「允许连接本机」才报自己；没生成配对码时也报，配过对的设备换了地址能找回来
      announcement: () => (this.store.get().allowIncoming && lan.port ? { id: identity.deviceId, name: this.store.get().name, port: lan.port, tls: certificate.fingerprint, pairing: this.host?.current !== null && this.host?.current !== undefined } : null),
      changed: () => {
        this.updateTargets()
        this.changed()
      },
    })
    return lan
  }

  // 本机去连的设备的地址：发现服务看到的优先，看不到用上次记下的
  private updateTargets(): void {
    const lan = this.lan
    if (!lan) return
    lan.setTargets(
      this.store.get().peers.flatMap((peer) => {
        const found = this.discovery?.get(peer.deviceId)
        const at = found ? { address: found.address, port: found.port } : peer.lan
        return at ? [{ deviceId: peer.deviceId, ...at }] : []
      }),
    )
    // 地址变了就记下，下次启动先试新地址
    for (const peer of this.store.get().peers) {
      const found = this.discovery?.get(peer.deviceId)
      if (found && (found.address !== peer.lan?.address || found.port !== peer.lan?.port)) {
        void this.store
          .update((state) => ({ ...state, peers: state.peers.map((item) => (item.deviceId === peer.deviceId ? { ...item, lan: { address: found.address, port: found.port } } : item)) }))
          .catch((error: unknown) => logRemote('记下设备地址失败', error))
      }
    }
  }

  private linksFor(identity: DeviceIdentity): Links {
    const keyOf = (devices: StoredDevice[], deviceId: string) => {
      const device = devices.find((item) => item.deviceId === deviceId)
      return device ? Buffer.from(device.noiseKey, 'base64') : null
    }
    this.links ??= new Links({
      identity,
      relay: this.relayFor(identity),
      guestKey: (deviceId) => (this.store.get().allowIncoming ? keyOf(this.store.get().grants, deviceId) : null),
      refusal: () => (this.store.get().allowIncoming ? 'not-granted' : 'off'),
      hostKey: (deviceId) => keyOf(this.store.get().peers, deviceId),
      opened: (deviceId, role) => {
        if (role === 'host') this.hostSync.opened(deviceId)
      },
      message: (deviceId, role, message) => {
        if (role === 'host') void this.hostSync.handle(deviceId, message)
        else this.guestSync.message(deviceId, message)
      },
      closed: (deviceId, role) => {
        if (role === 'host') this.hostSync.closed(deviceId)
        else this.guestSync.closed(deviceId)
      },
    })
    return this.links
  }

  // 对方上线、下线时记下时刻
  private async touch(deviceId: string): Promise<void> {
    const now = new Date().toISOString()
    const state = this.store.get()
    if (state.grants.some((item) => item.deviceId === deviceId) || state.peers.some((item) => item.deviceId === deviceId)) {
      await this.store
        .update((current) => ({
          ...current,
          grants: current.grants.map((item) => (item.deviceId === deviceId ? { ...item, lastSeenAt: now } : item)),
          peers: current.peers.map((item) => (item.deviceId === deviceId ? { ...item, lastSeenAt: now } : item)),
        }))
        .catch((error: unknown) => logRemote('记录最后在线时间失败', error))
    }
    this.changed()
  }

  // 按现在的状态决定连不连中转、白名单放谁
  private sync(): void {
    const state = this.store.get()
    const needed = state.allowIncoming || state.peers.length > 0 || this.adding !== null || this.browsing
    if (!this.identity || !needed || (this.options.transport === 'lan' && !this.certificate)) {
      this.relay?.stop()
      this.discovery?.stop()
      this.changed()
      return
    }
    const relay = this.relayFor(this.identity)
    relay.setAllow([...(state.allowIncoming ? state.grants.map((grant) => grant.deviceId) : []), ...state.peers.map((peer) => peer.deviceId), ...(this.adding?.host ? [this.adding.host] : [])])
    relay.start()
    this.discovery?.start()
    this.discovery?.announce()
    this.updateTargets()
    this.changed()
  }

  private changed(): void {
    this.options.publish(this.view())
  }
}

function describe(projects: RemoteProjectGrant[]): string {
  if (projects.length === 0) return '不开放任何项目'
  return projects.map((project) => `${project.path}（${REMOTE_LEVEL_LABELS[project.level]}）`).join('、')
}
