import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export type ScriptStep = { toolCalls: Array<{ name: string; input: unknown }> } | { text: string }

export interface ScriptedModel {
  baseUrl: string
  // 已经收到的对话请求数
  requests(): number
  close(): Promise<void>
}

// OpenAI 兼容的流式接口：每收到一次 chat/completions 请求，按顺序返回剧本里的下一步
export async function startScriptedModel(steps: ScriptStep[]): Promise<ScriptedModel> {
  let served = 0
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end()
        return
      }
      const step = steps[served] ?? { text: '（剧本已结束）' }
      const index = served++
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const chunk of chunksFor(step, index)) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests: () => served,
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
