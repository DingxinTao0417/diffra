import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

// 一次模型调用的回复：文字、工具调用，或者先说一段话再调工具；delayMs 用来模拟慢的回复；
// promptTokens 是这次报给 Diffra 的输入 token 数，默认 1200，用来模拟上下文快满。
// 工具参数可以是函数：拿这次请求的对话（messages）算出来，比如用前一个工具返回的节点 id。
// match：只回答第一条用户消息里含这段文字的请求（子智能体的对话从它的任务开始），按顺序；没写 match 的步骤回答其余请求
export type ScriptMessages = Array<{ role: string; content: unknown; tool_calls?: unknown }>
type ScriptInput = unknown | ((messages: ScriptMessages) => unknown)
type StepTiming = { delayMs?: number; promptTokens?: number; cacheReadTokens?: number; match?: string }
export type ScriptStep =
  | ({ toolCalls: Array<{ name: string; input: ScriptInput }>; text?: string } & StepTiming)
  | ({ text: string } & StepTiming)

// 对话里最后一个工具结果（字符串）
export function lastToolResult(messages: ScriptMessages): string {
  const content = messages.filter((message) => message.role === 'tool').at(-1)?.content
  return typeof content === 'string' ? content : JSON.stringify(content)
}

function firstUserText(messages: ScriptMessages): string {
  const content = messages.find((message) => message.role === 'user')?.content
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map((part) => (typeof part === 'object' && part !== null && 'text' in part ? String(part.text) : '')).join('') : ''
}

export interface ScriptedModel {
  baseUrl: string
  // 已经收到的对话请求数（不含轻量安全扫描）
  requests(): number
  // 每次对话请求的原始请求体，按收到的顺序
  bodies(): string[]
  // 收到的轻量安全扫描请求数
  securityReviews(): number
  // 收到的完成前规范审查请求数
  ruleReviews(): number
  close(): Promise<void>
}

// 轻量安全扫描和完成前规范审查的请求按系统提示词认出来，分别按 securityReplies、reviewReplies 回复，
// 不占剧本的步骤；用完后回「没有问题」。规范审查默认开着，改了文件的任务都会多一次审查请求
const SECURITY_REVIEW_MARKER = 'You are a security reviewer'
const RULE_REVIEW_MARKER = 'You review a code change against coding rules.'

// OpenAI 兼容的流式接口：每收到一次 chat/completions 请求，按顺序返回剧本里的下一步
export async function startScriptedModel(
  steps: ScriptStep[],
  options: { securityReplies?: string[]; reviewReplies?: string[] } = {},
): Promise<ScriptedModel> {
  let served = 0
  const used = new Set<number>()
  let reviews = 0
  let ruleReviews = 0
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
      // 配置向导的真实连接/工具探测不消耗任务剧本，独立返回非流式兼容响应。
      if (!/"stream"\s*:\s*true/.test(body)) {
        const toolsRequested = /"tools"\s*:/.test(body)
        const message = toolsRequested ? { role: 'assistant', content: null, tool_calls: [{ id: 'probe', type: 'function', function: { name: 'echo', arguments: '{"text":"OK"}' } }] } : { role: 'assistant', content: 'OK' }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'probe', object: 'chat.completion', created: 1, model: 'scripted', choices: [{ index: 0, message, finish_reason: toolsRequested ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
        return
      }
      let step: ScriptStep
      let index: number
      if (body.includes(SECURITY_REVIEW_MARKER)) {
        step = { text: options.securityReplies?.[reviews] ?? 'NO_FINDINGS' }
        index = 1000 + reviews++
      } else if (body.includes(RULE_REVIEW_MARKER)) {
        step = { text: options.reviewReplies?.[ruleReviews] ?? 'NO_VIOLATIONS' }
        index = 2000 + ruleReviews++
      } else {
        const messages = (JSON.parse(body) as { messages: ScriptMessages }).messages
        const first = firstUserText(messages)
        const matches = (item: ScriptStep) => item.match !== undefined && first.includes(item.match)
        // 第一条用户消息对得上某个 match 的请求只从这些步骤里取；其余请求取没写 match 的步骤
        const own = steps.some(matches)
        const at = steps.findIndex((item, position) => !used.has(position) && (own ? matches(item) : item.match === undefined))
        if (at >= 0) used.add(at)
        step = at >= 0 ? steps[at]! : { text: '（剧本已结束）' }
        if ('toolCalls' in step) step = { ...step, toolCalls: step.toolCalls.map((call) => ({ ...call, input: typeof call.input === 'function' ? call.input(messages) : call.input })) }
        bodies.push(body)
        index = served++
      }
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        for (const chunk of chunksFor(step, index)) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        res.end('data: [DONE]\n\n')
      }, step.delayMs ?? 0)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests: () => served,
    bodies: () => [...bodies],
    securityReviews: () => reviews,
    ruleReviews: () => ruleReviews,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

function chunksFor(step: ScriptStep, index: number): unknown[] {
  const base = { id: `chatcmpl-${index}`, object: 'chat.completion.chunk', created: 1, model: 'scripted' }
  const promptTokens = step.promptTokens ?? 1200
  const usage = {
    prompt_tokens: promptTokens,
    completion_tokens: 20,
    total_tokens: promptTokens + 20,
    ...(step.cacheReadTokens === undefined ? {} : { prompt_tokens_details: { cached_tokens: step.cacheReadTokens } }),
  }
  const textChunks = step.text ? [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: step.text }, finish_reason: null }] }] : []
  if (!('toolCalls' in step)) {
    return [...textChunks, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }]
  }
  const toolCalls = step.toolCalls.map((call, callIndex) => ({
    index: callIndex,
    id: `call_${index}_${callIndex}`,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.input) },
  }))
  return [
    ...textChunks,
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: toolCalls }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage },
  ]
}
