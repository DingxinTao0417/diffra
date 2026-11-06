import type { Protocol } from '@diffra/core/types'

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

export interface Settings {
  version: 1
  providers: ProviderConfig[]
  roles: Record<Role, ModelRef | null>
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
