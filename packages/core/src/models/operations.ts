import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogle } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { defaultSettingsMiddleware, generateText, type LanguageModel, type LanguageModelMiddleware, tool, wrapLanguageModel } from 'ai'
import type { ReasoningEffort } from '../protocol.js'
import { z } from 'zod'
import { CORE_VERSION } from '../version.js'
import { httpError, maxTokensFromError, rejectsMaxTokens, toModelError } from './errors.js'
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

// AI SDK 对 Anthropic 系接口里名字不带 claude- 的模型默认只给 4096 输出 token，一次写个大文件就被截断；
// 用户没单独设置时按这个值发
export const ANTHROPIC_COMPATIBLE_MAX_OUTPUT_TOKENS = 32_000

// maxOutputTokens：模型设置里的「最大输出」，null 时按协议的默认值；调用时自己传了的以调用时为准
export function createLanguageModel(
  endpoint: ModelEndpoint,
  modelId: string,
  reasoningEffort?: ReasoningEffort,
  maxOutputTokens?: number | null,
): LanguageModel {
  const model = createBaseLanguageModel(endpoint, modelId)
  const middleware: LanguageModelMiddleware[] = []
  const settings: Parameters<typeof defaultSettingsMiddleware>[0]['settings'] = {}
  if (maxOutputTokens != null) settings.maxOutputTokens = maxOutputTokens
  else {
    const automatic = defaultMaxOutputTokens(endpoint, modelId)
    if (automatic !== null) middleware.push(automaticOutputLimit(automatic))
  }
  if (reasoningEffort && reasoningEffort !== 'default' && (endpoint.protocol === 'openai-responses' || endpoint.protocol === 'openai-compatible')) {
    const provider = endpoint.protocol === 'openai-responses' ? 'openai' : 'openai-compatible'
    settings.providerOptions = { [provider]: { reasoningEffort } }
  }
  // 发成 output_config.effort；不指定时 Claude 新模型按官方默认强度思考，不是不思考
  if (reasoningEffort && reasoningEffort !== 'default' && (endpoint.protocol === 'anthropic' || endpoint.protocol === 'anthropic-compatible')) {
    settings.providerOptions = { anthropic: { effort: reasoningEffort } }
  }
  if (Object.keys(settings).length > 0) middleware.push(defaultSettingsMiddleware({ settings }))
  if (middleware.length === 0) return model
  return wrapLanguageModel({ model, middleware })
}

type CallOptions = Parameters<NonNullable<LanguageModelMiddleware['wrapStream']>>[0]['params']

// 「自动」的输出上限被服务拒绝时（有的模型最多只能输出 8K），按报错里写的上限再发；报错里没有可用的数字就不指定，用 AI SDK 的默认值。
// 发成功的上限记在这个模型实例上（一个会话一个），之后的调用不用先被拒一次。调用方自己指定的上限、用户在设置里填的上限都不改，照常报错
function automaticOutputLimit(limit: number): LanguageModelMiddleware {
  let current: number | undefined = limit
  const send = async <T>(params: CallOptions, call: (params: CallOptions) => PromiseLike<T>): Promise<T> => {
    if (params.maxOutputTokens !== undefined) return call(params)
    let attempt = current
    for (;;) {
      try {
        const result = await call({ ...params, maxOutputTokens: attempt })
        current = attempt
        return result
      } catch (error) {
        if (attempt === undefined || !rejectsMaxTokens(error)) throw error
        attempt = maxTokensFromError(error, attempt)
      }
    }
  }
  return {
    wrapGenerate: ({ params, model }) => send(params, (sent) => model.doGenerate(sent)),
    wrapStream: ({ params, model }) => send(params, (sent) => model.doStream(sent)),
  }
}

function defaultMaxOutputTokens(endpoint: ModelEndpoint, modelId: string): number | null {
  const anthropic = endpoint.protocol === 'anthropic' || endpoint.protocol === 'anthropic-compatible'
  return anthropic && !modelId.includes('claude-') ? ANTHROPIC_COMPATIBLE_MAX_OUTPUT_TOKENS : null
}

// 端点身份优先：DeepSeek 官方地址，或者别的服务上 deepseek- 开头的模型
function isDeepSeek(baseUrl: string, modelId: string): boolean {
  const host = URL.parse(baseUrl)?.hostname.toLowerCase() ?? ''
  if (host === 'deepseek.com' || host.endsWith('.deepseek.com')) return true
  const model = modelId.toLowerCase()
  return model.startsWith('deepseek-') || model.includes('/deepseek-')
}

// DeepSeek 思考模式带工具时，之后的每次请求里每条 assistant 消息都要带 reasoning_content，缺了回 400。
// AI SDK 遇到空的思考内容会省掉这个字段，换模型继续时旧消息也没有，这里补成空串；非思考模式下服务会忽略它
function withReasoningContent(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.messages)) return body
  const messages = body.messages.map((message: unknown) =>
    typeof message === 'object' && message !== null && 'role' in message && message.role === 'assistant' &&
    !('reasoning_content' in message && typeof message.reasoning_content === 'string')
      ? { ...message, reasoning_content: '' }
      : message,
  )
  return { ...body, messages }
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
      return createOpenAICompatible({
        name: 'openai-compatible',
        baseURL: trimSlash(baseUrl),
        apiKey,
        ...(isDeepSeek(baseUrl, modelId) ? { transformRequestBody: withReasoningContent } : {}),
      }).chatModel(modelId)
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

// 默认先思考的模型，输出上限太小时预算在思考里就用完了，来不及调工具
const PROBE_MAX_OUTPUT_TOKENS = 2048

// agent 靠工具调用干活：让模型必须调用一个工具，看它会不会
async function probeToolCalling(
  model: LanguageModel,
  apiKey: string,
  timeoutMs: number,
): Promise<{ supported: boolean; detail: string | null }> {
  const abortSignal = AbortSignal.timeout(timeoutMs)
  const probe = (toolChoice: 'required' | 'auto') =>
    generateText({
      model,
      prompt: 'Call the echo tool with text "OK".',
      tools: { echo: tool({ description: 'Echo the given text', inputSchema: z.object({ text: z.string() }) }) },
      toolChoice,
      maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
      maxRetries: 0,
      abortSignal,
      headers: MODEL_CALL_HEADERS,
    })
  let result: Awaited<ReturnType<typeof probe>>
  try {
    result = await probe('required')
  } catch (error) {
    // 有的服务（比如思考模式下）不接受 tool_choice: required，改用 auto 再探一次；密钥、超时、限流、连不上这类错误不重试
    const failure = toModelError(error, apiKey, timeoutMs)
    if (failure.kind !== 'unknown') return { supported: false, detail: failure.message }
    try {
      result = await probe('auto')
    } catch (retryError) {
      return { supported: false, detail: toModelError(retryError, apiKey, timeoutMs).message }
    }
  }
  return result.toolCalls.length > 0
    ? { supported: true, detail: null }
    : { supported: false, detail: '模型没有按要求调用工具' }
}
