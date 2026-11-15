import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { authPayload, CLOSE, deviceIdOf, FRAME, type FrameKind, ID_BYTES, MAX_FRAME_BYTES, RELAY_PATH, type ServerMessage, serverMessageSchema } from '../src/protocol.ts'
import { createRelay, type Relay, type RelayLimits } from '../src/relay.ts'

interface Keys {
  signingKey: Buffer
  privateKey: KeyObject
  noiseKey: Buffer
  id: string
}

function newKeys(): Keys {
  const signing = generateKeyPairSync('ed25519')
  const signingKey = signing.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  const noiseKey = generateKeyPairSync('x25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  return { signingKey, privateKey: signing.privateKey, noiseKey, id: deviceIdOf(signingKey, noiseKey).toString('hex') }
}

// 一台测试设备：Node 自带的 WebSocket（桌面端主进程用的也是它），收到的控制消息和转发帧都记下来
class Device {
  readonly messages: ServerMessage[] = []
  readonly frames: Array<{ kind: number; peer: string; payload: string }> = []
  closeCode: number | null = null
  readonly socket: WebSocket
  readonly keys: Keys

  constructor(url: string, keys: Keys, login: (device: Device, nonce: Buffer) => void) {
    this.keys = keys
    this.socket = new WebSocket(url)
    this.socket.binaryType = 'arraybuffer'
    this.socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        const message = serverMessageSchema.parse(JSON.parse(event.data))
        this.messages.push(message)
        if (message.type === 'challenge') login(this, Buffer.from(message.nonce, 'base64'))
        return
      }
      const bytes = Buffer.from(event.data as ArrayBuffer)
      this.frames.push({ kind: bytes[0]!, peer: bytes.subarray(1, 1 + ID_BYTES).toString('hex'), payload: bytes.subarray(1 + ID_BYTES).toString('utf8') })
    })
    this.socket.addEventListener('close', (event) => (this.closeCode = event.code))
  }

  control(message: unknown): void {
    this.socket.send(JSON.stringify(message))
  }

  frame(kind: FrameKind, peer: string, payload: string | Buffer): void {
    this.socket.send(Buffer.concat([Buffer.from([kind]), Buffer.from(peer, 'hex'), Buffer.isBuffer(payload) ? payload : Buffer.from(payload)]))
  }

  allow(...peers: Device[]): void {
    this.control({ type: 'allow', peers: peers.map((peer) => peer.keys.id) })
  }

  async closed(): Promise<number> {
    await vi.waitFor(() => expect(this.closeCode).not.toBeNull(), { timeout: 3000 })
    return this.closeCode!
  }

  has(match: (message: ServerMessage) => boolean): boolean {
    return this.messages.some(match)
  }
}

const signIn = (device: Device, nonce: Buffer) =>
  device.control({
    type: 'auth',
    protocol: 1,
    signingKey: device.keys.signingKey.toString('base64'),
    noiseKey: device.keys.noiseKey.toString('base64'),
    signature: sign(null, authPayload(nonce), device.keys.privateKey).toString('base64'),
  })

let relay: Relay | null = null
let devices: Device[] = []
const lines: string[] = []

afterEach(async () => {
  for (const device of devices) device.socket.close()
  devices = []
  await relay?.close()
  relay = null
  lines.length = 0
})

async function start(limits: Partial<RelayLimits> = {}): Promise<string> {
  relay = createRelay({ host: '127.0.0.1', port: 0, trustProxy: false, release: 'test-release', limits, log: (line) => lines.push(line) })
  const port = await relay.listen()
  return `127.0.0.1:${port}`
}

function connect(address: string, keys = newKeys(), login = signIn): Device {
  const device = new Device(`ws://${address}${RELAY_PATH}`, keys, login)
  devices.push(device)
  return device
}

async function online(address: string, keys?: Keys): Promise<Device> {
  const device = connect(address, keys)
  await vi.waitFor(() => expect(device.has((message) => message.type === 'ready')).toBe(true))
  return device
}

