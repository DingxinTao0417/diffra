// core 与桌面端共用的纯类型和常量（桌面端界面也会引用，不能依赖 Node API）。
import type { ModelEndpoint } from './models/types.js'

export * from './models/types.js'
export type {
  PermissionOption,
  RequestPermissionRequest,
  SessionNotification,
  SessionUpdate,
  StopReason,
  ToolCallContent,
  ToolCallStatus,
  ToolKind,
} from '@agentclientprotocol/sdk'

export interface SessionChecks {
  // 某一步改了文件后自动跑的快速检查，比如 pnpm typecheck
  afterEdit: string | null
  // 模型调用 finish 时跑的完整检查，比如 pnpm test；不填就用 afterEdit
  beforeFinish: string | null
}

// session/new 的 _meta.diffra
export interface SessionConfig {
  model: { endpoint: ModelEndpoint; modelId: string; contextWindow: number | null }
  checks: SessionChecks
  // 禁写目录（相对项目根目录），比如用户的数据目录：agent 不能改，检查点也不碰
  readOnlyPaths: string[]
  // 检查点仓库的位置；null 表示不打检查点
  checkpointDir: string | null
}

// session/new 响应的 _meta.diffra
export interface SessionInfo {
  bashPath: string | null
  checkpoints: boolean
}

export interface CheckpointChange {
  path: string
  change: 'added' | 'modified' | 'deleted'
}

export const SESSION_EXT_METHODS = {
  checkpointPreview: '_diffra/checkpoint/preview',
  checkpointRestore: '_diffra/checkpoint/restore',
} as const

export const PERMISSION_OPTIONS = {
  allowOnce: 'allow_once',
  allowAlways: 'allow_always',
  reject: 'reject',
} as const
