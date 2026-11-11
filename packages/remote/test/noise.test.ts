import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { generateKeyPair, Handshake, keyPairOf, NOISE_MAX_PAYLOAD, NoiseError, type NoisePattern } from '../src/noise.js'

interface Vector {
  source: string
  protocol_name: string
  init_prologue: string
  init_psks?: string[]
  init_static: string
  init_ephemeral: string
  init_remote_static?: string
  resp_prologue: string
  resp_psks?: string[]
  resp_static: string
  resp_ephemeral: string
  resp_remote_static?: string
  handshake_hash?: string
  messages: Array<{ payload: string; ciphertext: string }>
}

const fixture = JSON.parse(readFileSync(new URL('./fixtures/noise-vectors.json', import.meta.url), 'utf8')) as { vectors: Vector[] }
const bytes = (value: string) => Buffer.from(value, 'hex')
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex')
const text = (value: string) => Buffer.from(value, 'utf8')

// 一对握手：两边的长期密钥随机生成；KK 两边互相知道公钥，XXpsk3 两边拿同一个预共享密钥
function pair(pattern: NoisePattern, overrides: { responderPsk?: Uint8Array; initiatorRemote?: Uint8Array; responderRemote?: Uint8Array; responderPrologue?: Uint8Array } = {}) {
  const initiatorKey = generateKeyPair()
  const responderKey = generateKeyPair()
  const psk = Buffer.alloc(32, 7)
  const prologue = text('diffra-remote/1')
  const initiator = new Handshake({ pattern, initiator: true, prologue, staticKey: initiatorKey, remoteStatic: overrides.initiatorRemote ?? responderKey.publicKey, psk })
  const responder = new Handshake({
    pattern,
    initiator: false,
    prologue: overrides.responderPrologue ?? prologue,
    staticKey: responderKey,
    remoteStatic: overrides.responderRemote ?? initiatorKey.publicKey,
    psk: overrides.responderPsk ?? psk,
  })
  return { initiator, responder, initiatorKey, responderKey }
}

// 轮流发完整个握手，返回双方的传输层
function complete(initiator: Handshake, responder: Handshake) {
  while (!initiator.finished || !responder.finished) {
    const [from, to] = initiator.myTurn ? [initiator, responder] : [responder, initiator]
    to.readMessage(from.writeMessage())
  }
  return { initiator: initiator.split(), responder: responder.split() }
}

function channel() {
  const { initiator, responder } = pair('KK')
  return complete(initiator, responder)
}

describe('Noise 公开测试向量', () => {
  test('摘出来的向量覆盖两种握手，KK 有两份独立来源', () => {
    const names = fixture.vectors.map((vector) => `${vector.source} ${vector.protocol_name}`)
    expect(names).toEqual(['cacophony Noise_KK_25519_AESGCM_SHA256', 'cacophony Noise_XXpsk3_25519_AESGCM_SHA256', 'snow Noise_KK_25519_AESGCM_SHA256'])
  })

  for (const vector of fixture.vectors) {
    test(`${vector.source} ${vector.protocol_name}：握手消息、握手哈希、传输消息逐字节一致`, () => {
      const pattern = vector.protocol_name.split('_')[1] as NoisePattern
      const initiator = new Handshake({
        pattern,
        initiator: true,
        prologue: bytes(vector.init_prologue),
        staticKey: keyPairOf(bytes(vector.init_static)),
        remoteStatic: vector.init_remote_static ? bytes(vector.init_remote_static) : undefined,
        psk: vector.init_psks?.[0] ? bytes(vector.init_psks[0]) : undefined,
        ephemeral: keyPairOf(bytes(vector.init_ephemeral)),
      })
      const responder = new Handshake({
        pattern,
        initiator: false,
        prologue: bytes(vector.resp_prologue),
        staticKey: keyPairOf(bytes(vector.resp_static)),
        remoteStatic: vector.resp_remote_static ? bytes(vector.resp_remote_static) : undefined,
        psk: vector.resp_psks?.[0] ? bytes(vector.resp_psks[0]) : undefined,
        ephemeral: keyPairOf(bytes(vector.resp_ephemeral)),
      })
      let transports: { initiator: ReturnType<Handshake['split']>; responder: ReturnType<Handshake['split']> } | null = null
      vector.messages.forEach((message, index) => {
        // 两边轮流发：双数是发起方
        const fromInitiator = index % 2 === 0
        if (!transports) {
          const [from, to] = fromInitiator ? [initiator, responder] : [responder, initiator]
          expect(hex(from.writeMessage(bytes(message.payload)))).toBe(message.ciphertext)
          expect(hex(to.readMessage(bytes(message.ciphertext)))).toBe(message.payload)
          if (initiator.finished && responder.finished) {
            if (vector.handshake_hash) expect(hex(initiator.handshakeHash())).toBe(vector.handshake_hash)
            expect(hex(responder.handshakeHash())).toBe(hex(initiator.handshakeHash()))
            transports = { initiator: initiator.split(), responder: responder.split() }
          }
          return
        }
        const [from, to] = fromInitiator ? [transports.initiator, transports.responder] : [transports.responder, transports.initiator]
        expect(hex(from.encrypt(bytes(message.payload)))).toBe(message.ciphertext)
        expect(hex(to.decrypt(bytes(message.ciphertext)))).toBe(message.payload)
      })
      expect(transports).not.toBeNull()
    })
  }
})

