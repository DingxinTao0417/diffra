// core 与桌面端共用的纯类型和常量（桌面端界面也会引用，不能依赖 Node API）。
import type { SessionUpdate, StopReason } from '@agentclientprotocol/sdk'
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

// 命令权限：ask 只读命令和检查命令以外都问；auto 只问有风险的命令；full 不再询问。
// 三档都一样的：危险命令直接拒绝，提到密钥文件、改禁写目录的命令要用户确认
export type PermissionMode = 'ask' | 'auto' | 'full'

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

// 模型所在的供应商，只用来记用量；没有时（比如测试）记成 null
export interface ModelProvider {
  id: string
  name: string
}

// 完成前的安全检查：静态检查按规则匹配本轮新增的代码，轻量扫描用评审模型审查本轮改动
export interface SessionSecurity {
  staticCheck: boolean
  lightScan: boolean
}

// session/new 的 _meta.diffra
export interface SessionConfig {
  model: { endpoint: ModelEndpoint; modelId: string; contextWindow: number | null; provider: ModelProvider | null }
  // 「评审」角色的模型；null 时审查用编码模型
  reviewModel: { endpoint: ModelEndpoint; modelId: string; provider: ModelProvider | null } | null
  checks: SessionChecks
  // 禁写目录（相对项目根目录），比如用户的数据目录：agent 不能改，检查点也不碰
  readOnlyPaths: string[]
  rules: SessionRules
  permissionMode: PermissionMode
  security: SessionSecurity
  // 检查点仓库的位置；null 表示不打检查点
  checkpointDir: string | null
}

// session/new 响应的 _meta.diffra
export interface SessionInfo {
  bashPath: string | null
  checkpoints: boolean
  // 按项目语言选中、写进提示词的规则包名称
  rulePacks: string[]
  // 这个会话实际生效的安全检查开关（建会话时的设置）
  security: SessionSecurity
}

export interface CheckpointChange {
  path: string
  change: 'added' | 'modified' | 'deleted'
}

// usage_update 的 _meta.diffra：上下文里各部分的估算 token 数，合计等于模型返回的输入 token 数
export interface UsageBreakdown {
  system: number
  // 项目规则（AGENTS.md 等）和编码规范
  rules: number
  tools: number
  messages: number
}

// 存下来的一轮：界面重建这一轮要用的会话更新，按收到的顺序
// 普通的一轮提问，或者用户发起的深度安全扫描
export type TurnKind = 'prompt' | 'deep-scan'

export interface StoredTurn {
  id: string
  kind: TurnKind
  prompt: string
  startedAt: string
  endedAt: string | null
  // 还没结束就被打断（比如应用退出）时为 null
  stopReason: StopReason | null
  updates: SessionUpdate[]
}

// session/load 响应的 _meta.diffra
export interface LoadedSession {
  info: SessionInfo
  title: string
  turns: StoredTurn[]
}

// session/list 里每个会话 _meta.diffra 带的字段
export interface StoredSessionMeta {
  createdAt: string
  archived: boolean
  turnCount: number
}

// 客户端整理后的会话列表项
export interface StoredSessionSummary extends StoredSessionMeta {
  sessionId: string
  cwd: string
  title: string
  updatedAt: string
}

export interface SessionSearchResult {
  sessionId: string
  cwd: string
  title: string
  updatedAt: string
  // 命中位置附近的一小段文字
  snippet: string
}

// 从项目文件里识别出的一条检查命令
export interface DetectedCheck {
  kind: 'typecheck' | 'lint' | 'test'
  command: string
  // 为什么选它，确认时给用户看
  source: string
  // 来自 package.json 脚本时是脚本的内容：检查命令运行时不再确认，保存前要让用户看到实际会跑什么
  script: string | null
}

export interface CheckDetection {
  checks: DetectedCheck[]
  // 建议的快速检查（类型检查、lint）和完成检查（再加测试）
  afterEdit: string | null
  beforeFinish: string | null
  // 跳过了什么、为什么
  notes: string[]
}

export interface CheckRunResult {
  passed: boolean
  summary: string
}

export type ModelRole = 'coder' | 'reviewer'

// 用量记录的一行：一次模型调用。时间是调用结束时的 UTC 时刻；供应商没返回的数记成 null
export interface UsageRecord {
  v: 1
  at: string
  sessionId: string
  cwd: string
  providerId: string | null
  providerName: string | null
  modelId: string
  role: ModelRole
  // 输入总数，包含缓存命中的部分
  input: number | null
  cacheRead: number | null
  cacheWrite: number | null
  // 输出总数，包含推理的部分
  output: number | null
  reasoning: number | null
}

export interface UsageTotals {
  calls: number
  // 供应商没返回用量的调用次数
  unknownCalls: number
  input: number
  cacheRead: number
  output: number
  reasoning: number
}

// 统计范围 [from, to)，按 timeZone 的日界分天
export interface UsageQuery {
  from: string
  to: string
  timeZone: string
}

export interface UsageSummary {
  totals: UsageTotals
  // 范围内的每一天（没有调用的天也在，数都是 0），日期是 timeZone 下的 YYYY-MM-DD
  days: Array<UsageTotals & { date: string }>
  models: Array<UsageTotals & { providerId: string | null; providerName: string | null; modelId: string }>
  projects: Array<UsageTotals & { cwd: string }>
  // 用量最多的几个任务
  tasks: Array<UsageTotals & { sessionId: string; cwd: string }>
  // 读到的格式不对的行（比如进程崩溃留下的半行）
  skippedLines: number
}

export const SESSION_EXT_METHODS = {
  checkpointPreview: '_diffra/checkpoint/preview',
  checkpointRestore: '_diffra/checkpoint/restore',
  // 重命名、归档
  sessionUpdate: '_diffra/session/update',
  sessionSearch: '_diffra/session/search',
  // 会话中途切换模型、权限模式
  sessionConfigure: '_diffra/session/configure',
  // 重新生成：撤掉某一轮及之后的文件改动和对话
  sessionRewind: '_diffra/session/rewind',
  checkpointDiff: '_diffra/checkpoint/diff',
  usageSummary: '_diffra/usage/summary',
  projectDetectChecks: '_diffra/project/detect-checks',
  projectRunCheck: '_diffra/project/run-check',
  deepScan: '_diffra/security/deep-scan',
} as const

export const PERMISSION_OPTIONS = {
  allowOnce: 'allow_once',
  allowAlways: 'allow_always',
  reject: 'reject',
} as const
