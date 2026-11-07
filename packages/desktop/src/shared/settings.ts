import type { PermissionMode, PluginInfo, Protocol, SessionChecks } from '@diffra/core/types'

export const ROLES = ['coder', 'planner', 'reviewer', 'fallback'] as const
export type Role = (typeof ROLES)[number]

export interface ModelRef {
  providerId: string
  modelId: string
}

export interface ModelConfig {
  id: string
  contextWindow: number | null
  // 能看图：提问可以带图片，浏览器工具可以截图给它看
  images: boolean
}

export interface ProviderConfig {
  id: string
  presetId: string | null
  name: string
  protocol: Protocol
  baseUrl: string
  models: ModelConfig[]
}

export interface ProjectSettings {
  checks: SessionChecks
  // 禁写目录，相对项目根目录、/ 分隔
  readOnlyPaths: string[]
}

export const THEME_MODES = ['light', 'dark', 'system'] as const
export const PALETTES = ['forest', 'indigo', 'amber', 'graphite'] as const
export const FONT_SIZES = ['sm', 'md', 'lg'] as const
export const CONTENT_WIDTHS = ['standard', 'wide'] as const

export interface Appearance {
  theme: (typeof THEME_MODES)[number]
  palette: (typeof PALETTES)[number]
  fontSize: (typeof FONT_SIZES)[number]
  contentWidth: (typeof CONTENT_WIDTHS)[number]
}

export const DEFAULT_APPEARANCE: Appearance = { theme: 'system', palette: 'forest', fontSize: 'md', contentWidth: 'standard' }

// 完成前的安全检查，所有项目共用；深度扫描是在任务页手动发起的，这里只控制入口
export interface SecuritySettings {
  staticCheck: boolean
  lightScan: boolean
  deepScan: boolean
}

export const DEFAULT_SECURITY: SecuritySettings = { staticCheck: true, lightScan: true, deepScan: true }

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
}

export const DEFAULT_EXECUTION: ExecutionSettings = { compactAtPercent: 70, maxSteps: 100, goalMaxRounds: 5 }

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
}

// 装好的插件。从文件夹装的就地使用那个文件夹；从 Git 装的克隆到应用数据目录的 plugins 下
export interface InstalledPlugin {
  id: string
  name: string
  dir: string
  source: 'folder' | 'git'
  url: string | null
  enabled: boolean
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
  appearance: Appearance
  // 新任务默认的命令权限模式；在输入框里改了会记住
  defaultPermissionMode: PermissionMode
  security: SecuritySettings
  execution: ExecutionSettings
  mcpServers: McpServerConfig[]
  plugins: InstalledPlugin[]
}

// 界面看到的供应商：多一个密钥掩码，拿不到密钥本身
export interface ProviderView extends ProviderConfig {
  keyHint: string | null
}

export interface SettingsView {
  providers: ProviderView[]
  roles: Settings['roles']
  appearance: Appearance
  defaultPermissionMode: PermissionMode
  security: SecuritySettings
  execution: ExecutionSettings
  mcpServers: McpServerConfig[]
  // 设置文件或密钥文件解析失败时的说明；此时不允许保存，避免覆盖原文件
  loadError: string | null
}

// 新建时不带 id；apiKey 留空表示不修改已保存的密钥
export interface ProviderInput {
  id?: string
  presetId: string | null
  name: string
  protocol: Protocol
  baseUrl: string
  models: ModelConfig[]
  apiKey?: string
}