describe('Noise 握手', () => {
  test('KK：双向收发；XXpsk3：发起方拿到对方的长期公钥，应答方拿到发起方的', () => {
    const kk = pair('KK')
    const kkChannel = complete(kk.initiator, kk.responder)
    expect(Buffer.from(kkChannel.responder.decrypt(kkChannel.initiator.encrypt(text('你好')))).toString()).toBe('你好')
    expect(Buffer.from(kkChannel.initiator.decrypt(kkChannel.responder.encrypt(text('收到')))).toString()).toBe('收到')

    const xx = pair('XXpsk3')
    const xxChannel = complete(xx.initiator, xx.responder)
    expect(hex(xx.initiator.remoteStatic()!)).toBe(hex(xx.responderKey.publicKey))
    expect(hex(xx.responder.remoteStatic()!)).toBe(hex(xx.initiatorKey.publicKey))
    expect(Buffer.from(xxChannel.responder.decrypt(xxChannel.initiator.encrypt(text('配对')))).toString()).toBe('配对')
  })

  test('KK：一方认错了对方的长期公钥，对方收第一条就失败', () => {
    const { initiator, responder } = pair('KK', { responderRemote: generateKeyPair().publicKey })
    expect(() => responder.readMessage(initiator.writeMessage())).toThrow(NoiseError)
    // 失败后这次握手作废
    expect(() => responder.writeMessage()).toThrow('握手已经失败')
  })

  test('XXpsk3：预共享密钥不对，应答方收第三条时失败', () => {
    const { initiator, responder } = pair('XXpsk3', { responderPsk: Buffer.alloc(32, 8) })
    responder.readMessage(initiator.writeMessage())
    initiator.readMessage(responder.writeMessage())
    expect(() => responder.readMessage(initiator.writeMessage())).toThrow(NoiseError)
    expect(() => responder.split()).toThrow('握手还没完成')
  })

  test('两边的 prologue（协议版本）不一致时握手失败', () => {
    const { initiator, responder } = pair('KK', { responderPrologue: text('diffra-remote/0') })
    expect(() => responder.readMessage(initiator.writeMessage())).toThrow(NoiseError)
  })

  test('握手消息被改一位、被截断都失败；对方给全 0 的临时公钥被拒', () => {
    for (const change of [(message: Buffer) => message.fill(message[40]! ^ 1, 40, 41), (message: Buffer) => message.subarray(0, 40)]) {
      const { initiator, responder } = pair('KK')
      expect(() => responder.readMessage(change(Buffer.from(initiator.writeMessage())))).toThrow(NoiseError)
    }
    const { initiator, responder } = pair('KK')
    const message = Buffer.from(initiator.writeMessage())
    message.fill(0, 0, 32)
    // OpenSSL 自己就拒绝（密钥交换失败）；不拒绝的实现算出全 0，由我们拒绝（对方的公钥无效）
    expect(() => responder.readMessage(message)).toThrow(/密钥交换失败|对方的公钥无效/)
  })

  test('不按顺序调用会报错；缺对方公钥或预共享密钥建不起来', () => {
    const { initiator, responder } = pair('KK')
    expect(() => responder.writeMessage()).toThrow('现在该对方发')
    expect(() => initiator.readMessage(new Uint8Array(48))).toThrow('现在该自己发')
    expect(() => new Handshake({ pattern: 'KK', initiator: true, prologue: new Uint8Array(), staticKey: generateKeyPair() })).toThrow('要先知道对方的长期公钥')
    expect(() => new Handshake({ pattern: 'XXpsk3', initiator: true, prologue: new Uint8Array(), staticKey: generateKeyPair(), psk: new Uint8Array(16) })).toThrow('32 字节的预共享密钥')
  })
})

describe('Noise 传输层', () => {
  test('重放、乱序、被改都解密失败，失败后整条通道作废', () => {
    const replay = channel()
    const first = replay.initiator.encrypt(text('一'))
    replay.responder.decrypt(first)
    expect(() => replay.responder.decrypt(first)).toThrow(NoiseError)
    expect(() => replay.responder.decrypt(replay.initiator.encrypt(text('二')))).toThrow('加密通道已经作废')

    const reorder = channel()
    reorder.initiator.encrypt(text('一'))
    expect(() => reorder.responder.decrypt(reorder.initiator.encrypt(text('二')))).toThrow(NoiseError)

    const tamper = channel()
    const message = Buffer.from(tamper.initiator.encrypt(text('三')))
    message[0]! ^= 1
    expect(() => tamper.responder.decrypt(message)).toThrow(NoiseError)
  })

  test('单条明文超过上限要先分片', () => {
    const { initiator, responder } = channel()
    expect(responder.decrypt(initiator.encrypt(new Uint8Array(NOISE_MAX_PAYLOAD))).length).toBe(NOISE_MAX_PAYLOAD)
    expect(() => initiator.encrypt(new Uint8Array(NOISE_MAX_PAYLOAD + 1))).toThrow('要先分片')
  })
})
