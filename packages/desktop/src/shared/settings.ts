import type { UsagePrice } from '@diffra/core/types'
import { BROWSER_BACKENDS, type BrowserBackend, type PermissionMode, type PluginInfo, type Protocol, type ReasoningEffort, type SessionChecks } from '@diffra/core/types'
import type { McpOAuthState } from './mcp-oauth'
import type { ExternalAgentConfig } from './external-agents'

export const ROLES = ['coder', 'planner', 'explorer', 'implementer', 'reviewer', 'tester', 'fallback'] as const
export type Role = (typeof ROLES)[number]

export interface ModelRef {
  reasoningEffort?: ReasoningEffort
  providerId: string
  modelId: string
}

// 设置里 reasoningChoices 的键
export const reasoningChoiceKey = (ref: Pick<ModelRef, 'providerId' | 'modelId'>) => `${ref.providerId}/${ref.modelId}`

export const MAX_MODEL_ID_LENGTH = 200
export const MAX_MODEL_DISPLAY_NAME_LENGTH = 100
export const MAX_MODEL_CONTEXT_WINDOWS = 20
export const MAX_PROVIDER_MODELS = 20
export const CONTEXT_WINDOW_OPTIONS = [32_000, 64_000, 128_000, 200_000, 256_000, 1_000_000] as const
export const MAX_OUTPUT_OPTIONS = [8_000, 16_000, 32_000, 64_000] as const

export interface ModelConfig {
  // 旧配置缺少这些字段时沿用模型 ID、启用状态和单个上下文窗口。
  displayName?: string
  enabled?: boolean
  contextWindows?: number[]
  // 未配置时按已知模型推断；空数组表示不支持
  reasoningEfforts?: ReasoningEffort[]
  id: string
  contextWindow: number | null
  // 能看图：提问可以带图片，浏览器工具可以截图给它看
  images: boolean
  // 每次调用最多输出多少 token；没有或 null 时按协议的默认值
  maxOutputTokens?: number | null
}

// 显式处理空白名称，兼容旧配置；所有展示入口使用同一回退规则。
export function modelDisplayName(model: Pick<ModelConfig, 'id' | 'displayName'>): string {
  const displayName = model.displayName?.trim() ?? ''
  return displayName === '' ? model.id : displayName
}

export interface ProviderConfig {
  id: string
  presetId: string | null
  // Lobe Icons 的图标 id，用户自选的；null 表示按预设、名称和地址自动匹配
  icon: string | null
  name: string
  protocol: Protocol
  baseUrl: string
  models: ModelConfig[]
}

// 项目钩子：在固定时机替用户跑的命令，null 是没配。含义见 core 的 SessionHooks
export interface ProjectHooks {
  afterEdit: string | null
  beforeCommand: string | null
  turnEnd: string | null
}

export const NO_HOOKS: ProjectHooks = { afterEdit: null, beforeCommand: null, turnEnd: null }

// 按项目单独设的安全开关（v2 · M10）：只存和全局不一样的几项，没写的跟着「设置 → 安全」
export type ProjectSecurity = Partial<SecuritySettings>

export interface ProjectSettings {
  checks: SessionChecks
  // 禁写目录，相对项目根目录、/ 分隔
  readOnlyPaths: string[]
  // 用户在这个项目里选过「始终允许同类命令」的命令键；旧设置没有
  allowedCommands?: string[]
  // 项目钩子；旧设置没有
  hooks?: ProjectHooks
  // v2：按项目单独设的安全开关；旧设置没有
  security?: ProjectSecurity
}

export const THEME_MODES = ['light', 'dark', 'system'] as const
export const PALETTES = ['forest', 'indigo', 'amber', 'graphite', 'cinnabar', 'violet', 'cyan', 'rose'] as const
export const FONT_STYLES = ['sans', 'serif'] as const
export const FONT_SIZES = ['sm', 'md', 'lg'] as const
export const CONTENT_WIDTHS = ['standard', 'wide'] as const

export interface Appearance {
  fontStyle?: (typeof FONT_STYLES)[number]
  theme: (typeof THEME_MODES)[number]
  palette: (typeof PALETTES)[number]
  fontSize: (typeof FONT_SIZES)[number]
  contentWidth: (typeof CONTENT_WIDTHS)[number]
}

export const DEFAULT_APPEARANCE: Appearance = { theme: 'system', palette: 'forest', fontSize: 'md', contentWidth: 'standard' }

// 拖过的分栏尺寸，单位像素；null 是默认尺寸（侧栏、监控面板、设计模式的对话列按 rem 跟着文字大小，宽面板取主区一半）
export interface Layout {
  sidebarWidth: number | null
  // 审阅、浏览器和终端共用，互切时对话列不动
  widePanelWidth: number | null
  monitorWidth: number | null
  designChatWidth: number | null
}

export const DEFAULT_LAYOUT: Layout = { sidebarWidth: null, widePanelWidth: null, monitorWidth: null, designChatWidth: null }

