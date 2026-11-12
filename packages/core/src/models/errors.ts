import { APICallError, RetryError } from 'ai'
import type { ModelError, ModelErrorKind } from './types.js'

const MAX_DETAIL_LENGTH = 300

const KIND_LABELS: Record<ModelErrorKind, string> = {
  auth: '密钥无效或没有权限',
  'not-found': '地址或模型不存在',
  unsupported: '这个服务不提供模型列表，请手动添加模型',
  'rate-limit': '请求过多或额度不足',
  server: '服务端出错',
  timeout: '请求超时',
  network: '无法连接到服务',
  unknown: '请求失败',
}

export function kindFromStatus(status: number, listing: boolean): ModelErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (listing && (status === 404 || status === 405)) return 'unsupported'
  if (status === 404) return 'not-found'
  if (status === 429) return 'rate-limit'
  if (status >= 500) return 'server'
  return 'unknown'
}

export function httpError(status: number, body: string, apiKey: string, listing: boolean): ModelError {
  return buildError(kindFromStatus(status, listing), extractDetail(body) || `HTTP ${status}`, apiKey, status)
}

// 有的服务（比如 DeepSeek 的思考模式）不接受指定要调哪个工具的 tool_choice，直接回 400；调用方改用 auto 再请求一次
export function rejectsToolChoice(error: unknown): boolean {
  const cause = RetryError.isInstance(error) ? error.lastError : error
  return APICallError.isInstance(cause) && cause.statusCode === 400 && /tool_choice/i.test(`${cause.message} ${cause.responseBody ?? ''}`)
}

// 输出上限超出了模型支持的范围：400（有的服务用 422），报错里提到 max_tokens
export function rejectsMaxTokens(error: unknown): boolean {
  const cause = RetryError.isInstance(error) ? error.lastError : error
  return APICallError.isInstance(cause) && (cause.statusCode === 400 || cause.statusCode === 422) && /max_tokens|max_output_tokens/i.test(`${cause.message} ${cause.responseBody ?? ''}`)
}

// 各家会在报错里写出允许的范围（「Range of max_tokens should be [1, 8192]」「max_tokens: 32000 > 8192」），
// 取比这次请求小、又不至于小得没法用的最大那个数；找不到返回 undefined
const MIN_USABLE_MAX_TOKENS = 1024
export function maxTokensFromError(error: unknown, requested: number): number | undefined {
  const cause = RetryError.isInstance(error) ? error.lastError : error
  const text = APICallError.isInstance(cause) ? `${cause.message} ${cause.responseBody ?? ''}` : String(cause)
  const numbers = (text.match(/\d[\d,]*/g) ?? []).map((match) => Number(match.replace(/,/g, '')))
  const usable = numbers.filter((value) => value >= MIN_USABLE_MAX_TOKENS && value < requested)
  return usable.length > 0 ? Math.max(...usable) : undefined
}

// 服务暂时出错、连不上、连接中途断开：原样再发一次可能就好了（限流、5xx、网络）。鉴权、地址、参数不对重发也没用
export function retryableModelError(error: unknown): boolean {
  const kind = toModelError(error, '', 0).kind
  return kind === 'rate-limit' || kind === 'server' || kind === 'network'
}

// 限流或服务过载（429、503、529）：自动重试用完了还是这样，配了备用模型就换它接着做
export function overloadedModelError(error: unknown): boolean {
  const cause = RetryError.isInstance(error) ? error.lastError : error
  return APICallError.isInstance(cause) && [429, 503, 529].includes(cause.statusCode ?? 0)
}

export function toModelError(error: unknown, apiKey: string, timeoutMs: number): ModelError {
  const cause = RetryError.isInstance(error) ? error.lastError : error

  if (APICallError.isInstance(cause)) {
    const status = cause.statusCode
    const detail = extractDetail(cause.responseBody ?? '') || cause.message
    if (status === undefined) return buildError('network', detail, apiKey)
    return buildError(kindFromStatus(status, false), detail, apiKey, status)
  }

  if (cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')) {
    return buildError('timeout', `${Math.round(timeoutMs / 1000)} 秒内没有响应`, apiKey)
  }

  // Node 的 fetch 连不上时抛 TypeError('fetch failed')，真正原因在 cause.code
  if (cause instanceof TypeError && cause.cause instanceof Error) {
    const code = 'code' in cause.cause ? String(cause.cause.code) : cause.cause.message
    return buildError('network', code, apiKey)
  }

  return buildError('unknown', cause instanceof Error ? cause.message : String(cause), apiKey)
}

function buildError(kind: ModelErrorKind, detail: string, apiKey: string, status?: number): ModelError {
  const clean = scrub(detail, apiKey).slice(0, MAX_DETAIL_LENGTH)
  return { kind, message: `${KIND_LABELS[kind]}：${clean}`, ...(status === undefined ? {} : { status }) }
}

// 有的服务会在报错里回显密钥，显示和写日志前先抹掉
function scrub(text: string, apiKey: string): string {
  return apiKey ? text.replaceAll(apiKey, '***') : text
}

function extractDetail(body: string): string {
  const trimmed = body.trim()
  if (!trimmed) return ''
  try {
    const parsed: unknown = JSON.parse(trimmed)
    const message = findMessage(parsed)
    if (message) return message
  } catch {
    // 不是 JSON，直接用原文
  }
  return trimmed
}

function findMessage(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  if ('message' in value && typeof value.message === 'string') return value.message
  if ('error' in value) {
    if (typeof value.error === 'string') return value.error
    return findMessage(value.error)
  }
  return undefined
}
