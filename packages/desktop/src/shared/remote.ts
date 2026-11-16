import type { PermissionMode, PromptImage, RemoteSource, SessionInfo } from '@diffra/core/types'
import type { RemoteEvent } from '@diffra/remote/messages'
import type { ProjectState } from './ipc'
import type { ModelRef } from './settings'

// 设备连接（docs/decisions.md「设备连接」）：主进程和界面之间交换的状态。
// 被连接端 = 数据所在、「允许连接本机」那台；连接端 = 「连接其他设备」那台

// 2026-11-15 起经中转的互联网版整体下线（网络安全问题尚未彻底解决）；v2 起只在局域网里直连（docs/decisions.md「局域网设备连接」）。
// 互联网中转要恢复时把 DEVICE_TRANSPORT 改回 relay，并同时恢复官网隐私政策和快速开始的说明（「设备连接下线」）
export const REMOTE_DEVICE_CONNECTION_ENABLED = true
export const DEVICE_TRANSPORT: 'lan' | 'relay' = 'lan'

// 被连接端在列表里报的设备连接接口版本：2 起认 session.details、session.diff 这些新请求（0.3.x 不报，按 1 算）。
// 连接端按它决定发不发新请求：老版本被连接端收到不认识的请求会当成格式不对、断开通道
export const REMOTE_API = 3

// 「完全控制」包含「可查看和操作」，再加上开终端、把权限模式切成「完全访问」：等于在本机执行任意命令，不限于开放的项目
export const REMOTE_LEVELS = ['view', 'control', 'full'] as const
export type RemoteLevel = (typeof REMOTE_LEVELS)[number]
export const REMOTE_LEVEL_LABELS: Record<RemoteLevel, string> = { view: '可查看', control: '可查看和操作', full: '完全控制' }

export function canControl(level: RemoteLevel): boolean {
  return level !== 'view'
}

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

// 本机授权给它的设备。terminals：它在本机开着几个终端（「完全控制」）；watching：它正在看的任务标题；lastActionAt：最近一次操作的时刻（毫秒）
export interface RemoteGrantView extends RemoteDeviceView {
  projects: RemoteProjectGrant[]
  // 允许它同步待办（v2）
  todos: boolean
  terminals: number
  watching: string[]
  lastActionAt: number | null
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
  // 局域网版：invite.text 是 6 位配对码
  invite: { text: string; expiresAt: string } | null
  requests: RemotePairRequest[]
  grants: RemoteGrantView[]
  peers: RemotePeerView[]
  // 局域网版（v2）：本机证书的指纹（配对时给对方核对）和局域网里看到的设备；中转版是 null
  lan: { certificate: string | null; discovered: RemoteDiscoveredDevice[] } | null
}

// 局域网里看到的一台设备（发现服务报的，谁都能冒充；配对时核对证书指纹）
export interface RemoteDiscoveredDevice {
  deviceId: string
  name: string
  // 设备 ID 的指纹和证书指纹，给人看的写法
  fingerprint: string
  certificate: string
  address: string
  // 对方生成了配对码，正等着配对
  pairing: boolean
  // 已经是本机连接的设备
  paired: boolean
}

// 本机去连的设备：和它同步待办（v2）、上次同步的时刻和没成的原因
export interface RemotePeerView extends RemoteDeviceView {
  todos: boolean
  todosSync: { at: string | null; error: string | null }
}

export type RemoteAddResult = { ok: true; device: RemoteDeviceView } | { ok: false; error: string }

// 被连接端推来的动静（已经校验过），或者和它的会话通道断了（界面等它重新在线后重新订阅），
// 或者它明确拒绝本机建通道：关了「允许连接本机」（off）、没授权或撤销了本机（not-granted）。互相配对时对方在中转上仍显示在线
export type RemoteSyncEvent =
  | { deviceId: string; event: RemoteEvent }
  | { deviceId: string; disconnected: true }
  | { deviceId: string; refused: 'off' | 'not-granted'; message: string }

// 被连接端：远程设备要做的操作，主进程交给界面去做（和任务互通同一条路：界面发送前自己建新的一轮，主进程直接调 core 的话这一轮会串进上一轮）
export type RemoteAction =
  | { kind: 'send'; sessionId: string; text: string; skills: string[]; source: RemoteSource; plan?: boolean; goal?: boolean; images?: PromptImage[] }
  | { kind: 'create'; project: string; text: string; skills: string[]; source: RemoteSource }
  | { kind: 'cancel'; sessionId: string }

// 远程设备读、操作一个任务：主进程查过级别以后交给本机界面做（界面在后台载入这个任务，用本机的逻辑，见 state/actions.ts 的 handleRemoteTaskCall），
// 主进程再把结果脱敏后发回去
export type RemoteTaskCall =
  | { kind: 'details'; sessionId: string }
  | { kind: 'diff'; sessionId: string; turnId: string }
  | { kind: 'models' }
  | { kind: 'skills' | 'commands' | 'compact'; sessionId: string }
  | { kind: 'setModel'; sessionId: string; ref: ModelRef }
  | { kind: 'setPermissionMode'; sessionId: string; mode: PermissionMode }
  | { kind: 'regenerate' | 'restorePreview' | 'restore'; sessionId: string; turnId: string }
export type RemoteTaskCallResult = { ok: true; value: unknown } | { ok: false; error: string }

// details 的回答：任务页要的配置（本机界面里这个任务的样子），主进程整理、脱敏后发出去
export interface RemoteTaskDetails {
  info: SessionInfo
  modelLabel: string
  modelRef?: ModelRef
  planLabel: string | null
  fallbackLabel: string | null
  permissionMode: PermissionMode
  planMode: boolean
  branch: string | null
  project: ProjectState | null
}

// queued：对方正在跑，消息排在这一轮后面
export type RemoteActionResult = { ok: true; sessionId: string; queued: boolean } | { ok: false; error: string }

export interface RemoteAuditEntry {
  at: string
  deviceId: string
  name: string
  action: string
}