// 和智能体的 browser_switch 用同一份清单
export const AGENT_BROWSERS = BROWSER_BACKENDS
export type AgentBrowser = BrowserBackend
export const MAX_BROWSER_SITES = 500

// 智能体用哪个浏览器：内置浏览器，或用户自己的 Chrome、Edge（要装 Diffra 浏览器扩展）；
// allowSites 直接打开不问，blockSites 不让打开。写主机名，也管子域名
export interface BrowserSettings {
  agent: AgentBrowser
  allowSites: string[]
  blockSites: string[]
  // v2：选了 Chrome 时不经扩展，直接启动系统里装的 Chrome（Diffra 单独的配置）；旧设置没有这一项（就是经扩展）
  chromeDirect?: boolean
  // v2：直接启动时用的程序，用户自己选的；没有就按 Chrome、Edge、Chromium 的常见位置找
  chromePath?: string | null
  // v2：浏览器面板上显示「开发者工具」按钮；旧设置没有就是显示
  devTools?: boolean
}

export const DEFAULT_BROWSER: BrowserSettings = { agent: 'builtin', allowSites: [], blockSites: [] }

// 电脑操控（v2）：默认关；第一次打开时界面先讲清楚它能做什么、怎么停，用户确认了记下 acknowledged
export interface ComputerUseSettings {
  enabled: boolean
  acknowledged: boolean
}

// 托盘和开机自启（v2）：开着托盘时关窗口留在托盘里；开机自启开着托盘时藏在托盘里启动
export interface SystemSettings {
  tray: boolean
  launchAtLogin: boolean
}

// 下一句建议（v2）：一轮正常结束后在输入框提示下一步，Tab 填入；只生成草稿，不自动发送
export interface SuggestionSettings {
  nextPrompt: boolean
}

export const DEFAULT_SUGGESTIONS: SuggestionSettings = { nextPrompt: true }

// 这台电脑支不支持电脑操控（Windows、macOS 支持）
export interface ComputerStatus {
  supported: boolean
  platform: string
}

// 电脑操控的一条审计记录：输入的文字只记字数
export interface ComputerAuditEntry {
  at: string
  sessionId: string
  action: string
  detail: string
  ok: boolean
  error: string | null
  ms: number
}

// 深度扫描：智能体提交或推送前问要不要先扫，任务页也能手动发起；所有项目共用，改了对已经打开的任务立即生效。
// 结束时的静态检查、轻量扫描、规范审查已经移除，旧设置文件里的这几项读的时候丢掉
export interface SecuritySettings {
  deepScan: boolean
}

export const DEFAULT_SECURITY: SecuritySettings = { deepScan: true }

// 一个项目实际用的开关：全局的，加上这个项目单独设的
export function effectiveSecurity(global: SecuritySettings, project: ProjectSecurity | undefined): SecuritySettings {
  return { deepScan: project?.deepScan ?? global.deepScan }
}

export const COMPACT_AT_PERCENTS = [50, 60, 70, 80, 90] as const
export const MAX_STEP_OPTIONS = [30, 50, 80, 100] as const
export const GOAL_ROUND_OPTIONS = [3, 5, 10, 20] as const

// 单次任务的上限，所有项目共用
export interface ExecutionSettings {
  // 上下文用到窗口的百分之多少时压缩
  compactAtPercent: (typeof COMPACT_AT_PERCENTS)[number]
  // 一次任务最多跑多少步；null 不限，靠卡死检测兜底
  maxSteps: (typeof MAX_STEP_OPTIONS)[number] | null
  // 目标模式最多自动跑几轮；每轮各有一份步数上限
  goalMaxRounds: (typeof GOAL_ROUND_OPTIONS)[number]
  // 自动记忆：每轮结束后把以后用得上的事记进这个项目的记忆文件，新任务带上。每轮多一次模型调用，默认关
  autoMemory: boolean
}

export const DEFAULT_EXECUTION: ExecutionSettings = { compactAtPercent: 70, maxSteps: 100, goalMaxRounds: 5, autoMemory: false }

export const MCP_TRANSPORTS = ['stdio', 'http'] as const

// MCP 服务器。环境变量和请求头的值可能是密钥，加密存在密钥库，这里只记名字
export interface McpServerConfig {
  id: string
  // 模型看到的工具名是 mcp__名称__工具名，只用字母、数字、- 和 _
  name: string
  enabled: boolean
  transport: (typeof MCP_TRANSPORTS)[number]
  // stdio：在项目目录里运行的命令和参数
  command: string
  args: string[]
  envNames: string[]
  // http：地址和请求头
  url: string
  headerNames: string[]
  // 浏览器登录（OAuth，v2）的远程服务器：令牌在密钥库里，建会话时带上；旧设置没有这一项（就是用请求头）
  auth?: 'oauth'
}