// 互相放进白名单，等两边都看到对方在线
async function pair(a: Device, b: Device): Promise<void> {
  a.allow(b)
  b.allow(a)
  await vi.waitFor(() => {
    expect(a.has((message) => message.type === 'presence' && message.deviceId === b.keys.id && message.online)).toBe(true)
    expect(b.has((message) => message.type === 'presence' && message.deviceId === a.keys.id && message.online)).toBe(true)
  })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150))

describe('登录', () => {
  test('签名对的设备拿到 ready，设备 ID 是两把公钥的哈希；日志只记 ID 前 8 位和 IP', async () => {
    const address = await start()
    const device = await online(address)
    expect(device.messages.find((message) => message.type === 'ready')).toEqual({ type: 'ready', deviceId: device.keys.id })
    expect(lines).toEqual([`connect ${device.keys.id.slice(0, 8)} 127.0.0.1`])
  })

  test('签名不对、版本不对、格式不对、登录前发转发帧、没及时登录，都直接断开', async () => {
    const address = await start({ authTimeoutMs: 300 })
    const other = newKeys()
    const forged = connect(address, newKeys(), (device, nonce) =>
      device.control({ type: 'auth', protocol: 1, signingKey: device.keys.signingKey.toString('base64'), noiseKey: device.keys.noiseKey.toString('base64'), signature: sign(null, authPayload(nonce), other.privateKey).toString('base64') }),
    )
    const oldVersion = connect(address, newKeys(), (device) => device.control({ type: 'auth', protocol: 99, signingKey: device.keys.signingKey.toString('base64'), noiseKey: device.keys.noiseKey.toString('base64'), signature: Buffer.alloc(64).toString('base64') }))
    const garbage = connect(address, newKeys(), (device) => device.socket.send('{not json'))
    const early = connect(address, newKeys(), (device) => device.frame(FRAME.direct, other.id, 'hi'))
    const silent = connect(address, newKeys(), () => {})
    expect(await forged.closed()).toBe(CLOSE.authFailed.code)
    expect(await oldVersion.closed()).toBe(CLOSE.version.code)
    expect(await garbage.closed()).toBe(CLOSE.protocol.code)
    expect(await early.closed()).toBe(CLOSE.protocol.code)
    expect(await silent.closed()).toBe(CLOSE.authTimeout.code)
  })

  test('同一台设备在别处连上：旧连接断开，对方不会收到它下线', async () => {
    const address = await start()
    const peer = await online(address)
    const keys = newKeys()
    const first = await online(address, keys)
    await pair(first, peer)
    const second = await online(address, keys)
    expect(await first.closed()).toBe(CLOSE.replaced.code)
    await settle()
    expect(peer.has((message) => message.type === 'presence' && !message.online)).toBe(false)
    expect(second.closeCode).toBeNull()
  })
})

