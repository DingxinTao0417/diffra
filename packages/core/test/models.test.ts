import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { connectToCore, handshake, requestListModels, requestTestModel } from '../src/client.js'
import { APICallError, generateText, type LanguageModel, type ModelMessage, streamText } from 'ai'
import { maxTokensFromError, rejectsMaxTokens } from '../src/models/errors.js'
import { createLanguageModel, listModels, testModel } from '../src/models/operations.js'
import { modelConfigSchema } from '../src/session/config.js'
import type { ModelEndpoint } from '../src/models/types.js'
import { GOOD_KEY, type MockProvider, startMockProvider, unusedLocalUrl } from './mock-provider.js'

let mock: MockProvider

beforeAll(async () => {
  mock = await startMockProvider()
})

afterAll(async () => {
  await mock.close()
})

function openai(apiKey = GOOD_KEY): ModelEndpoint {
  return { protocol: 'openai-compatible', baseUrl: `${mock.baseUrl}/openai/v1`, apiKey }
}

describe('思考程度', () => {
  test.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'default'] as const)('兼容接口实际传递 %s 参数', async (effort) => {
    await generateText({ model: createLanguageModel(openai(), 'mock-a', effort), prompt: 'OK', abortSignal: AbortSignal.timeout(5000), maxRetries: 0 })
    const request = mock.requests.findLast((item) => item.path === '/openai/v1/chat/completions')
    expect(request?.body).toBeDefined()
    const body: unknown = JSON.parse(request?.body ?? '{}')
    if (effort === 'default') expect(body).not.toHaveProperty('reasoning_effort')
    else expect(body).toHaveProperty('reasoning_effort', effort)
  })

  test('会话配置拒绝未知档位', () => {
    const model = { endpoint: openai(), modelId: 'mock-a', contextWindow: null, provider: null }
    expect(modelConfigSchema.safeParse({ ...model, reasoningEffort: 'invalid' }).success).toBe(false)
    expect(modelConfigSchema.parse({ ...model, reasoningEffort: 'high' }).reasoningEffort).toBe('high')
    expect(modelConfigSchema.safeParse(model).success).toBe(true)
  })
})

describe('DeepSeek 的思考内容', () => {
  // 第一条 assistant 没有思考内容（DeepSeek 返回空思考，或换模型前别的模型写的），第二条有
  const history: ModelMessage[] = [
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: [{ type: 'text', text: '直接回答' }] },
    { role: 'user', content: '第二问' },
    { role: 'assistant', content: [{ type: 'reasoning', text: '想了想' }, { type: 'text', text: '回答' }] },
    { role: 'user', content: '第三问' },
  ]
  const sentReasoning = async (modelId: string) => {
    await generateText({ model: createLanguageModel(openai(), modelId), messages: history, abortSignal: AbortSignal.timeout(5000), maxRetries: 0 })
    const request = mock.requests.findLast((item) => item.path === '/openai/v1/chat/completions')
    const body = JSON.parse(request?.body ?? '{}') as { messages: Array<{ role: string; reasoning_content?: string }> }
    return body.messages.filter((message) => message.role === 'assistant').map((message) => message.reasoning_content)
  }

  test('deepseek- 开头的模型：每条 assistant 消息都带 reasoning_content，没有的补空串', async () => {
    await expect(sentReasoning('deepseek-v4-pro')).resolves.toEqual(['', '想了想'])
  })

  test('其他模型不补', async () => {
    await expect(sentReasoning('mock-a')).resolves.toEqual([undefined, '想了想'])
  })
})

