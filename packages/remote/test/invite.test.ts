import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { createInvite, decodeInvite, encodeInvite, fingerprintOf, InviteError, pairingPskOf, rendezvousIdOf } from '../src/invite.js'
import { randomBytes, seeded } from './random.js'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const fixed = { secret: Buffer.alloc(16, 0xa5), deviceId: Buffer.from('00112233445566778899aabbccddeeff', 'hex') }
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex')

// 按邀请串的格式手工拼一个（用来造版本号不对、但校验正确的串）
function craft(body: Buffer): string {
  const bytes = Buffer.concat([body, createHash('sha256').update(body).digest().subarray(0, 2)])
  let bits = ''
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0')
  const chars = (bits.match(/.{1,5}/g) ?? []).map((group) => ALPHABET[parseInt(group.padEnd(5, '0'), 2)])
  return `diffra-${chars.join('')}`
}

describe('邀请串', () => {
  test('编码后能原样解出；格式是 diffra- 加 4 个一组的 Crockford Base32', () => {
    const text = encodeInvite(fixed)
    expect(text).toMatch(/^diffra-(?:[0-9A-HJKMNP-TV-Z]{4}-){13}[0-9A-HJKMNP-TV-Z]{4}$/)
    const decoded = decodeInvite(text)
    expect(hex(decoded.secret)).toBe(hex(fixed.secret))
    expect(hex(decoded.deviceId)).toBe(hex(fixed.deviceId))
  })

  test('不计较大小写、空白、连字符，O 当 0、I 和 L 当 1', () => {
    const text = encodeInvite(fixed)
    const sloppy = `  ${text.toLowerCase().replace(/-/g, ' ')}\n`
    expect(hex(decodeInvite(sloppy).secret)).toBe(hex(fixed.secret))
    const data = text.slice('diffra-'.length)
    const aliased = `diffra-${data.replace(/0/g, 'O').replace(/1/g, 'l')}`
    expect(hex(decodeInvite(aliased).deviceId)).toBe(hex(fixed.deviceId))
  })

  test('任何一个字符抄错都认得出来', () => {
    const text = encodeInvite(fixed)
    const start = 'diffra-'.length
    for (let index = start; index < text.length; index++) {
      if (text[index] === '-') continue
      for (const char of ALPHABET) {
        if (char === text[index]) continue
        const typo = text.slice(0, index) + char + text.slice(index + 1)
        expect(() => decodeInvite(typo), typo).toThrow(InviteError)
      }
    }
  })

  test('少字、多字、不是邀请串、有不认识的字符、版本不对都报错', () => {
    const text = encodeInvite(fixed)
    expect(() => decodeInvite(text.slice(0, -1))).toThrow('没复制全')
    expect(() => decodeInvite(`${text}0`)).toThrow('没复制全')
    expect(() => decodeInvite(text.replace('diffra-', 'qoder-'))).toThrow('不是 Diffra 的邀请串')
    expect(() => decodeInvite(`${text.slice(0, -1)}U`)).toThrow('不认识的字符')
    expect(() => decodeInvite(craft(Buffer.concat([Buffer.from([2]), fixed.secret, fixed.deviceId])))).toThrow('不兼容的 Diffra 版本')
    // 自己拼的版本 1 能解，说明上面报错的确实是版本
    expect(hex(decodeInvite(craft(Buffer.concat([Buffer.from([1]), fixed.secret, fixed.deviceId]))).secret)).toBe(hex(fixed.secret))
  })

  test('乱输入只会报邀请串的错', () => {
    const next = seeded(20261110)
    for (let round = 0; round < 2000; round++) {
      const length = Math.floor(next() * 90)
      const input = `diffra-${Array.from({ length }, () => String.fromCharCode(32 + Math.floor(next() * 95))).join('')}`
      try {
        decodeInvite(input)
      } catch (error) {
        expect(error, input).toBeInstanceOf(InviteError)
      }
    }
    for (let round = 0; round < 500; round++) {
      const input = randomBytes(next, Math.floor(next() * 80)).toString('latin1')
      try {
        decodeInvite(input)
      } catch (error) {
        expect(error).toBeInstanceOf(InviteError)
      }
    }
  })

  test('指纹短码是设备 ID 前 5 字节，4 个一组', () => {
    // 00 11 22 33 44 按 5 位切开是 0 0 8 18 4 12 26 4
    expect(fingerprintOf(fixed.deviceId)).toBe('008J-4CT4')
    expect(fingerprintOf(Buffer.alloc(16, 0xff))).toBe('ZZZZ-ZZZZ')
    expect(() => fingerprintOf(new Uint8Array(8))).toThrow('16 字节')
  })

  test('每次生成的密钥不同；会合 ID 和预共享密钥由密钥确定推出，彼此不同', () => {
    const first = createInvite(fixed.deviceId)
    const second = createInvite(fixed.deviceId)
    expect(first.secret).toHaveLength(16)
    expect(hex(first.secret)).not.toBe(hex(second.secret))
    expect(rendezvousIdOf(fixed.secret)).toHaveLength(16)
    expect(pairingPskOf(fixed.secret)).toHaveLength(32)
    expect(hex(rendezvousIdOf(fixed.secret))).toBe(hex(rendezvousIdOf(Buffer.from(fixed.secret))))
    expect(hex(pairingPskOf(fixed.secret)).startsWith(hex(rendezvousIdOf(fixed.secret)))).toBe(false)
    expect(hex(rendezvousIdOf(first.secret))).not.toBe(hex(rendezvousIdOf(second.secret)))
    expect(() => createInvite(new Uint8Array(8))).toThrow('16 字节')
  })
})