describe('转发和在线状态', () => {
  test('互相在白名单里才转：收件方看到发件设备的 ID；没放进白名单或不在线只说送不到', async () => {
    const address = await start()
    const a = await online(address)
    const b = await online(address)
    const stranger = await online(address)
    await pair(a, b)

    a.frame(FRAME.direct, b.keys.id, '你好')
    await vi.waitFor(() => expect(b.frames).toEqual([{ kind: FRAME.direct, peer: a.keys.id, payload: '你好' }]))

    stranger.frame(FRAME.direct, b.keys.id, '我是陌生人')
    stranger.frame(FRAME.direct, newKeys().id, '没这台设备')
    await vi.waitFor(() => expect(stranger.messages.filter((message) => message.type === 'undeliverable')).toHaveLength(2))
    expect(b.frames).toHaveLength(1)
  })

  test('对方下线、把我移出白名单时收到下线；互通前不告诉在线状态', async () => {
    const address = await start()
    const a = await online(address)
    const b = await online(address)
    const c = await online(address)
    // 只有一边放：c 不知道 a 在不在线
    c.allow(a)
    await settle()
    expect(c.has((message) => message.type === 'presence')).toBe(false)

    await pair(a, b)
    a.allow()
    await vi.waitFor(() => expect(b.has((message) => message.type === 'presence' && message.deviceId === a.keys.id && !message.online)).toBe(true))

    a.allow(b)
    await vi.waitFor(() => expect(b.messages.filter((message) => message.type === 'presence' && message.deviceId === a.keys.id && message.online)).toHaveLength(2))
    b.socket.close()
    await vi.waitFor(() => expect(a.messages.filter((message) => message.type === 'presence' && message.deviceId === b.keys.id && !message.online)).toHaveLength(2))
  })

  test('ping 回 pong；心跳不会断开正常的连接', async () => {
    const address = await start({ heartbeatMs: 50 })
    const device = await online(address)
    device.control({ type: 'ping' })
    await vi.waitFor(() => expect(device.has((message) => message.type === 'pong')).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(device.closeCode).toBeNull()
  })
})

describe('配对会合点', () => {
  test('连接端往会合点发，开会合点的设备收到；它直接回连接端；第 4 台设备、占用别人的 ID、关掉和过期后都不行', async () => {
    const address = await start()
    const host = await online(address)
    const guest = await online(address)
    const meeting = 'ab'.repeat(16)
    host.control({ type: 'rendezvous-open', id: meeting, ttlSeconds: 1 })
    await vi.waitFor(() => expect(host.has((message) => message.type === 'rendezvous-opened' && message.id === meeting)).toBe(true))

    // 连接端从邀请串知道被连接端是谁，先把它放进自己的白名单，被连接端才能直接回
    guest.allow(host)
    guest.frame(FRAME.rendezvous, meeting, '握手第一条')
    await vi.waitFor(() => expect(host.frames).toEqual([{ kind: FRAME.rendezvous, peer: guest.keys.id, payload: '握手第一条' }]))
    host.frame(FRAME.direct, guest.keys.id, '握手第二条')
    await vi.waitFor(() => expect(guest.frames).toEqual([{ kind: FRAME.direct, peer: host.keys.id, payload: '握手第二条' }]))

    const others = await Promise.all([online(address), online(address), online(address)])
    for (const other of others) other.frame(FRAME.rendezvous, meeting, '我也来')
    // 加上 guest 最多 3 台：前两台送到，第三台送不到
    await vi.waitFor(() => expect(others[2]!.has((message) => message.type === 'undeliverable' && message.to === meeting)).toBe(true))
    expect(host.frames.filter((frame) => frame.kind === FRAME.rendezvous)).toHaveLength(3)

    others[0]!.control({ type: 'rendezvous-open', id: meeting, ttlSeconds: 60 })
    await vi.waitFor(() => expect(others[0]!.has((message) => message.type === 'rendezvous-refused' && message.id === meeting)).toBe(true))

    await new Promise((resolve) => setTimeout(resolve, 1100))
    guest.frame(FRAME.rendezvous, meeting, '过期了')
    await vi.waitFor(() => expect(guest.has((message) => message.type === 'undeliverable' && message.to === meeting)).toBe(true))
  })

  test('开会合点的设备断开或主动关掉，会合点就没了；每台设备同时开的个数有上限', async () => {
    const address = await start({ rendezvousPerDevice: 2 })
    const host = await online(address)
    const guest = await online(address)
    const ids = ['01'.repeat(16), '02'.repeat(16), '03'.repeat(16)]
    for (const id of ids) host.control({ type: 'rendezvous-open', id, ttlSeconds: 60 })
    await vi.waitFor(() => expect(host.has((message) => message.type === 'rendezvous-refused' && message.id === ids[2])).toBe(true))

    host.control({ type: 'rendezvous-close', id: ids[0] })
    await settle()
    guest.frame(FRAME.rendezvous, ids[0]!, '关了')
    await vi.waitFor(() => expect(guest.has((message) => message.type === 'undeliverable' && message.to === ids[0])).toBe(true))

    host.socket.close()
    await host.closed()
    await settle()
    guest.frame(FRAME.rendezvous, ids[1]!, '断了')
    await vi.waitFor(() => expect(guest.has((message) => message.type === 'undeliverable' && message.to === ids[1])).toBe(true))
  })

  test('同一个 IP 每小时开会合点有上限', async () => {
    const address = await start({ rendezvousPerIpPerHour: 2, rendezvousPerDevice: 10 })
    const host = await online(address)
    const ids = ['0a'.repeat(16), '0b'.repeat(16), '0c'.repeat(16)]
    for (const id of ids) host.control({ type: 'rendezvous-open', id, ttlSeconds: 60 })
    await vi.waitFor(() => expect(host.has((message) => message.type === 'rendezvous-refused' && message.id === ids[2])).toBe(true))
    expect(host.messages.filter((message) => message.type === 'rendezvous-opened')).toHaveLength(2)
  })
})

describe('上限和限速', () => {
  test('同一个 IP 连太多被拒；发得太快断开；转发帧和控制消息太大断开', async () => {
    const limited = await start({ maxPerIp: 2 })
    await online(limited)
    await online(limited)
    expect(await connect(limited).closed()).toBe(CLOSE.full.code)
    await relay!.close()

    const address = await start({ bytesPerSecond: 1000, byteBurst: 20_000 })
    const a = await online(address)
    const b = await online(address)
    await pair(a, b)
    for (let index = 0; index < 5; index++) a.frame(FRAME.direct, b.keys.id, Buffer.alloc(10_000))
    expect(await a.closed()).toBe(CLOSE.rateLimited.code)

    const big = await online(address)
    big.frame(FRAME.direct, b.keys.id, Buffer.alloc(MAX_FRAME_BYTES))
    // ws 按 maxPayload 拒收，关闭码 1009（消息太大）
    expect(await big.closed()).toBe(1009)

    const chatty = await online(address)
    chatty.control({ type: 'allow', peers: [], padding: 'x'.repeat(9000) })
    expect(await chatty.closed()).toBe(CLOSE.protocol.code)
  })

  test('乱发的帧只会断开发的那台，中转照常转别人的', async () => {
    const address = await start()
    const a = await online(address)
    const b = await online(address)
    await pair(a, b)
    // 固定的伪随机序列，失败时能重现
    let seed = 20261110
    const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648
    for (let round = 0; round < 20; round++) {
      const noisy = await online(address)
      const length = 1 + Math.floor(next() * 64)
      const bytes = Buffer.from(Array.from({ length }, () => Math.floor(next() * 256)))
      if (round % 2 === 0) noisy.socket.send(bytes)
      else noisy.socket.send(bytes.toString('latin1'))
      await noisy.closed()
    }
    a.frame(FRAME.direct, b.keys.id, '还在')
    await vi.waitFor(() => expect(b.frames.at(-1)?.payload).toBe('还在'))
  })
})

describe('HTTP', () => {
  test('健康检查返回版本标识；别的路径 404，也不能升级成 WebSocket', async () => {
    const address = await start()
    const health = await fetch(`http://${address}/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true, release: 'test-release' })
    expect((await fetch(`http://${address}/`)).status).toBe(404)

    const wrong = new WebSocket(`ws://${address}/other`)
    const failed = await new Promise<boolean>((resolve) => {
      wrong.addEventListener('error', () => resolve(true))
      wrong.addEventListener('open', () => resolve(false))
    })
    expect(failed).toBe(true)
  })

  test('没有显式开启时只保留健康检查，设备连接升级被拒', async () => {
    relay = createRelay({ host: '127.0.0.1', port: 0, trustProxy: false, release: 'test-release', enabled: false, log: (line) => lines.push(line) })
    const address = `127.0.0.1:${await relay.listen()}`
    const health = await fetch(`http://${address}/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true, release: 'test-release' })

    const socket = new WebSocket(`ws://${address}${RELAY_PATH}`)
    const failed = await new Promise<boolean>((resolve) => {
      socket.addEventListener('error', () => resolve(true))
      socket.addEventListener('open', () => resolve(false))
    })
    expect(failed).toBe(true)
    socket.close()
  })
})