describe('最大输出', () => {
  const anthropic = (): ModelEndpoint => ({ protocol: 'anthropic-compatible', baseUrl: `${mock.baseUrl}/anthropic/`, apiKey: GOOD_KEY })
  const sentMaxTokens = async (path: string, model: LanguageModel, maxOutputTokens?: number) => {
    await generateText({ model, prompt: 'OK', maxOutputTokens, abortSignal: AbortSignal.timeout(5000), maxRetries: 0 })
    const request = mock.requests.findLast((item) => item.path === path)
    return (JSON.parse(request?.body ?? '{}') as { max_tokens?: number }).max_tokens
  }

  test('Anthropic 兼容接口的非 Claude 模型默认 32000；设置了按设置，调用时指定的优先；Claude 模型不受影响', async () => {
    const path = '/anthropic/v1/messages'
    await expect(sentMaxTokens(path, createLanguageModel(anthropic(), 'kimi-for-coding'))).resolves.toBe(32_000)
    await expect(sentMaxTokens(path, createLanguageModel(anthropic(), 'kimi-for-coding', undefined, 8000))).resolves.toBe(8000)
    await expect(sentMaxTokens(path, createLanguageModel(anthropic(), 'kimi-for-coding'), 64)).resolves.toBe(64)
    await expect(sentMaxTokens(path, createLanguageModel(anthropic(), 'claude-mock'))).resolves.not.toBe(32_000)
  })

  test('「自动」的上限被拒时按报错里的范围重发，流式也一样，之后的调用直接用它；报错里没有可用的数字就不指定', async () => {
    const path = '/anthropic/v1/messages'
    const sentFor = (modelId: string) =>
      mock.requests
        .filter((item) => item.path === path && item.body?.includes(`"model":"${modelId}"`))
        .map((item) => (JSON.parse(item.body ?? '{}') as { max_tokens?: number }).max_tokens)
    const limited = createLanguageModel(anthropic(), 'mock-max-8192')
    await expect(generateText({ model: limited, prompt: 'OK', maxRetries: 0 })).resolves.toMatchObject({ text: 'OK' })
    await expect(streamText({ model: limited, prompt: 'OK', maxRetries: 0 }).text).resolves.toBe('OK')
    expect(sentFor('mock-max-8192')).toEqual([32_000, 8192, 8192])

    const fresh = createLanguageModel(anthropic(), 'mock-max-8192')
    await expect(streamText({ model: fresh, prompt: 'OK', maxRetries: 0 }).text).resolves.toBe('OK')
    expect(sentFor('mock-max-8192')).toEqual([32_000, 8192, 8192, 32_000, 8192])

    // AI SDK 对不认识的模型默认 4096
    await expect(generateText({ model: createLanguageModel(anthropic(), 'mock-max-vague'), prompt: 'OK', maxRetries: 0 })).resolves.toMatchObject({ text: 'OK' })
    expect(sentFor('mock-max-vague')).toEqual([32_000, 4096])
  })

  test('用户填的上限、调用时指定的上限被拒时照常报错，不自动调低', async () => {
    await expect(generateText({ model: createLanguageModel(anthropic(), 'mock-max-8192', undefined, 16_000), prompt: 'OK', maxRetries: 0 })).rejects.toThrow('Range of max_tokens')
    await expect(generateText({ model: createLanguageModel(anthropic(), 'mock-max-8192'), prompt: 'OK', maxOutputTokens: 9000, maxRetries: 0 })).rejects.toThrow('Range of max_tokens')
  })

  test('从报错里取比请求小、又不小于 1024 的最大数字；只认提到 max_tokens 的 400、422', () => {
    const error = (message: string, statusCode = 400) => new APICallError({ message, url: 'http://x', requestBodyValues: {}, statusCode, isRetryable: false })
    expect(maxTokensFromError(error('Range of max_tokens should be [1, 8192]'), 32_000)).toBe(8192)
    expect(maxTokensFromError(error('max_tokens: 32000 > 16,384, which is the maximum allowed'), 32_000)).toBe(16_384)
    expect(maxTokensFromError(error('max_tokens must be at least 1'), 32_000)).toBeUndefined()
    expect(rejectsMaxTokens(error('Range of max_tokens should be [1, 8192]'))).toBe(true)
    expect(rejectsMaxTokens(error('max_output_tokens is too large', 422))).toBe(true)
    expect(rejectsMaxTokens(error('Range of max_tokens should be [1, 8192]', 500))).toBe(false)
    expect(rejectsMaxTokens(error('prompt is too long'))).toBe(false)
  })

  test('OpenAI 兼容接口默认不指定，设置了才发；和思考强度可以同时用', async () => {
    const path = '/openai/v1/chat/completions'
    await expect(sentMaxTokens(path, createLanguageModel(openai(), 'mock-a'))).resolves.toBeUndefined()
    await expect(sentMaxTokens(path, createLanguageModel(openai(), 'mock-a', 'high', 16_000))).resolves.toBe(16_000)
    const body: unknown = JSON.parse(mock.requests.findLast((item) => item.path === path)?.body ?? '{}')
    expect(body).toHaveProperty('reasoning_effort', 'high')
  })

  test('会话配置：不填是 null，只接受正整数', () => {
    const model = { endpoint: openai(), modelId: 'mock-a', contextWindow: null, provider: null }
    expect(modelConfigSchema.parse(model).maxOutputTokens).toBeNull()
    expect(modelConfigSchema.parse({ ...model, maxOutputTokens: 8000 }).maxOutputTokens).toBe(8000)
    expect(modelConfigSchema.safeParse({ ...model, maxOutputTokens: 0 }).success).toBe(false)
  })
})

