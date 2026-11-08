import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { connectToCore, handshake, requestListModels, requestTestModel } from '../src/client.js'
import { generateText } from 'ai'
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
