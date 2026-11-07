import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogle } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { defaultSettingsMiddleware, generateText, type LanguageModel, tool, wrapLanguageModel } from 'ai'
import type { ReasoningEffort } from '../protocol.js'
import { z } from 'zod'
import { CORE_VERSION } from '../version.js'
import { httpError, toModelError } from './errors.js'
import type { ListedModel, ListModelsResult, ModelEndpoint, TestModelResult } from './types.js'

const LIST_TIMEOUT_MS = 15_000
const TEST_TIMEOUT_MS = 30_000
const ANTHROPIC_VERSION = '2023-06-01'

// 如实标明客户端身份；Kimi Code 等套餐禁止冒充其他工具。
// 要放在每次调用的 headers 里：generateText 这一层的 user-agent 会覆盖 provider 层设置的。
const USER_AGENT = `diffra-core/${CORE_VERSION}`
export const MODEL_CALL_HEADERS = { 'user-agent': USER_AGENT }

interface TimeoutOptions {
  timeoutMs?: number
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

// AI SDK 在 baseURL 后直接拼 /messages，而各家文档给的 Anthropic 地址不带 /v1
function anthropicApiBase(baseUrl: string): string {
  return `${trimSlash(baseUrl)}/v1`
}

export function createLanguageModel(endpoint: ModelEndpoint, modelId: string, reasoningEffort?: ReasoningEffort): LanguageModel {
  const model = createBaseLanguageModel(endpoint, modelId)
  if (!reasoningEffort || reasoningEffort === 'default') return model
  if (endpoint.protocol !== 'openai-responses' && endpoint.protocol !== 'openai-compatible') return model
  const provider = endpoint.protocol === 'openai-responses' ? 'openai' : 'openai-compatible'
  return wrapLanguageModel({
    model,
    middleware: defaultSettingsMiddleware({ settings: { providerOptions: { [provider]: { reasoningEffort } } } }),
  })
}

function createBaseLanguageModel(endpoint: ModelEndpoint, modelId: string) {
  const { protocol, baseUrl, apiKey } = endpoint
  switch (protocol) {
    case 'anthropic':
      return createAnthropic({ baseURL: anthropicApiBase(baseUrl), apiKey })(modelId)
    case 'anthropic-compatible':
      // 兼容服务有的认 x-api-key，有的认 Bearer（Claude Code 的 ANTHROPIC_AUTH_TOKEN），两个都带上
      return createAnthropic({
        baseURL: anthropicApiBase(baseUrl),
        apiKey,
        headers: { Authorization: `Bearer ${apiKey}` },
      })(modelId)
    case 'openai-responses':
      return createOpenAI({ baseURL: trimSlash(baseUrl), apiKey }).responses(modelId)
    case 'openai-compatible':
      return createOpenAICompatible({ name: 'openai-compatible', baseURL: trimSlash(baseUrl), apiKey }).chatModel(modelId)
    case 'gemini':
      return createGoogle({ baseURL: trimSlash(baseUrl), apiKey })(modelId)
  }
}

function modelsRequest(endpoint: ModelEndpoint): { url: string; headers: Record<string, string> } {
  const { protocol, baseUrl, apiKey } = endpoint
  const headers: Record<string, string> = { ...MODEL_CALL_HEADERS }
  switch (protocol) {
    case 'anthropic':
    case 'anthropic-compatible':
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = ANTHROPIC_VERSION
      if (protocol === 'anthropic-compatible') headers.Authorization = `Bearer ${apiKey}`
      return { url: `${anthropicApiBase(baseUrl)}/models?limit=1000`, headers }
    case 'openai-responses':
    case 'openai-compatible':
      headers.Authorization = `Bearer ${apiKey}`
      return { url: `${trimSlash(baseUrl)}/models`, headers }
    case 'gemini':
      headers['x-goog-api-key'] = apiKey
      return { url: `${trimSlash(baseUrl)}/models?pageSize=1000`, headers }
  }
}

const dataListSchema = z.object({
  data: z.array(z.object({ id: z.string(), display_name: z.string().optional() })),
})

const geminiListSchema = z.object({
  models: z.array(
    z.object({
      name: z.string(),
      displayName: z.string().optional(),
      supportedGenerationMethods: z.array(z.string()).optional(),
    }),
  ),
})

function parseModelList(endpoint: ModelEndpoint, body: unknown): ListedModel[] | undefined {
  if (endpoint.protocol === 'gemini') {
    const parsed = geminiListSchema.safeParse(body)
    if (!parsed.success) return undefined
    return parsed.data.models
      .filter((model) => model.supportedGenerationMethods?.includes('generateContent') ?? true)
      .map((model) => ({ id: model.name.replace(/^models\//, ''), name: model.displayName }))
  }
  const parsed = dataListSchema.safeParse(body)
  if (!parsed.success) return undefined
  return parsed.data.data.map((model) => ({ id: model.id, name: model.display_name }))
}

export async function listModels(endpoint: ModelEndpoint, options: TimeoutOptions = {}): Promise<ListModelsResult> {
  const timeoutMs = options.timeoutMs ?? LIST_TIMEOUT_MS
  const { url, headers } = modelsRequest(endpoint)
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) {
      return { ok: false, error: httpError(response.status, await response.text(), endpoint.apiKey, true) }
    }
    const models = parseModelList(endpoint, await response.json())
    if (!models) return { ok: false, error: { kind: 'unknown', message: '请求失败：模型列表的格式无法识别' } }
    return { ok: true, models: models.sort((a, b) => a.id.localeCompare(b.id)) }
  } catch (error) {
    return { ok: false, error: toModelError(error, endpoint.apiKey, timeoutMs) }
  }
}

export async function testModel(
  endpoint: ModelEndpoint,
  modelId: string,
  options: TimeoutOptions = {},
): Promise<TestModelResult> {
  const timeoutMs = options.timeoutMs ?? TEST_TIMEOUT_MS
  const model = createLanguageModel(endpoint, modelId)
  const started = performance.now()
  let reply: string
  try {
    const result = await generateText({
      model,
      prompt: 'Reply with exactly: OK',
      maxOutputTokens: 64,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(timeoutMs),
      headers: MODEL_CALL_HEADERS,
    })
    reply = result.text.trim().slice(0, 200)
  } catch (error) {
    return { ok: false, error: toModelError(error, endpoint.apiKey, timeoutMs) }
  }
  const latencyMs = Math.round(performance.now() - started)
  return { ok: true, latencyMs, reply, tools: await probeToolCalling(model, endpoint.apiKey, timeoutMs) }
}

// agent 靠工具调用干活：让模型必须调用一个工具，看它会不会
async function probeToolCalling(
  model: LanguageModel,
  apiKey: string,
  timeoutMs: number,
): Promise<{ supported: boolean; detail: string | null }> {
  try {
    const result = await generateText({
      model,
      prompt: 'Call the echo tool with text "OK".',
      tools: { echo: tool({ description: 'Echo the given text', inputSchema: z.object({ text: z.string() }) }) },
      toolChoice: 'required',
      maxOutputTokens: 256,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(timeoutMs),
      headers: MODEL_CALL_HEADERS,
    })
    return result.toolCalls.length > 0
      ? { supported: true, detail: null }
      : { supported: false, detail: '模型没有按要求调用工具' }
  } catch (error) {
    return { supported: false, detail: toModelError(error, apiKey, timeoutMs).message }
  }
}