describe('OpenAI 兼容', () => {
  test('拉取模型列表并按 id 排序，带 Diffra 的 User-Agent', async () => {
    await expect(listModels(openai())).resolves.toEqual({
      ok: true,
      models: [
        { id: 'mock-a', name: undefined },
        { id: 'mock-b', name: undefined },
      ],
    })
    const call = mock.requests.findLast((r) => r.path === '/openai/v1/models')
    expect(call?.headers['user-agent']).toContain('diffra-core/')
  })

  test('密钥错误时归为 auth，且报错里不回显密钥', async () => {
    const result = await listModels(openai('wrong-secret-key'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('auth')
    expect(result.error.status).toBe(401)
    expect(result.error.message).not.toContain('wrong-secret-key')
  })

  test('测试连接返回模型回复，并带上 Diffra 的 User-Agent', async () => {
    const result = await testModel(openai(), 'mock-a')
    expect(result).toMatchObject({ ok: true, reply: 'OK', tools: { supported: true } })
    const call = mock.requests.findLast((r) => r.path === '/openai/v1/chat/completions')
    expect(call?.headers['user-agent']).toContain('diffra-core/')
  })

  test('默认先思考的模型：工具调用探测留够输出预算，不会被思考吃光', async () => {
    await expect(testModel(openai(), 'mock-thinking')).resolves.toMatchObject({ ok: true, tools: { supported: true } })
  })

  test('不接受 tool_choice: required 的模型：探测改用 auto 再试一次', async () => {
    await expect(testModel(openai(), 'mock-no-required')).resolves.toMatchObject({ ok: true, tools: { supported: true } })
  })

  test('测试连接时密钥错误归为 auth', async () => {
    const result = await testModel(openai('wrong-secret-key'), 'mock-a')
    expect(result).toMatchObject({ ok: false, error: { kind: 'auth', status: 401 } })
    if (!result.ok) expect(result.error.message).not.toContain('wrong-secret-key')
  })
})

describe('Anthropic 兼容', () => {
  // 地址按 Claude Code 的约定不带 /v1，请求应落到 /anthropic/v1/...
  const endpoint = (): ModelEndpoint => ({
    protocol: 'anthropic-compatible',
    baseUrl: `${mock.baseUrl}/anthropic/`,
    apiKey: GOOD_KEY,
  })

  test('拉取模型列表，同时带 x-api-key 和 Bearer', async () => {
    await expect(listModels(endpoint())).resolves.toEqual({
      ok: true,
      models: [{ id: 'claude-mock', name: 'Claude Mock' }],
    })
  })

  test('测试连接请求 /v1/messages', async () => {
    await expect(testModel(endpoint(), 'claude-mock')).resolves.toMatchObject({ ok: true, reply: 'OK', tools: { supported: true } })
    expect(mock.requests.some((r) => r.method === 'POST' && r.path === '/anthropic/v1/messages')).toBe(true)
  })
})

describe('异常情况', () => {
  test('服务不提供模型列表时归为 unsupported', async () => {
    const result = await listModels({ protocol: 'openai-compatible', baseUrl: `${mock.baseUrl}/nomodels/v1`, apiKey: GOOD_KEY })
    expect(result).toMatchObject({ ok: false, error: { kind: 'unsupported', status: 404 } })
  })

  test('超时归为 timeout', async () => {
    const endpoint: ModelEndpoint = { protocol: 'openai-compatible', baseUrl: `${mock.baseUrl}/slow/v1`, apiKey: GOOD_KEY }
    await expect(testModel(endpoint, 'mock-a', { timeoutMs: 300 })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'timeout' },
    })
    await expect(listModels(endpoint, { timeoutMs: 300 })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'timeout' },
    })
  })

  test('连不上时归为 network', async () => {
    const endpoint: ModelEndpoint = { protocol: 'openai-compatible', baseUrl: `${await unusedLocalUrl()}/v1`, apiKey: GOOD_KEY }
    await expect(listModels(endpoint)).resolves.toMatchObject({ ok: false, error: { kind: 'network' } })
    await expect(testModel(endpoint, 'mock-a')).resolves.toMatchObject({ ok: false, error: { kind: 'network' } })
  })
})

describe('通过 ACP 扩展方法调用命令行版 core', () => {
  test('拉取模型列表和测试连接，参数不合法时报错', async () => {
    const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url))
    const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'inherit'] })
    try {
      const connection = connectToCore(child.stdin, child.stdout)
      await handshake(connection, 10_000)
      await expect(requestListModels(connection, openai())).resolves.toMatchObject({ ok: true })
      await expect(requestTestModel(connection, openai(), 'mock-a')).resolves.toMatchObject({ ok: true, reply: 'OK' })
      await expect(
        requestListModels(connection, { protocol: 'openai-compatible', baseUrl: 'not-a-url', apiKey: GOOD_KEY }),
      ).rejects.toThrow()
    } finally {
      child.kill()
    }
  })
})
