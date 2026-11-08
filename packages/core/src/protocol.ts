// core 与桌面端共用的纯类型和常量（桌面端界面也会引用，不能依赖 Node API）。
import type { McpServer, SessionUpdate, StopReason } from '@agentclientprotocol/sdk'
import type { ModelEndpoint } from './models/types.js'

export * from './models/types.js'
export type {
  McpServer,
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

// 单次任务的上限：上下文用到窗口的百分之多少时压缩；最多跑多少步，null 不限（靠卡死检测兜底）
export interface SessionLimits {
  compactAtPercent: number
  maxSteps: number | null
  // 目标模式最多自主推进几轮
  goalMaxRounds: number
}

export const TASK_PROGRESS_META_KEY = 'taskState'
export interface TaskProgressView {
  status: 'running' | 'waiting' | 'blocked' | 'cancelled' | 'completed'
  reason: string | null
  requirements: Array<{ id: string; title: string; receiptId: string | null }>
  // 有改动还没经过完成门禁（撤销之后、或带着未验证的改动停下）
  needsVerification?: boolean
}

// 检查命令、静态检查、轻量扫描、规范审查卡片结束时的 tool_call_update._meta.diffra.result。ACP 的 status 照旧：
// warned 只有提醒或附注；partial 只看了一部分（改动被截断、依赖审计没跑完）；error 工具或评审模型出错，这次不拦截
export type CheckResult = 'passed' | 'warned' | 'partial' | 'error' | 'failed'
// 完成卡和 verify_changes 卡的 _meta.diffra.verification；reused 是复用了这份工作区已经通过的验证
export type FinishVerification = 'verified' | 'reused' | 'unverified' | 'no-edits' | 'failed'
// 一轮结束时的 session_info_update._meta.diffra.turnOutcome，和 taskState 在同一条更新里，每轮只发一次。
// finish 是本轮所有被接受的 finish 合并后的值（unverified > verified > no-edits，reused 算 verified），没有被接受的 finish 为 null；
// stop 是没走到「finish 被接受」就停下的原因，正常结束为 null
export const TURN_OUTCOME_META_KEY = 'turnOutcome'
export type TurnStop = 'paused' | 'cancelled' | 'no-finish' | 'gate-exhausted' | 'check-exhausted' | 'stuck' | 'model-error' | 'step-limit' | 'context-limit' | 'goal-exhausted'
export interface TurnOutcome {
  finish: 'verified' | 'unverified' | 'no-edits' | null
  stop: TurnStop | null
}

export const TERMINAL_DEFAULT_LINES = 80
export const TERMINAL_MAX_LINES = 200
export const TERMINAL_READ_PERMISSION_PREFIX = 'terminal-read:'
// 截图时可以指定的视口宽度范围（CSS 像素），从小屏手机到常见桌面
export const SCREENSHOT_MIN_WIDTH = 320
export const SCREENSHOT_MAX_WIDTH = 1920
export const EXTERNAL_ACCESS_SCOPE = 'exact-path'

export const REASONING_EFFORTS = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

export interface SessionModel {
  reasoningEffort?: ReasoningEffort
  endpoint: ModelEndpoint
  modelId: string
  contextWindow: number | null
  provider: ModelProvider | null
  // 用户在模型设置里打开了「图片」：提问可以带图片
  supportsImages?: boolean
}

// 提问里带的图片，base64
export const PROMPT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export interface PromptImage {
  mimeType: (typeof PROMPT_IMAGE_TYPES)[number]
  data: string
}

// session/new 的 _meta.diffra
export interface SessionConfig {
  model: SessionModel
  // 「评审」角色的模型；null 时审查用编码模型
  reviewModel: { endpoint: ModelEndpoint; modelId: string; provider: ModelProvider | null } | null
  // 「规划」角色的模型；null 时出计划用编码模型
  planModel: SessionModel | null
  // 「兜底」角色的模型：编码模型卡住或连续失败时，这一轮剩下的部分换它来做；null 时不换
  fallbackModel: SessionModel | null
  checks: SessionChecks
  // 禁写目录（相对项目根目录），比如用户的数据目录：agent 不能改，检查点也不碰
  readOnlyPaths: string[]
  rules: SessionRules
  permissionMode: PermissionMode
  security: SessionSecurity
  limits: SessionLimits
  // 开着的插件：它们的 Skill、命令和 MCP 服务器
  plugins: PluginRef[]
  // 客户端有内置浏览器：给模型浏览器工具，操作由客户端执行
  browser?: boolean
  // 设计任务：建会话时定下，存进会话记录；客户端在每轮开始前把设计面板的工具配置给它
  design?: boolean
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
  // 这个会话实际生效的检查命令（建会话时的设置）；旧版 core 没有这一项时为 null
  checks?: SessionChecks | null
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
export type TurnKind = 'prompt' | 'deep-scan' | 'plan' | 'goal' | 'compact'
export const MANUAL_COMPACTION_PROMPT = '/compact'

// Skill 从哪里来：项目的 .diffra/skills、自己的 ~/.diffra/skills、插件，兼容读取的 Claude Code、Codex 的目录，以及随 Diffra 带的
export type SkillSource = 'project' | 'user' | 'plugin' | 'claude' | 'codex' | 'builtin'

export interface SkillInfo {
  name: string
  description: string
  source: SkillSource
  dir: string
}

export interface PluginRef {
  name: string
  dir: string
}

// 插件里有什么；unsupported 是读到了但 Diffra 不支持的部分（agents、hooks 等）
export interface PluginInfo {
  name: string
  version: string
  description: string
  commands: string[]
  skills: string[]
  mcpServers: string[]
  unsupported: string[]
}

// 自定义命令：选了以后把正文（$ARGUMENTS 换成参数）放进输入框
export interface CommandInfo {
  name: string
  description: string
  argumentHint: string
  source: SkillSource
  body: string
}

// 智能体操作内置浏览器，core 通过 CLIENT_EXT_METHODS.browserAction 请求客户端执行
export type BrowserAction =
  | { action: 'navigate'; url: string }
  | { action: 'snapshot' }
  | { action: 'click'; ref: string }
  | { action: 'type'; ref: string; text: string; submit: boolean }
  | { action: 'press'; key: string }
  | { action: 'console' }
  // width：按这个视口宽度（CSS 像素）渲染后截图，截完恢复；null 是面板里用户看到的样子
  | { action: 'screenshot'; width: number | null }
  // 按手机和桌面两种宽度检查布局问题，结果是文字
  | { action: 'layout' }

export type BrowserActionParams = BrowserAction & { sessionId: string }

// text 给模型看；截图时带 image
export interface BrowserActionResult {
  text: string
  image: PromptImage | null
}

// 开发服务器在客户端的终端里跑，用户看得见、能停；一个任务最多一个
export type DevServerParams =
  | { sessionId: string; action: 'terminal-list' }
  | { sessionId: string; action: 'terminal-read'; terminalId: string; lines: number }
  | { sessionId: string; action: 'start'; command: string; cwd: string }
  | { sessionId: string; action: 'logs' }
  | { sessionId: string; action: 'stop' }

export interface DevServerResult {
  text: string
  // 输出里看到的本地地址
  url: string | null
}

// 设计面板（OpenPencil 矢量编辑器）的工具，来自客户端的设计页：name 是 OpenPencil 的工具名，参数是 JSON Schema
export interface DesignToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  // 不改文档（读节点、导出图片等）
  readOnly: boolean
}

// 用户打开设计面板后客户端配置给会话（SESSION_EXT_METHODS.sessionConfigure）：之后的轮次带上设计工具和这段说明
export interface SessionDesign {
  tools: DesignToolSpec[]
  instructions: string
}

// 智能体调用设计工具，core 通过 CLIENT_EXT_METHODS.designAction 请求客户端在设计页里执行
export interface DesignActionParams {
  sessionId: string
  tool: string
  args: unknown
}

// text 给模型看；导出图片的工具带 image
export interface DesignActionResult {
  text: string
  image: PromptImage | null
}

// core 请求客户端做的事
export const CLIENT_EXT_METHODS = {
  browserAction: '_diffra/browser/action',
  devServer: '_diffra/devserver',
  designAction: '_diffra/design/action',
} as const

export interface McpPromptInfo {
  name: string
  description: string
  arguments: Array<{ name: string; description: string; required: boolean }>
}

// MCP 服务器连上没有、有哪些工具和 prompt；设置页、任务监控和斜杠菜单用
export interface McpServerStatus {
  name: string
  transport: 'stdio' | 'http'
  state: 'connected' | 'failed'
  error: string | null
  tools: Array<{ name: string; description: string }>
  prompts: McpPromptInfo[]
}

// 查哪些 MCP 服务器：某个任务用的，或者给定项目和配置（首页、设置页还没有任务）
export type McpTarget = { sessionId: string } | { cwd: string; servers: McpServer[]; plugins?: PluginRef[] }

export interface StoredTurn {
  id: string
  kind: TurnKind
  prompt: string
  startedAt: string
  endedAt: string | null
  // 还没结束就被打断（比如应用退出）时为 null
  stopReason: StopReason | null
  updates: SessionUpdate[]
  // 用户在输入框里给这一轮选的 Skill
  skills: string[]
  // 这一轮提问带的图片
  images: PromptImage[]
}

// session/load 响应的 _meta.diffra
export interface LoadedSession {
  info: SessionInfo
  title: string
  turns: StoredTurn[]
  // core 当前的任务状态，比最后一轮里的快照新（撤销、应用退出都会改它）
  taskState?: TaskProgressView
  design: boolean
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

export type ModelRole = 'coder' | 'reviewer' | 'planner'

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
  compact: '_diffra/session/compact',
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
  // 先出计划：规划模型只读地看代码，交一份计划，不改文件
  plan: '_diffra/session/plan',
  // 列出这个项目能用的 Skill
  skillsList: '_diffra/skills/list',
  // MCP 服务器状态；retry 为 true 时连不上的马上重连
  mcpStatus: '_diffra/mcp/status',
  // 把一个 MCP prompt 展开成文字
  mcpPrompt: '_diffra/mcp/prompt',
  // 列出这个项目能用的自定义命令
  commandsList: '_diffra/commands/list',
  // 读一个插件文件夹里有什么
  pluginInspect: '_diffra/plugins/inspect',
} as const

export const PERMISSION_OPTIONS = {
  allowOnce: 'allow_once',
  allowAlways: 'allow_always',
  reject: 'reject',
} as const