// 保存时带上值；value 为 null 表示沿用已保存的值
export interface McpServerInput {
  id?: string
  name: string
  enabled: boolean
  transport: McpServerConfig['transport']
  command: string
  args: string[]
  url: string
  env: Array<{ name: string; value: string | null }>
  headers: Array<{ name: string; value: string | null }>
  auth?: 'oauth'
}

// 装好的插件。从文件夹装的就地使用那个文件夹；从 Git 装的克隆到应用数据目录的 plugins/<id> 下，
// subdir 是插件在仓库里的子目录（没有就是仓库根目录），dir 是插件本身所在的目录
export interface InstalledPlugin {
  id: string
  name: string
  dir: string
  source: 'folder' | 'git'
  url: string | null
  subdir: string | null
  enabled: boolean
  // 用户允许钩子时插件钩子的指纹（PluginInfo.hooksFingerprint）；null 是没允许。钩子变了指纹对不上就不跑
  hooksApproved: string | null
}

// 设置页看到的插件：多了读出来的内容；读不了时 info 为 null，error 说明原因
export interface PluginView extends InstalledPlugin {
  info: PluginInfo | null
  error: string | null
}

export interface Settings {
  version: 1
  providers: ProviderConfig[]
  roles: Record<Role, ModelRef | null>
  // 按项目目录保存的检查命令，不往用户仓库里写文件
  projects: Record<string, ProjectSettings>
  lastProject: string | null
  // 从侧边栏归档的项目目录；项目下的会话一起归档，恢复时一起取消归档
  archivedProjects: string[]
  appearance: Appearance
  layout: Layout
  browser: BrowserSettings
  // 新任务默认的命令权限模式；在输入框里改了会记住
  defaultPermissionMode: PermissionMode
  security: SecuritySettings
  execution: ExecutionSettings
  mcpServers: McpServerConfig[]
  plugins: InstalledPlugin[]
  // v2：电脑操控；旧设置没有这一项（就是关着）
  computerUse?: ComputerUseSettings
  // v2：托盘和开机自启；旧设置没有这一项（都关着）
  system?: SystemSettings
  // v2：下一句建议；旧设置没有这一项（默认开）
  suggestions: SuggestionSettings
  // v2：用量的单价、币种和每月预算；旧设置没有这一项（不算费用）
  usage?: UsageSettings
  // 无项目任务建在这里；null 表示用默认值（打包版是「文档\Diffra」，开发版和 e2e 是数据目录下的 workspace）
  defaultWorkspace: string | null
  // 上次启动的版本；升级后第一次启动据此提示改了什么，界面不显示
  lastSeenVersion: string | null
  // 输入框里给各模型选的思考程度，键见 reasoningChoiceKey；新任务、重开的任务按它（第 531 步）
  reasoningChoices: Record<string, ReasoningEffort>
  // 外接智能体（v2）；旧设置文件没有
  externalAgents: ExternalAgentConfig[]
}

// 界面看到的供应商：多一个密钥掩码，拿不到密钥本身
export interface ProviderView extends ProviderConfig {
  keyHint: string | null
}

// 用量的费用和预算（v2 · M11）：单价按模型填（每百万 token 多少钱），金额都是小数字符串，按整数算
export interface UsageSettings {
  currency: 'CNY' | 'USD'
  prices: UsagePrice[]
  // 每月预算；null 是不设
  monthlyBudget: string | null
  // 这个月已经提醒到哪一档（80% 或 100%），每档每月只提醒一次
  budgetNotice: { month: string; level: 80 | 100 } | null
}

export const DEFAULT_USAGE: UsageSettings = { currency: 'CNY', prices: [], monthlyBudget: null, budgetNotice: null }

export interface SettingsView {
  providers: ProviderView[]
  roles: Settings['roles']
  appearance: Appearance
  layout: Layout
  browser: BrowserSettings
  defaultPermissionMode: PermissionMode
  security: SecuritySettings
  execution: ExecutionSettings
  mcpServers: McpServerConfig[]
  reasoningChoices: Settings['reasoningChoices']
  // 从侧边栏归档的项目，在设置里可以恢复
  archivedProjects: string[]
  // 无项目任务的保存位置，已经按默认值解析好
  defaultWorkspace: { path: string; isDefault: boolean }
  externalAgents: ExternalAgentConfig[]
  // 浏览器登录的 MCP 服务器的登录状态，按服务器 id
  mcpOAuth: Record<string, McpOAuthState>
  // 电脑操控（v2）：没设过就是关着
  computerUse: ComputerUseSettings
  system: SystemSettings
  suggestions: SuggestionSettings
  usage: UsageSettings
  // 设置文件或密钥文件解析失败时的说明；此时不允许保存，避免覆盖原文件
  loadError: string | null
}

// 新建时不带 id；apiKey 留空表示不修改已保存的密钥
export interface ProviderInput {
  id?: string
  presetId: string | null
  icon: string | null
  name: string
  protocol: Protocol
  baseUrl: string
  models: ModelConfig[]
  apiKey?: string
}
