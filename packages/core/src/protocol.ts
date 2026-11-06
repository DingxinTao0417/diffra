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

export type RuleLevel = 'required' | 'recommended'

export interface Rule {
  id: string
  level: RuleLevel
  // 规则包里的小节标题，比如「异常」
  section: string | null
  text: string
}

// 编码规范的规则包：内置的在 packages/core/rules/packs，用户也可以导入自己写的 markdown
export interface RulePack {
  id: string
  name: string
  // 适用的语言，['*'] 表示不分语言
  languages: string[]
  source: string
  license: string
  rules: Rule[]
}

export interface SessionRules {
  // 已经按项目设置过滤好的规则包；core 再按项目里出现的语言挑选
  packs: RulePack[]
  // 完成前用评审模型按规则审查这一轮的改动
  review: boolean
}

// session/new 的 _meta.diffra
export interface SessionConfig {
  model: { endpoint: ModelEndpoint; modelId: string; contextWindow: number | null }
  // 「评审」角色的模型；null 时审查用编码模型
  reviewModel: { endpoint: ModelEndpoint; modelId: string } | null
  checks: SessionChecks
  // 禁写目录（相对项目根目录），比如用户的数据目录：agent 不能改，检查点也不碰
  readOnlyPaths: string[]
  rules: SessionRules
  // 检查点仓库的位置；null 表示不打检查点
  checkpointDir: string | null
}

// session/new 响应的 _meta.diffra
export interface SessionInfo {
  bashPath: string | null
  checkpoints: boolean
  // 按项目语言选中、写进提示词的规则包名称
  rulePacks: string[]
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
