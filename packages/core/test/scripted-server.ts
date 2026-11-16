import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

// match：只回答第一条用户消息（不算环境上下文）里含这段文字的请求，按顺序；没写 match 的步骤回答其余请求。
// 几个候选方案、子智能体并行跑时请求的先后不定，靠它把剧本分给各自
// delayMs：晚这么久才回，测进行中的停止
export type ScriptStep = ({ toolCalls: Array<{ name: string; input: unknown }> } | { text: string }) & { match?: string; delayMs?: number }

export interface ScriptedServer {
  baseUrl: string
  // 每次对话请求的原始请求体，用来检查模型看到了什么
  bodies: string[]
  // rejectForcedToolChoice 时被拒掉的请求数，这些请求不占剧本的步骤
  rejected(): number
  close(): Promise<void>
}

// OpenAI 兼容的流式接口：每收到一次 chat/completions 请求，按顺序返回剧本里的下一步。
// rejectForcedToolChoice：像 DeepSeek 的思考模式那样，指定了要调哪个工具的请求回 400
export async function startScriptedServer(steps: ScriptStep[], options: { rejectForcedToolChoice?: boolean } = {}): Promise<ScriptedServer> {
  const bodies: string[] = []
  const used = new Set<number>()
  let rejected = 0
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end()
        return
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      const toolChoice: unknown = (JSON.parse(raw) as { tool_choice?: unknown }).tool_choice
      if (options.rejectForcedToolChoice && typeof toolChoice === 'object' && toolChoice !== null) {
        rejected++
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Thinking mode does not support this tool_choice', type: 'invalid_request_error' } }))
        return
      }
      const index = bodies.length
      bodies.push(raw)
      const first = firstUserText(raw)
      const matches = (item: ScriptStep) => item.match !== undefined && first.includes(item.match)
      const own = steps.some(matches)
      const at = steps.findIndex((item, position) => !used.has(position) && (own ? matches(item) : item.match === undefined))
      if (at >= 0) used.add(at)
      const step = at >= 0 ? steps[at]! : { text: '（剧本已结束）' }
      const respond = () => {
        if (res.destroyed) return
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        for (const chunk of chunksFor(step, index)) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        res.end('data: [DONE]\n\n')
      }
      if (step.delayMs) setTimeout(respond, step.delayMs)
      else respond()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    bodies,
    rejected: () => rejected,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

// Diffra 每步调模型前追加的环境上下文（[Diffra] Context 开头）不算用户的提问
function firstUserText(raw: string): string {
  const messages = (JSON.parse(raw) as { messages?: Array<{ role: string; content: unknown }> }).messages ?? []
  const text = (content: unknown) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => (typeof part === 'object' && part !== null && 'text' in part ? String(part.text) : '')).join('') : '')
  return text(messages.find((message) => message.role === 'user' && !text(message.content).startsWith('[Diffra] Context'))?.content)
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
