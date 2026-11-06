import type { Protocol, SessionChecks } from '@diffra/core/types'

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

export interface Settings {
  version: 1
  providers: ProviderConfig[]
  roles: Record<Role, ModelRef | null>
  // 按项目目录保存的检查命令，不往用户仓库里写文件
  projects: Record<string, ProjectSettings>
  // 会话不持久化，至少记住上次打开的项目
  lastProject: string | null
}

// 界面看到的供应商：多一个密钥掩码，拿不到密钥本身
export interface ProviderView extends ProviderConfig {
  keyHint: string | null
}

export interface SettingsView {
  providers: ProviderView[]
  roles: Settings['roles']
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
