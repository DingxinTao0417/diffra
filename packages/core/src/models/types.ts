// 纯类型和常量，桌面端界面也会引用，不能依赖 Node API。

export const PROTOCOLS = [
  'anthropic',
  'anthropic-compatible',
  'openai-responses',
  'openai-compatible',
  'gemini',
] as const

export type Protocol = (typeof PROTOCOLS)[number]

export interface ModelEndpoint {
  protocol: Protocol
  // anthropic 系按 Claude Code 的约定填写，不带 /v1；openai 系按 OpenAI SDK 的约定，带 /v1
  baseUrl: string
  apiKey: string
}

export type ModelErrorKind =
  | 'auth'
  | 'not-found'
  | 'unsupported'
  | 'rate-limit'
  | 'server'
  | 'timeout'
  | 'network'
  | 'unknown'

export interface ModelError {
  kind: ModelErrorKind
  message: string
  status?: number
}

export interface ListedModel {
  id: string
  name?: string
}

export type ListModelsResult = { ok: true; models: ListedModel[] } | { ok: false; error: ModelError }

export type TestModelResult = { ok: true; latencyMs: number; reply: string } | { ok: false; error: ModelError }

// ACP 规定扩展方法名以下划线开头
export const EXT_METHODS = {
  listModels: '_diffra/models/list',
  testModel: '_diffra/models/test',
} as const
