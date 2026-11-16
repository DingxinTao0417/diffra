// 局域网设备连接（v2 · M6）的底层：自签证书、私有地址、发现、TLS 传输。node --test scripts/lan.test.ts
// 都在本机回环地址上跑（127.0.0.1），不惊动防火墙
import assert from 'node:assert/strict'
import { createPrivateKey, X509Certificate } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { createServer } from 'node:net'
import { test } from 'node:test'
import { FRAME, type FrameKind } from '@diffra/relay/protocol'
import { LanDiscovery } from '../src/main/remote/lan-discovery.ts'
import { createLanCertificate, isPrivateAddress, shortFingerprint } from '../src/main/remote/lan-tls.ts'
import { LanError, LanTransport, VERSION_MISMATCH } from '../src/main/remote/lan-transport.ts'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等太久了')
    await sleep(20)
  }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

test('自签证书：Node 读得出来，指纹和自己算的一样；给人看的指纹 4 个一组', () => {
  const certificate = createLanCertificate('Diffra 测试')
  const parsed = new X509Certificate(certificate.cert)
  assert.equal(parsed.subject, 'CN=Diffra 测试')
  assert.equal(parsed.fingerprint256.replaceAll(':', '').toLowerCase(), certificate.fingerprint)
  assert.ok(parsed.checkPrivateKey(createPrivateKey(certificate.key)))
  assert.ok(new Date(parsed.validTo).getUTCFullYear() === 2049)
  assert.match(shortFingerprint(certificate.fingerprint), /^[0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4}$/)
})

