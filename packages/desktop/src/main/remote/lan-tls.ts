import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign, X509Certificate } from 'node:crypto'
import { isIPv4, isIPv6 } from 'node:net'

// 局域网设备连接（v2 · M6）用的 TLS：每台设备一张自签证书（ECDSA P-256），不找 CA，配对时两边核对、记住对方证书的指纹（SHA-256），
// 以后只认这张证书。Node 只能读证书不能签证书，这里按 X.509 的 DER 格式自己拼一张最小的（没有扩展，TLS 1.3 照样用）。
// 不引 Electron，scripts/lan.test.ts 直接测

function length(size: number): Buffer {
  if (size < 0x80) return Buffer.from([size])
  const bytes: number[] = []
  for (let rest = size; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

const tlv = (tag: number, content: Buffer) => Buffer.concat([Buffer.from([tag]), length(content.length), content])
const sequence = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items))

function oid(text: string): Buffer {
  const [first = 0, second = 0, ...rest] = text.split('.').map(Number)
  const bytes = [first * 40 + second]
  for (const part of rest) {
    const chunk: number[] = [part & 0x7f]
    for (let value = part >> 7; value > 0; value >>= 7) chunk.unshift((value & 0x7f) | 0x80)
    bytes.push(...chunk)
  }
  return tlv(0x06, Buffer.from(bytes))
}

// 正整数：最高位是 1 时前面补 0，免得被读成负数
function integer(bytes: Buffer): Buffer {
  return tlv(0x02, bytes[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes)
}

function utcTime(date: Date): Buffer {
  const pad = (value: number) => String(value).padStart(2, '0')
  const text = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  return tlv(0x17, Buffer.from(text, 'ascii'))
}

const ECDSA_WITH_SHA256 = sequence(oid('1.2.840.10045.4.3.2'))

function name(commonName: string): Buffer {
  return sequence(tlv(0x31, sequence(oid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName, 'utf8')))))
}

export interface LanCertificate {
  // PEM
  cert: string
  key: string
  fingerprint: string
}

// 自签证书：从昨天起有效到 2049 年底（UTCTime 只到 2049）
export function createLanCertificate(commonName: string, keys?: { privateKey: KeyObject; publicKey: KeyObject }): LanCertificate {
  const { privateKey, publicKey } = keys ?? generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const notBefore = new Date(Date.now() - 24 * 3600_000)
  const notAfter = new Date(Date.UTC(2049, 11, 31, 23, 59, 59))
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const serial = randomBytes(16)
  serial[0] = serial[0]! & 0x7f
  const tbs = sequence(tlv(0xa0, integer(Buffer.from([2]))), integer(serial), ECDSA_WITH_SHA256, name(commonName), sequence(utcTime(notBefore), utcTime(notAfter)), name(commonName), spki)
  const signature = sign('sha256', tbs, privateKey)
  const der = sequence(tbs, ECDSA_WITH_SHA256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])))
  const cert = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/.{1,64}/g, '$&\n')}-----END CERTIFICATE-----\n`
  return { cert, key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), fingerprint: certificateFingerprint(der) }
}

// 证书指纹：DER 的 SHA-256，小写十六进制
export function certificateFingerprint(der: Buffer): string {
  return createHash('sha256').update(der).digest('hex')
}

export function fingerprintOfPem(pem: string): string {
  return certificateFingerprint(new X509Certificate(pem).raw)
}

// 给人看的指纹：前 16 个十六进制字符，4 个一组
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, 16).toUpperCase().replace(/(.{4})(?=.)/g, '$1 ')
}

// 只连局域网：10/8、172.16/12、192.168/16、169.254/16（链路本地）、127/8（本机，测试用），IPv6 的 fc00::/7、fe80::/10、::1，
// 以及 IPv4 映射成 IPv6 的这些。别的（公网地址、组播、未指定）一律不认
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (mapped) return isPrivateAddress(mapped[1]!)
  if (isIPv4(address)) {
    const [a = 0, b = 0] = address.split('.').map(Number)
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 127
  }
  if (isIPv6(address)) {
    const lower = address.toLowerCase().split('%')[0]!
    if (lower === '::1') return true
    const first = parseInt(lower.split(':')[0] || '0', 16)
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80
  }
  return false
}
