import { deflateRawSync } from 'node:zlib'
import { describe, expect, test } from 'vitest'
import { encodeMessage, FrameError, MAX_INFLATED_BYTES, MAX_MESSAGE_BYTES, MessageAssembler } from '../src/frames.js'
import { generateKeyPair, Handshake, NOISE_MAX_MESSAGE, NOISE_MAX_PAYLOAD } from '../src/noise.js'
import { randomBytes, seeded } from './random.js'

function receive(chunks: Uint8Array[]): unknown {
  const assembler = new MessageAssembler()
  let result: unknown
  chunks.forEach((chunk, index) => {
    result = assembler.push(chunk)
    // 最后一片之前都还没拼齐
    if (index < chunks.length - 1) expect(result).toBeUndefined()
  })
  return result
}

describe('消息分片', () => {
  test('小消息一片；大消息切成不超过 Noise 上限的多片，只有最后一片带结束标记，拼回来一样', () => {
    const small = encodeMessage({ type: 'hello' })
    expect(small).toHaveLength(1)
    expect(small[0]![0]).toBe(0b01)
    expect(receive(small)).toEqual({ type: 'hello' })

    const big = { text: 'x'.repeat(300_000), list: Array.from({ length: 1000 }, (_, index) => index) }
    const chunks = encodeMessage(big)
    expect(chunks.length).toBeGreaterThan(4)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(NOISE_MAX_PAYLOAD)
    expect(chunks.map((chunk) => chunk[0])).toEqual([...Array(chunks.length - 1).fill(0), 0b01])
    expect(receive(chunks)).toEqual(big)
  })

  test('压缩的消息每片都带压缩标记，拼回来一样；同一个拼装器能接着收下一条', () => {
    const value = { turns: Array.from({ length: 200 }, (_, index) => ({ id: `turn-${index}`, prompt: '重复的内容'.repeat(50) })) }
    const plain = encodeMessage(value)
    const compressed = encodeMessage(value, { compress: true })
    expect(compressed.length).toBeLessThan(plain.length)
    for (const chunk of compressed) expect(chunk[0]! & 0b10).toBe(0b10)
    const assembler = new MessageAssembler()
    let result: unknown
    for (const chunk of compressed) result = assembler.push(chunk)
    expect(result).toEqual(value)
    expect(assembler.push(encodeMessage({ next: true })[0]!)).toEqual({ next: true })
  })

  test('每片单独加密、按顺序解密后拼回原消息', () => {
    const initiatorKey = generateKeyPair()
    const responderKey = generateKeyPair()
    const prologue = Buffer.from('diffra-remote/1')
    const initiator = new Handshake({ pattern: 'KK', initiator: true, prologue, staticKey: initiatorKey, remoteStatic: responderKey.publicKey })
    const responder = new Handshake({ pattern: 'KK', initiator: false, prologue, staticKey: responderKey, remoteStatic: initiatorKey.publicKey })
    responder.readMessage(initiator.writeMessage())
    initiator.readMessage(responder.writeMessage())
    const sending = initiator.split()
    const receiving = responder.split()
    const value = { page: 'y'.repeat(200_000) }
    const assembler = new MessageAssembler()
    let result: unknown
    for (const chunk of encodeMessage(value, { compress: true })) result = assembler.push(receiving.decrypt(sending.encrypt(chunk)))
    expect(result).toEqual(value)
  })

  test('整片加密后比 Noise 上限少 1 字节，留给桌面端加的通道种类：再加上中转帧头（1 字节类型、16 字节 ID）正好是中转的单帧上限', () => {
    const initiatorKey = generateKeyPair()
    const responderKey = generateKeyPair()
    const prologue = Buffer.from('diffra-remote/1')
    const initiator = new Handshake({ pattern: 'KK', initiator: true, prologue, staticKey: initiatorKey, remoteStatic: responderKey.publicKey })
    const responder = new Handshake({ pattern: 'KK', initiator: false, prologue, staticKey: responderKey, remoteStatic: initiatorKey.publicKey })
    responder.readMessage(initiator.writeMessage())
    initiator.readMessage(responder.writeMessage())
    const sending = initiator.split()
    const sizes = encodeMessage({ data: randomBytes(seeded(7), 200_000).toString('base64') }, { compress: true }).map((chunk) => sending.encrypt(chunk).length)
    expect(sizes.length).toBeGreaterThan(2)
    expect(sizes[0]).toBe(NOISE_MAX_MESSAGE - 1)
    for (const size of sizes) expect(1 + 16 + 1 + size).toBeLessThanOrEqual(1 + 16 + 65_535)
  })

  test('坏分片直接报错：空片、不认识的标记、同一条消息标记不一致、不是 JSON', () => {
    expect(() => new MessageAssembler().push(new Uint8Array())).toThrow('空的分片')
    expect(() => new MessageAssembler().push(Buffer.from([0b100, 1]))).toThrow('不认识的分片标记')
    const mixed = new MessageAssembler()
    mixed.push(Buffer.from([0b00, 0x7b]))
    expect(() => mixed.push(Buffer.from([0b11, 0x7d]))).toThrow('标记不一致')
    expect(() => new MessageAssembler().push(Buffer.concat([Buffer.from([0b01]), Buffer.from('{oops')]))).toThrow('不是合法的 JSON')
  })

  test('拼起来超过上限、解压后超过上限都报错；发的时候太大也报错', () => {
    const assembler = new MessageAssembler()
    const piece = Buffer.concat([Buffer.from([0]), Buffer.alloc(NOISE_MAX_PAYLOAD - 1)])
    expect(() => {
      for (let sent = 0; sent <= MAX_MESSAGE_BYTES; sent += piece.length - 1) assembler.push(piece)
    }).toThrow('消息太大')

    // 几十 KB 的压缩数据解出来超过 32 MB
    const bomb = deflateRawSync(Buffer.alloc(MAX_INFLATED_BYTES + 1024, 0x20))
    expect(bomb.length).toBeLessThan(NOISE_MAX_PAYLOAD)
    expect(() => new MessageAssembler().push(Buffer.concat([Buffer.from([0b11]), bomb]))).toThrow('解压后太大')

    expect(() => encodeMessage({ text: 'z'.repeat(MAX_MESSAGE_BYTES) })).toThrow('要分页发')
  })

  test('乱给的分片只会报分片的错', () => {
    const next = seeded(42)
    for (let round = 0; round < 3000; round++) {
      const assembler = new MessageAssembler()
      const chunk = randomBytes(next, 1 + Math.floor(next() * 200))
      try {
        assembler.push(chunk)
      } catch (error) {
        expect(error).toBeInstanceOf(FrameError)
      }
    }
  })
})
