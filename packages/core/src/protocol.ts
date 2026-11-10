// core 与桌面端共用的纯类型和常量（桌面端界面也会引用，不能依赖 Node API）。
import type { McpServer, SessionUpdate, StopReason } from '@agentclientprotocol/sdk'
import type { ModelEndpoint, ModelErrorKind } from './models/types.js'

export * from './models/types.js'
export * from './design-styles.js'
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
  // stop 是 model-error 时模型接口出错的类型，界面按它说明原因、给出下一步
  errorKind?: ModelErrorKind
}
// 模型一直没吐数据时的 session_info_update._meta.diffra.modelSilentSince：最后一次收到数据的时刻（ISO），
// 又收到数据、重发了这一步或这一步正常结束时发 null；被停止时不发，记录里留着「停下时模型已经多久没输出」。
// 子智能体的同一条更新里带 agent（AgentTag），界面按智能体分开记
export const MODEL_SILENCE_META_KEY = 'modelSilentSince'

// 只有用户能回答的问题：第一个选项是默认答案，它的 text 原样是提示词里的一行；换成别的选项就把那一行换成那个选项的 text
export interface PromptQuestion {
  question: string
  options: Array<{ label: string; text: string }>
}

// 定位轮交回的结果，放在「定位结果」那张卡的 tool_call._meta.diffra.diagnosis 里。
// evidence 的 itemId 是对话里那一步的 id（子智能体的步骤带它的前缀），点一下滚过去；
// fallback 为 true 时是模型没交结果，按记录拼的通用版本
// 对话里的可视化：show_visual 那张卡的 tool_call._meta.diffra.visual，{ title, code }；code 是 HTML 片段或 SVG
export const VISUAL_META_KEY = 'visual'
export const VISUAL_MAX_CHARS = 1_000_000

// 改动卡片（diff 内容）的 _meta.diffra：oldText、newText 只是变化的那段（前后各留几行上下文），不是整份文件。
// 长任务里每次改动都带整份文件，会话记录涨到几十 MB，载入时超过 ACP 单条消息的上限。
// startLine 是这一段从第几行开始（1 起），oldLines、newLines 是两段各几行（空字符串分不清是 0 行还是 1 个空行）。
// base 是改之前的整份文件：一轮里第一次改这个文件、或者它在两次改动之间被别处改过时才带。
// 界面按顺序重放一轮的改动就能还原每次改动前后的全文，「本轮交付」照旧按第一次改之前和最后的全文算净改动。
// 旧记录没有这个字段，oldText、newText 是整份文件
export const EDIT_DIFF_META_KEY = 'edit'
export interface EditDiffMeta {
  startLine: number
  oldLines: number
  newLines: number
  base?: string
}
// 任务之间互通（task_send、task_create）：消息是哪个任务发来的
export interface TaskSource {
  sessionId: string
  title: string
}
export type TaskActionParams =
  | { sessionId: string; action: 'send'; target: string; message: string; from: TaskSource }
  | { sessionId: string; action: 'create'; project: string | null; title: string | null; design: boolean; message: string; from: TaskSource }
// queued：对方正在跑，消息排在它这一轮后面
export type TaskActionResult = { ok: true; sessionId: string; title: string; queued: boolean } | { ok: false; error: string }

export const DIAGNOSIS_META_KEY = 'diagnosis'

