import { createHash, createPublicKey, verify } from 'node:crypto'
import { z } from 'zod'

// 设备和中转服务之间的协议。中转只做三件事：认设备（Ed25519 签名挑战，没有账号）、按白名单转发密文、给配对牵线（会合点）。
// 加密通道里的内容中转看不到，也不管（见 @diffra/remote 和 docs/decisions.md「设备连接」）。
// 控制消息是 JSON 文本帧；转发是二进制帧：1 字节种类 + 16 字节对方 ID + 密文。
// 发出时对方 ID 是收件设备或会合 ID，收到时是发件设备。B 的白名单里有 A，A 发给 B 的帧才转

export const RELAY_PROTOCOL = 1
export const RELAY_HOST = 'relay.diffra.dev'
export const RELAY_PATH = '/v1'
export const ID_BYTES = 16
const KEY_BYTES = 32
// 一条 Noise 消息最多 65535 字节
export const MAX_FRAME_BYTES = 1 + ID_BYTES + 65_535
export const MAX_CONTROL_CHARS = 8 * 1024
export const MAX_PEERS = 64
export const RENDEZVOUS_MAX_TTL_SECONDS = 600
const AUTH_CONTEXT = 'diffra-relay-auth/1'
// 原始 32 字节的 Ed25519 公钥套上这个 DER 头就是 SPKI
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex')

export const FRAME = { direct: 1, rendezvous: 2 } as const
export type FrameKind = (typeof FRAME)[keyof typeof FRAME]

// 关连接的原因（WebSocket 关闭码 4000 起是应用自己定的）
export const CLOSE = {
  protocol: { code: 4000, reason: '消息格式不对' },
  replaced: { code: 4001, reason: '同一台设备在别处连上了' },
  authFailed: { code: 4002, reason: '设备签名不对' },
  authTimeout: { code: 4003, reason: '没有及时登录' },
  rateLimited: { code: 4008, reason: '发得太快' },
  full: { code: 4009, reason: '连接太多' },
  version: { code: 4010, reason: '中转协议版本不对，请更新 Diffra' },
  slow: { code: 4011, reason: '接收太慢' },
} as const

const hexId = z.string().regex(/^[0-9a-f]{32}$/)
const key = z.base64().refine((value) => Buffer.from(value, 'base64').length === KEY_BYTES, '要 32 字节')

// 设备发给中转的
export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), protocol: z.number().int(), signingKey: key, noiseKey: key, signature: z.base64().max(200) }),
  // 整份替换：会和哪些设备互通（配对过的；连接端配对时还要先放上被连接端）
  z.object({ type: z.literal('allow'), peers: z.array(hexId).max(MAX_PEERS) }),
  z.object({ type: z.literal('rendezvous-open'), id: hexId, ttlSeconds: z.number().int().min(1).max(RENDEZVOUS_MAX_TTL_SECONDS) }),
  z.object({ type: z.literal('rendezvous-close'), id: hexId }),
  // Node 自带的 WebSocket 客户端发不了 ping 帧，用这个探活
  z.object({ type: z.literal('ping') }),
])

// 中转发给设备的
export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('challenge'), protocol: z.number().int(), nonce: z.base64() }),
  z.object({ type: z.literal('ready'), deviceId: hexId }),
  // 两台设备都在线、互相在白名单里时才告诉对方在线
  z.object({ type: z.literal('presence'), deviceId: hexId, online: z.boolean() }),
  // 对方不在线、没把你放进白名单、会合点不在了或已满，都只说送不到，不说原因
  z.object({ type: z.literal('undeliverable'), to: hexId }),
  z.object({ type: z.literal('rendezvous-opened'), id: hexId }),
  z.object({ type: z.literal('rendezvous-refused'), id: hexId }),
  z.object({ type: z.literal('pong') }),
])

export type ClientMessage = z.infer<typeof clientMessageSchema>
export type ServerMessage = z.infer<typeof serverMessageSchema>

// 设备 ID：两把公钥（签名用的 Ed25519、加密通道用的 X25519）拼起来的 SHA-256 前 16 字节
export function deviceIdOf(signingKey: Uint8Array, noiseKey: Uint8Array): Buffer {
  return createHash('sha256').update(signingKey).update(noiseKey).digest().subarray(0, ID_BYTES)
}

// 登录时签的内容：固定前缀加中转给的随机数
export function authPayload(nonce: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(AUTH_CONTEXT, 'utf8'), Buffer.from([0]), nonce])
}

export function verifyAuth(signingKey: Uint8Array, nonce: Uint8Array, signature: Uint8Array): boolean {
  try {
    return verify(null, authPayload(nonce), createPublicKey({ key: Buffer.concat([SPKI_ED25519, signingKey]), format: 'der', type: 'spki' }), signature)
  } catch {
    return false
  }
}

export function encodeFrame(kind: FrameKind, peer: Uint8Array, payload: Uint8Array): Buffer {
  if (peer.length !== ID_BYTES) throw new Error('对方 ID 要 16 字节')
  return Buffer.concat([Buffer.from([kind]), peer, payload])
}

export function decodeFrame(frame: Uint8Array): { kind: FrameKind; peer: Buffer; payload: Buffer } | null {
  if (frame.length <= 1 + ID_BYTES || frame.length > MAX_FRAME_BYTES) return null
  const kind = frame[0]
  if (kind !== FRAME.direct && kind !== FRAME.rendezvous) return null
  const bytes = Buffer.from(frame.buffer, frame.byteOffset, frame.length)
  return { kind, peer: bytes.subarray(1, 1 + ID_BYTES), payload: bytes.subarray(1 + ID_BYTES) }
}
