import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export type ScriptStep = { toolCalls: Array<{ name: string; input: unknown }> } | { text: string }

export interface ScriptedModel {
  baseUrl: string
  // 每次对话请求的原始请求体（不含轻量安全扫描），按收到的顺序
  bodies(): string[]
  close(): Promise<void>
}

// 轻量安全扫描的请求按系统提示词认出来，回「没有问题」，不占剧本的步骤
const SECURITY_REVIEW_MARKER = 'You are a security reviewer'

// OpenAI 兼容的流式接口：每收到一次对话请求，按顺序返回剧本里的下一步
export async function startScriptedModel(steps: ScriptStep[]): Promise<ScriptedModel> {
  let served = 0
  const bodies: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end()
        return
      }
      const body = Buffer.concat(chunks).toString('utf8')
      const review = body.includes(SECURITY_REVIEW_MARKER)
      if (!review) bodies.push(body)
      const index = review ? -1 : served++
      const step: ScriptStep = review ? { text: 'NO_FINDINGS' } : (steps[index] ?? { text: '（剧本已结束）' })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const chunk of chunksFor(step, index)) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    bodies: () => [...bodies],
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

function chunksFor(step: ScriptStep, index: number): unknown[] {
  const base = { id: `chatcmpl-${index}`, object: 'chat.completion.chunk', created: 1, model: 'scripted' }
  const usage = { prompt_tokens: 1200, completion_tokens: 20, total_tokens: 1220 }
  if ('text' in step) {
    return [
      { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: step.text }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage },
    ]
  }
  const toolCalls = step.toolCalls.map((call, callIndex) => ({
    index: callIndex,
    id: `call_${index}_${callIndex}`,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.input) },
  }))
  return [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: toolCalls }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage },
  ]
}
