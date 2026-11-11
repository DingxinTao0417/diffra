import { createHash, hkdfSync, randomBytes } from 'node:crypto'

// 配对邀请串：被连接端生成，连接端粘贴。里面是格式版本、16 字节一次性密钥和被连接端的设备 ID（公钥哈希，16 字节），
// 再加 2 字节校验（只防抄错，防伪靠握手）。用 Crockford Base32 编码，前缀 diffra-，每 4 个字符一个连字符。
// 连接端握手后核对对方长期公钥对得上设备 ID，服务器就做不了中间人；会合 ID 和预共享密钥都从密钥推出来，服务器拿到会合 ID 也推不回密钥

export const INVITE_VERSION = 1
const SECRET_LEN = 16
const DEVICE_ID_LEN = 16
const CHECK_LEN = 2
const PREFIX = 'diffra-'
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export interface Invite {
  secret: Uint8Array
  deviceId: Uint8Array
}

export class InviteError extends Error {}

export function createInvite(deviceId: Uint8Array): Invite {
  if (deviceId.length !== DEVICE_ID_LEN) throw new InviteError('设备 ID 要 16 字节')
  return { secret: randomBytes(SECRET_LEN), deviceId: Buffer.from(deviceId) }
}

export function encodeInvite(invite: Invite): string {
  if (invite.secret.length !== SECRET_LEN || invite.deviceId.length !== DEVICE_ID_LEN) throw new InviteError('邀请的密钥和设备 ID 都要 16 字节')
  const body = Buffer.concat([Buffer.from([INVITE_VERSION]), invite.secret, invite.deviceId])
  const groups = base32(Buffer.concat([body, checksum(body)])).match(/.{1,4}/g) ?? []
  return PREFIX + groups.join('-')
}

// 大小写、空白、连字符都不计较，O 当 0、I 和 L 当 1
export function decodeInvite(text: string): Invite {
  const compact = text.trim().toUpperCase().replace(/[\s-]/g, '')
  const prefix = PREFIX.replace('-', '').toUpperCase()
  if (!compact.startsWith(prefix)) throw new InviteError('这不是 Diffra 的邀请串')
  const bodyLength = 1 + SECRET_LEN + DEVICE_ID_LEN
  // 按字符数比：多出来的一个字符只有 5 位，凑不满一个字节，按字节数比会被悄悄丢掉
  if (compact.length - prefix.length !== Math.ceil(((bodyLength + CHECK_LEN) * 8) / 5)) throw new InviteError('邀请串长度不对，可能没复制全')
  const bytes = fromBase32(compact.slice(prefix.length))
  const body = bytes.subarray(0, bodyLength)
  if (!checksum(body).equals(bytes.subarray(bodyLength))) throw new InviteError('邀请串有字符抄错了')
  if (body[0] !== INVITE_VERSION) throw new InviteError('邀请串来自不兼容的 Diffra 版本，请两边都更新到最新')
  return { secret: Buffer.from(body.subarray(1, 1 + SECRET_LEN)), deviceId: Buffer.from(body.subarray(1 + SECRET_LEN)) }
}

// 拿去服务器登记、牵线用的会合 ID
export function rendezvousIdOf(secret: Uint8Array): Uint8Array {
  return derive(secret, 'diffra pairing rendezvous', 16)
}

// XXpsk3 握手的预共享密钥
export function pairingPskOf(secret: Uint8Array): Uint8Array {
  return derive(secret, 'diffra pairing psk', 32)
}

function derive(secret: Uint8Array, info: string, length: number): Uint8Array {
  if (secret.length !== SECRET_LEN) throw new InviteError('邀请密钥要 16 字节')
  return Buffer.from(hkdfSync('sha256', secret, new Uint8Array(0), info, length))
}

function checksum(body: Uint8Array): Buffer {
  return createHash('sha256').update(body).digest().subarray(0, CHECK_LEN)
}

function base32(bytes: Uint8Array): string {
  let output = ''
  let bits = 0
  let value = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
    value &= (1 << bits) - 1
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31]
  return output
}

function fromBase32(text: string): Buffer {
  const bytes: number[] = []
  let bits = 0
  let value = 0
  for (const char of text.replace(/O/g, '0').replace(/[IL]/g, '1')) {
    const digit = ALPHABET.indexOf(char)
    if (digit < 0) throw new InviteError(`邀请串里有不认识的字符「${char}」`)
    value = (value << 5) | digit
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
    value &= (1 << bits) - 1
  }
  return Buffer.from(bytes)
}
