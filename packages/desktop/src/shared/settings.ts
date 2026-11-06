import type { PermissionMode, Protocol, SessionChecks } from '@diffra/core/types'

export const ROLES = ['coder', 'planner', 'reviewer', 'fallback'] as const
export type Role = (typeof ROLES)[number]

export interface ModelRef {
  providerId: string
  modelId: string
}

export interface ModelConfig {
  id: string
  contextWindow: number | null
}

export interface ProviderConfig {
  id: string
  presetId: string | null
  name: string
  protocol: Protocol
  baseUrl: string
  models: ModelConfig[]
}

export interface ProjectRuleSettings {
  // 关掉的规则包和单条规则；新加的规则包默认启用
  disabledPacks: string[]
  disabledRules: string[]
  // 推荐级规则也写进提示词；默认只放强制级
  includeRecommended: boolean
  // 完成前用评审模型按规则审查这一轮的改动
  review: boolean
}

export interface ProjectSettings {
  checks: SessionChecks
  // 禁写目录，相对项目根目录、/ 分隔
  readOnlyPaths: string[]
  rules: ProjectRuleSettings
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
