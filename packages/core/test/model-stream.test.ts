import { setTimeout as delay } from 'node:timers/promises'
import { APICallError, simulateReadableStream, streamText } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { streamParts } from '../src/models/stream.js'
import { callReviewer } from '../src/rules/review.js'

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>
type StreamPart = StreamResult['stream'] extends ReadableStream<infer Part> ? Part : never

const serviceError = () => new APICallError({ message: 'HTTP 503', url: 'http://127.0.0.1:1/chat/completions', requestBodyValues: {}, statusCode: 503, isRetryable: false })

const said = (text: string | null): StreamPart[] => [
  { type: 'stream-start', warnings: [] },
  ...(text === null ? [] : [{ type: 'text-start' as const, id: 't' }, { type: 'text-delta' as const, id: 't', delta: text }]),
]

// 报错后流正常结束；text 为 null 是还没有任何输出就报错
const failing = (text: string | null): StreamResult => ({ stream: simulateReadableStream<StreamPart>({ chunks: [...said(text), { type: 'error', error: serviceError() }] }) })

// 报了错却不关连接
const hanging = (): StreamResult => ({
  stream: new ReadableStream<StreamPart>({
    start(controller) {
      for (const part of said('前半句')) controller.enqueue(part)
      controller.enqueue({ type: 'error', error: serviceError() })
    },
  }),
})

// 还没有输出就报错的流被中途取消时，AI SDK 内部会留下一个没人接的 rejection（原因是 undefined）；core 里没有兜底的处理
let unhandled: unknown[] = []
const record = (reason: unknown) => unhandled.push(reason)

beforeEach(() => {
  unhandled = []
  process.on('unhandledRejection', record)
})

afterEach(() => {
  process.off('unhandledRejection', record)
})

// 没人接的 rejection 要到下一轮事件循环才报
const settled = () => delay(100)

async function readTexts(stream: StreamResult): Promise<{ texts: string[]; error: unknown; aborted: boolean }> {
  const attempt = new AbortController()
  const result = streamText({ model: new MockLanguageModelV4({ doStream: [stream] }), prompt: 'hi', maxRetries: 0, abortSignal: attempt.signal, onError: () => {} })
  const texts: string[] = []
  let error: unknown = null
  try {
    for await (const part of streamParts(result.fullStream, () => attempt.abort())) {
      if (part.type === 'text-delta') texts.push(part.text)
    }
  } catch (caught) {
    error = caught
  }
  return { texts, error, aborted: attempt.signal.aborted }
}

describe('读模型的流', () => {
  test('还没有输出就报错：读完再抛，不留下没人接的 rejection', async () => {
    const { texts, error } = await readTexts(failing(null))
    expect(texts).toEqual([])
    expect(error).toMatchObject({ statusCode: 503 })
    await settled()
    expect(unhandled).toEqual([])
  })

  test('说到一半报错：已经说的照常交给调用方，然后抛出', async () => {
    const { texts, error } = await readTexts(failing('前半句'))
    expect(texts).toEqual(['前半句'])
    expect(error).toMatchObject({ statusCode: 503 })
  })

  test('服务报了错却不关连接：中断请求，马上抛出', async () => {
    const { texts, error, aborted } = await readTexts(hanging())
    expect(texts).toEqual(['前半句'])
    expect(error).toMatchObject({ statusCode: 503 })
    expect(aborted).toBe(true)
  }, 5000)
})

describe('评审模型的调用', () => {
  test('还没有输出就报错：抛出那个错误，不留下没人接的 rejection', async () => {
    const model = new MockLanguageModelV4({ doStream: [failing(null)] })
    await expect(callReviewer(model, { system: 's', prompt: 'p' }, AbortSignal.timeout(5000))).rejects.toMatchObject({ statusCode: 503 })
    await settled()
    expect(unhandled).toEqual([])
  })

  test('服务报了错却不关连接：不等到超时，马上抛出', async () => {
    const model = new MockLanguageModelV4({ doStream: [hanging()] })
    await expect(callReviewer(model, { system: 's', prompt: 'p' }, AbortSignal.timeout(30_000))).rejects.toMatchObject({ statusCode: 503 })
  }, 5000)
})
