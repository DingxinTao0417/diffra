import type { RemoteEvent } from '@diffra/remote/messages'

// 设备连接（docs/decisions.md「设备连接」）：主进程和界面之间交换的状态。
// 被连接端 = 数据所在、「允许连接本机」那台；连接端 = 「连接其他设备」那台

export const REMOTE_LEVELS = ['view', 'control'] as const
export type RemoteLevel = (typeof REMOTE_LEVELS)[number]

export interface RemoteProjectGrant {
  path: string
  level: RemoteLevel
}

export interface RemoteDeviceView {
  deviceId: string
  // 设备 ID 前 5 字节的短码，配对时两边都显示，可以念给对方核对
  fingerprint: string
  name: string
  pairedAt: string
  online: boolean
  // 上一次看到它在线或下线的时刻；还没见过是 null
  lastSeenAt: string | null
}

// 本机授权给它的设备
export interface RemoteGrantView extends RemoteDeviceView {
  projects: RemoteProjectGrant[]
}

// 有设备凭邀请串连上来、等本机的人点允许或拒绝
export interface RemotePairRequest {
  deviceId: string
  fingerprint: string
  name: string
  // 这台设备以前配对过：原来的授权，这次会被替换
  previous: RemoteProjectGrant[] | null
}

export type RemoteRelayStatus = { state: 'off' } | { state: 'connecting' } | { state: 'online' } | { state: 'error'; message: string }

export interface RemoteView {
  // 系统加密不可用时不能开启（私钥没法安全保存）
  unavailable: string | null
  // 还没生成过设备身份时为 null
  self: { deviceId: string; fingerprint: string } | null
  name: string
  allowIncoming: boolean
  relay: RemoteRelayStatus
  invite: { text: string; expiresAt: string } | null
  requests: RemotePairRequest[]
  grants: RemoteGrantView[]
  peers: RemoteDeviceView[]
}

export type RemoteAddResult = { ok: true; device: RemoteDeviceView } | { ok: false; error: string }

// 被连接端推来的动静（已经校验过），或者和它的会话通道断了（界面等它重新在线后重新订阅）
export type RemoteSyncEvent = { deviceId: string; event: RemoteEvent } | { deviceId: string; disconnected: true }

export interface RemoteAuditEntry {
  at: string
  deviceId: string
  name: string
  action: string
}