// 优化提示词交回的结果
export interface PromptEnhancement {
  prompt: string
  questions: PromptQuestion[]
}
// 首页（还没有任务）优化提示词的用量记在这个任务 id 下，用量页按它写名字
export const PROMPT_ENHANCE_USAGE_ID = 'prompt-enhance'
export interface Diagnosis {
  // 定位的是哪一轮、哪个子智能体（agent 是它的名字），「重新定位」照着再来一次
  target: { turnId: string; cardId: string | null; agent: string | null }
  cause: string
  evidence: Array<{ itemId: string; title: string; note: string }>
  done: string[]
  remaining: string[]
  prompt: string
  questions: PromptQuestion[]
  fallback: boolean
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
  // 设计任务的风格预设（DESIGN_STYLES 的 id）；null 是不用预设。建会话时定下，存进会话记录
  designStyle?: string | null
  // 无项目任务：cwd 是客户端替任务建的文件夹，不是用户的项目。建会话时定下，存进会话记录
  noProject?: boolean
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

const RESTORE_NOTICE_PATHS = 50

// 撤销提示：core 记进被撤销的那一轮，客户端撤销时本地追加同样的一条，重新打开任务时按记录重放
export function restoreNotice(changes: CheckpointChange[]): { title: string; description: string | null } {
  const lines = changes.slice(0, RESTORE_NOTICE_PATHS).map((change) => change.path)
  if (changes.length > RESTORE_NOTICE_PATHS) lines.push(`…等 ${changes.length} 个文件`)
  return { title: `已撤销 ${changes.length} 个文件的改动`, description: lines.join('\n') || null }
}

// usage_update 的 _meta.diffra：上下文里各部分的估算 token 数，合计等于模型返回的输入 token 数
export interface UsageBreakdown {
  system: number
  // 项目规则（AGENTS.md 等）和编码规范
  rules: number
  tools: number
  messages: number
}

// 最近一次模型调用返回的缓存用量，放在 usage_update 的 _meta.cache 里给界面；旧记录没有这一项。
// input 是那次调用的输入 token 数：压缩后上下文的估算值会变小，缓存命中率仍要按原来的输入算
export interface UsageCache {
  read: number | null
  write: number | null
  input: number
}

// 存下来的一轮：界面重建这一轮要用的会话更新，按收到的顺序
// 普通的一轮提问，或者用户发起的深度安全扫描
// diagnose：停下或子智能体失败后的「定位问题」，只读地查原因、给修复提示词，不改文件、不改变任务结论
export type TurnKind = 'prompt' | 'deep-scan' | 'plan' | 'goal' | 'compact' | 'diagnose'
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

// 页面上的一个位置：最近一次读页面给的 ref，或最近一张截图里的像素坐标（没截过图时就是页面的 CSS 像素）
export type BrowserPoint = { ref: string } | { x: number; y: number }

// 用户在设置里列的网站：主机名，也管它的子域名
export interface BrowserSites {
  allow: string[]
  block: string[]
}

export const BROWSER_MODIFIERS = ['Alt', 'Control', 'Meta', 'Shift'] as const
export type BrowserModifier = (typeof BROWSER_MODIFIERS)[number]

export const BROWSER_WAIT_MAX_SECONDS = 30
export const BROWSER_KEY_REPEAT_MAX = 50
export const BROWSER_KEY_HOLD_MAX_MS = 10_000
export const BROWSER_UPLOAD_MAX_FILES = 10

// 智能体用哪个浏览器：Diffra 内置的，或用户自己的 Chrome、Edge（带着用户的登录状态）
export const BROWSER_BACKENDS = ['builtin', 'chrome', 'edge'] as const
export type BrowserBackend = (typeof BROWSER_BACKENDS)[number]

// 智能体操作浏览器（内置浏览器，或用户的 Chrome、Edge），core 通过 CLIENT_EXT_METHODS.browserAction 请求客户端执行
export type BrowserAction =
  | { action: 'navigate'; url: string }
  | { action: 'history'; direction: 'back' | 'forward' | 'reload' }
  // 一个任务可以开多个标签页；index 从 1 开始
  | { action: 'tabs'; op: 'list' | 'new' | 'select' | 'close'; url: string | null; index: number | null }
  | { action: 'snapshot' }
  // 按文字找元素：只列出名字或文字里含 query 的行，带 ref
  | { action: 'find'; query: string }
  // 页面上看得到的文字
  | { action: 'text' }
  | { action: 'click'; at: BrowserPoint; button: 'left' | 'right' | 'middle'; double: boolean; modifiers: BrowserModifier[] }
  | { action: 'hover'; at: BrowserPoint }
  | { action: 'drag'; from: BrowserPoint; to: BrowserPoint }
  // at 为 null 时在页面正中滚
  | { action: 'scroll'; at: BrowserPoint | null; deltaX: number; deltaY: number }
  // ref 为 null 时输入到当前有焦点的地方，不清空原内容
  | { action: 'type'; ref: string | null; text: string; submit: boolean }
  // key 可以是组合键（Control+A）；holdMs 按住多久再松开（游戏用）
  | { action: 'press'; key: string; repeat: number; holdMs: number }
  | { action: 'select'; ref: string; values: string[] }
  // paths 已经由 core 解析成绝对路径并征得同意
  | { action: 'upload'; ref: string; paths: string[] }
  // 等文字出现、消失，或者只是等几秒
  | { action: 'wait'; text: string | null; textGone: string | null; seconds: number }
  // 处理 alert、confirm、prompt
  | { action: 'dialog'; accept: boolean; promptText: string | null }
  | { action: 'console' }
  | { action: 'network'; filter: string | null; failedOnly: boolean }
  // 在页面里运行脚本，core 已经征得同意
  | { action: 'evaluate'; expression: string }
  // width：按这个视口宽度（CSS 像素）渲染后截图，截完恢复；null 是用户看到的样子。fullPage：整页长图
  | { action: 'screenshot'; width: number | null; fullPage: boolean }
  // 按手机和桌面两种宽度检查布局问题，结果是文字
  | { action: 'layout' }
  // 列出页面上的图片：完整尺寸的网址、像素尺寸和替代文字（找图放进设计稿用）
  | { action: 'images' }
  // 这个任务改用哪个浏览器（只改这个任务，不改设置里的默认）；换到用户的浏览器 core 已经征得同意
  | { action: 'switch'; browser: BrowserBackend }

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

// 设计任务每轮开始前由客户端配置给会话（SESSION_EXT_METHODS.sessionConfigure）：之后的轮次带上设计工具和这段说明
export interface SessionDesign {
  tools: DesignToolSpec[]
  instructions: string
}

// 智能体调用设计工具，core 通过 CLIENT_EXT_METHODS.designAction 请求客户端在设计页里执行
export interface DesignActionParams {
  sessionId: string
  tool: string
  args: unknown
  // 哪个子智能体在调用（设计页按它加节点锁、画光标）；主智能体自己调时为 null
  agent?: AgentTag | null
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
  // 任务之间互通：智能体给别的任务发消息、新建任务，由客户端载入任务、起一轮
  taskAction: '_diffra/task/action',
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

// 列 Skill 和自定义命令：某个任务建立时开着的插件，或者给定项目和插件（首页还没有任务）
export type ListTarget = { sessionId: string } | { cwd: string; plugins?: PluginRef[] }

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
  // 撤销到这一轮或更早的轮次之前时写入，多次撤销记最后一次。只说明之后撤销过，不代表这一轮的改动现在不在
  restoredAt?: string
  // 这一轮的提问是另一个任务（智能体用 task_send、task_create）发来的；用户自己发的没有
  from?: TaskSource
}

// session/load 响应的 _meta.diffra
export interface LoadedSession {
  info: SessionInfo
  title: string
  turns: StoredTurn[]
  // core 当前的任务状态，比最后一轮里的快照新（撤销、应用退出都会改它）
  taskState?: TaskProgressView
  design: boolean
  noProject: boolean
}

// session/list 里每个会话 _meta.diffra 带的字段
export interface StoredSessionMeta {
  createdAt: string
  archived: boolean
  turnCount: number
  design: boolean
  noProject: boolean
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

// subagent：主智能体用 delegate 派出的子智能体（工人），用的是编码模型
export type ModelRole = 'coder' | 'reviewer' | 'planner' | 'subagent'

// 子智能体：主智能体用 delegate 派出的工人。它的卡片（那次 delegate 调用）在 _meta.diffra.agent 里带 AgentCardMeta；
// 工人自己的工具调用在 _meta.diffra 里带 parentToolCallId（所属卡片）和 agent（AgentTag），界面据此收进卡片、标出是谁改的文件。
// 权限请求的 toolCall 也带 _meta.diffra.agent，界面写明是哪个智能体在请求
export const AGENT_META_KEY = 'agent'
export const PARENT_TOOL_CALL_META_KEY = 'parentToolCallId'

export interface AgentTag {
  id: string
  name: string
  // 界面和设计画布上的标识色，#RRGGBB
  color: string
}

export interface AgentCardMeta extends AgentTag {
  task: string
  // 认领的文件和目录（相对项目）；中途追加认领时整份重发
  files: string[]
  // 设计任务里负责的节点
  nodes: string[]
}

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
  cacheWrite: number
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

// ACP 单条消息的上限（两端都按它读）。SDK 默认 32 MiB，载入长任务时整份轮次记录走一条消息，
// 2026-11 一个 41 轮的任务记录有 35 MB，打不开（MessageTooLargeError）。编辑卡片已不存整份文件，这里留足余量
export const ACP_MAX_MESSAGE_BYTES = 256 * 1024 * 1024

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
  // 模型很久没有输出时，用户让卡住的那一步重发请求（主智能体或某个子智能体），这一轮不停
  retryStep: '_diffra/session/retry-step',
  // 定位问题：停下的一轮或失败的子智能体，用当前模型只读地查原因，交回原因、证据和修复提示词
  diagnose: '_diffra/session/diagnose',
  // 浏览器的站点名单（设置里管理）：允许的直接打开，禁止的不打开也不问；所有会话共用
  browserSites: '_diffra/browser/sites',
  // 优化输入框里的提示词：一次调用交回改写稿和只有用户能回答的问题，不进任何对话
  promptEnhance: '_diffra/prompt/enhance',
  // 列出这个任务或项目能用的 Skill
  skillsList: '_diffra/skills/list',
  // MCP 服务器状态；retry 为 true 时连不上的马上重连
  mcpStatus: '_diffra/mcp/status',
  // 把一个 MCP prompt 展开成文字
  mcpPrompt: '_diffra/mcp/prompt',
  // 列出这个任务或项目能用的自定义命令
  commandsList: '_diffra/commands/list',
  // 读一个插件文件夹里有什么
  pluginInspect: '_diffra/plugins/inspect',
} as const

export const PERMISSION_OPTIONS = {
  allowOnce: 'allow_once',
  allowAlways: 'allow_always',
  reject: 'reject',
} as const