test('私有地址：局域网、链路本地、本机认，公网、组播、乱写的不认', () => {
  for (const address of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.20', '169.254.3.4', '127.0.0.1', '::1', 'fe80::1%eth0', 'fd12:3456::1', '::ffff:192.168.1.5']) assert.equal(isPrivateAddress(address), true, address)
  for (const address of ['8.8.8.8', '172.32.0.1', '11.0.0.1', '224.0.0.1', '0.0.0.0', '2001:db8::1', '::ffff:8.8.8.8', 'example.com', '']) assert.equal(isPrivateAddress(address), false, address)
})

test('发现：开着的设备报自己，另一台在列表里看到它（地址是发来的地址）；不报自己、不收乱写的包；关掉不报', async () => {
  const [portA, portB] = [await freePort(), await freePort()]
  let announcing = true
  const changes: string[] = []
  const a = new LanDiscovery({ port: portA, bind: '127.0.0.1', targets: [{ address: '127.0.0.1', port: portB }], broadcast: false, self: () => 'a'.repeat(32), announcement: () => (announcing ? { id: 'a'.repeat(32), name: '甲', port: 5555, tls: 'f'.repeat(64), pairing: true, protocol: 7 } : null), changed: () => {} })
  const b = new LanDiscovery({ port: portB, bind: '127.0.0.1', targets: [{ address: '127.0.0.1', port: portA }], broadcast: false, self: () => 'b'.repeat(32), announcement: () => null, changed: () => changes.push('b') })
  try {
    a.start()
    b.start()
    await until(() => b.list().length === 1)
    assert.deepEqual({ ...b.get('a'.repeat(32)), seenAt: 0 }, { id: 'a'.repeat(32), name: '甲', port: 5555, tls: 'f'.repeat(64), pairing: true, protocol: 7, address: '127.0.0.1', seenAt: 0 })
    assert.deepEqual(a.list(), [])
    // 乱写的包、超长的包不理
    const raw = createSocket('udp4')
    raw.send(Buffer.from('{"t":"diffra-lan","v":1,"id":"zz"}'), portB, '127.0.0.1')
    raw.send(Buffer.alloc(2000, 'x'), portB, '127.0.0.1')
    await sleep(200)
    raw.close()
    assert.equal(b.list().length, 1)
    assert.ok(changes.length >= 1)
    announcing = false
    a.announce()
  } finally {
    a.stop()
    b.stop()
  }
})

interface Recorder {
  frames: Array<{ kind: FrameKind; from: string; payload: string }>
  presence: Array<[string, boolean]>
  undeliverable: string[]
}

function transport(id: string, pins: Map<string, string>, protocol?: number) {
  const certificate = createLanCertificate(`Diffra ${id.slice(0, 4)}`)
  const recorder: Recorder = { frames: [], presence: [], undeliverable: [] }
  const lan = new LanTransport({
    deviceId: id,
    certificate,
    bind: '127.0.0.1',
    port: 0,
    pinned: (deviceId) => pins.get(deviceId) ?? null,
    protocol: protocol ?? 1,
    events: {
      status: () => {},
      presence: (deviceId, online) => recorder.presence.push([deviceId, online]),
      frame: (kind, from, payload) => recorder.frames.push({ kind, from, payload: payload.toString('utf8') }),
      undeliverable: (to) => recorder.undeliverable.push(to),
      rendezvous: () => {},
    },
  })
  return { lan, certificate, recorder }
}

test('传输：凭配对码的会合点连进来，只收这个会合点的帧；证书、会合点不对的被拒；配完后钉住证书，设备连接双向收发；撤销断开；对方重启后自动重连', async () => {
  const hostId = 'a'.repeat(32)
  const guestId = 'b'.repeat(32)
  const hostPins = new Map<string, string>()
  const guestPins = new Map<string, string>()
  const host = transport(hostId, hostPins)
  const guest = transport(guestId, guestPins)
  host.lan.start()
  guest.lan.start()
  try {
    await host.lan.waitOnline(5000)
    await guest.lan.waitOnline(5000)
    const target = { deviceId: hostId, address: '127.0.0.1', port: host.lan.port, tls: host.certificate.fingerprint }
    const rendezvous = 'c'.repeat(32)

    // 没开会合点、会合点不对、证书指纹不对
    await assert.rejects(guest.lan.pair(target, rendezvous), (error: unknown) => error instanceof LanError && error.message.includes('配对码不对'))
    host.lan.openRendezvous(rendezvous, Date.now() + 60_000)
    await assert.rejects(guest.lan.pair(target, 'd'.repeat(32)), /配对码不对/)
    await assert.rejects(guest.lan.pair({ ...target, tls: '0'.repeat(64) }, rendezvous), /证书和预期的对不上/)

    // 配对连接：连接端发会合点的帧，被连接端直发回去
    await guest.lan.pair(target, rendezvous)
    assert.equal(guest.lan.send(FRAME.rendezvous, rendezvous, Buffer.from('hi')), true)
    await until(() => host.recorder.frames.length === 1)
    assert.deepEqual(host.recorder.frames[0], { kind: FRAME.rendezvous, from: guestId, payload: 'hi' })
    assert.equal(host.lan.send(FRAME.direct, guestId, Buffer.from('hello back')), true)
    await until(() => guest.recorder.frames.length === 1)
    assert.deepEqual(guest.recorder.frames[0], { kind: FRAME.direct, from: hostId, payload: 'hello back' })
    // 配对连接不算在线；记下双方的证书指纹
    assert.equal(host.lan.isOnline(guestId), false)
    assert.equal(host.lan.fingerprintOf(guestId), guest.certificate.fingerprint)
    host.lan.closeRendezvous(rendezvous)
    await until(() => guest.recorder.undeliverable.includes(rendezvous))

    // 配好了：互相钉住证书，连接端自动连上，两边都在线，直发帧双向
    hostPins.set(guestId, guest.certificate.fingerprint)
    guestPins.set(hostId, host.certificate.fingerprint)
    host.lan.setAllow([guestId])
    guest.lan.setAllow([hostId])
    guest.lan.setTargets([{ deviceId: hostId, address: '127.0.0.1', port: host.lan.port }])
    await until(() => host.lan.isOnline(guestId) && guest.lan.isOnline(hostId))
    assert.deepEqual(host.recorder.presence.at(-1), [guestId, true])
    assert.deepEqual(guest.recorder.presence.at(-1), [hostId, true])
    guest.lan.send(FRAME.direct, hostId, Buffer.from('to host'))
    host.lan.send(FRAME.direct, guestId, Buffer.from('to guest'))
    await until(() => host.recorder.frames.some((frame) => frame.payload === 'to host') && guest.recorder.frames.some((frame) => frame.payload === 'to guest'))
    // 设备连接上不收会合点的帧
    assert.equal(guest.lan.send(FRAME.rendezvous, rendezvous, Buffer.from('x')), false)

    // 撤销：被连接端断开，连接端看到下线、再连被拒
    host.lan.setAllow([])
    await until(() => !guest.lan.isOnline(hostId))
    assert.deepEqual(guest.recorder.presence.at(-1), [hostId, false])
    await sleep(1500)
    assert.equal(host.lan.isOnline(guestId), false)

    // 重新授权后：被连接端重启（同一端口），连接端退避重连回来
    host.lan.setAllow([guestId])
    await until(() => guest.lan.isOnline(hostId), 8000)
    const port = host.lan.port
    host.lan.stop()
    await until(() => !guest.lan.isOnline(hostId))
    // 同一台设备重启：证书不变
    const again = new LanTransport({ deviceId: hostId, certificate: host.certificate, bind: '127.0.0.1', port, pinned: (deviceId) => hostPins.get(deviceId) ?? null, protocol: 1, events: { status: () => {}, presence: () => {}, frame: () => {}, undeliverable: () => {}, rendezvous: () => {} } })
    again.setAllow([guestId])
    again.start()
    try {
      await until(() => guest.lan.isOnline(hostId), 10_000)
    } finally {
      again.stop()
    }
  } finally {
    host.lan.stop()
    guest.lan.stop()
  }
})

test('传输：证书和钉住的对不上时拒绝（被冒充）；连接端换了证书也连不上', async () => {
  const hostId = 'a'.repeat(32)
  const guestId = 'b'.repeat(32)
  const hostPins = new Map<string, string>()
  const guestPins = new Map<string, string>()
  const host = transport(hostId, hostPins)
  const guest = transport(guestId, guestPins)
  host.lan.start()
  guest.lan.start()
  try {
    await host.lan.waitOnline(5000)
    await guest.lan.waitOnline(5000)
    hostPins.set(guestId, '1'.repeat(64))
    guestPins.set(hostId, host.certificate.fingerprint)
    host.lan.setAllow([guestId])
    guest.lan.setTargets([{ deviceId: hostId, address: '127.0.0.1', port: host.lan.port }])
    await sleep(1500)
    assert.equal(guest.lan.isOnline(hostId), false)
    assert.equal(host.lan.isOnline(guestId), false)
  } finally {
    host.lan.stop()
    guest.lan.stop()
  }
})

test('传输：两边的设备连接协议版本不一样时，配对和重连都被拒，原因写明是版本问题', async () => {
  const hostId = 'a'.repeat(32)
  const guestId = 'b'.repeat(32)
  const hostPins = new Map<string, string>()
  const guestPins = new Map<string, string>()
  const host = transport(hostId, hostPins)
  const guest = transport(guestId, guestPins, 99)
  host.lan.start()
  guest.lan.start()
  try {
    await host.lan.waitOnline(5000)
    await guest.lan.waitOnline(5000)
    const rendezvous = 'c'.repeat(32)
    host.lan.openRendezvous(rendezvous, Date.now() + 60_000)
    const target = { deviceId: hostId, address: '127.0.0.1', port: host.lan.port, tls: host.certificate.fingerprint }
    await assert.rejects(guest.lan.pair(target, rendezvous), (error: unknown) => error instanceof LanError && error.message === VERSION_MISMATCH)
    // 配过对的也一样：证书钉住、授权都对，版本不对照样连不上
    hostPins.set(guestId, guest.certificate.fingerprint)
    guestPins.set(hostId, host.certificate.fingerprint)
    host.lan.setAllow([guestId])
    guest.lan.setTargets([{ deviceId: hostId, address: '127.0.0.1', port: host.lan.port }])
    await sleep(1500)
    assert.equal(guest.lan.isOnline(hostId), false)
    assert.equal(host.lan.isOnline(guestId), false)
  } finally {
    host.lan.stop()
    guest.lan.stop()
  }
})
