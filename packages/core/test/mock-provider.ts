import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export const GOOD_KEY = 'good-key-1234'

export interface MockProvider {
  baseUrl: string
  requests: Array<{ method: string; path: string; headers: IncomingHttpHeaders; body?: string }>
  close(): Promise<void>
}

// 模拟 OpenAI 兼容（/openai/v1）和 Anthropic 兼容（/anthropic/v1）两种接口。
// /nomodels 不提供模型列表；/slow 永远不响应，用来测超时。
export async function startMockProvider(): Promise<MockProvider> {
  const requests: MockProvider['requests'] = []
  const server: Server = createServer((req, res) => {
    const path = req.url ?? ''
    const request: MockProvider['requests'][number] = { method: req.method ?? '', path, headers: req.headers }
    requests.push(request)
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      if (path.startsWith('/slow/')) return
      const raw = Buffer.concat(chunks).toString('utf8')
      request.body = raw
      // 请求里带了工具（测试连接的工具调用探测），就返回一次工具调用
      const wantsTool = raw.includes('"tools"')

      const bearer = req.headers.authorization === `Bearer ${GOOD_KEY}`
      const xApiKey = req.headers['x-api-key'] === GOOD_KEY
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
      }

      if (path.startsWith('/nomodels/')) return send(404, { error: { message: 'Not Found' } })

      if (path.startsWith('/openai/v1/')) {
        if (!bearer) {
          return send(401, { error: { message: `Incorrect API key provided: ${req.headers.authorization}` } })
        }
        if (req.method === 'GET' && path === '/openai/v1/models') {
          return send(200, { object: 'list', data: [{ id: 'mock-b' }, { id: 'mock-a' }] })
        }
        if (req.method === 'POST' && path === '/openai/v1/chat/completions') {
          const body = JSON.parse(raw) as { model?: string; tool_choice?: unknown; max_tokens?: number; max_completion_tokens?: number }
          // mock-thinking：默认先思考，输出上限不到 1000 时思考就把预算用完，没有工具调用
          if (body.model === 'mock-thinking' && wantsTool && (body.max_tokens ?? body.max_completion_tokens ?? Infinity) < 1000) {
            return send(200, {
              id: 'chatcmpl-1',
              object: 'chat.completion',
              created: 1,
              model: 'mock-thinking',
              choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
              usage: { prompt_tokens: 5, completion_tokens: 256, total_tokens: 261 },
            })
          }
          // mock-no-required：思考模式下不接受 tool_choice: required
          if (body.model === 'mock-no-required' && body.tool_choice === 'required') {
            return send(400, { error: { message: 'tool_choice "required" is not supported in thinking mode' } })
          }
          // mock-no-tools：带了工具也只回文字
          const callsTool = wantsTool && body.model !== 'mock-no-tools'
          const message = callsTool
            ? {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"text":"OK"}' } }],
              }
            : { role: 'assistant', content: 'OK' }
          return send(200, {
            id: 'chatcmpl-1',
            object: 'chat.completion',
            created: 1,
            model: 'mock-a',
            choices: [{ index: 0, message, finish_reason: callsTool ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
          })
        }
      }

      if (path.startsWith('/anthropic/v1/')) {
        if (!bearer || !xApiKey) return send(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })
        if (req.method === 'GET' && path.startsWith('/anthropic/v1/models')) {
          return send(200, { data: [{ id: 'claude-mock', display_name: 'Claude Mock' }], has_more: false })
        }
        if (req.method === 'POST' && path === '/anthropic/v1/messages') {
          const body = JSON.parse(raw) as { model?: string; max_tokens?: number; stream?: boolean }
          // mock-max-8192：最多输出 8192，超了按百炼的写法报范围；mock-max-vague：超过 4096 就拒，报错里不给数字
          if (body.model === 'mock-max-8192' && (body.max_tokens ?? 0) > 8192) {
            return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Range of max_tokens should be [1, 8192]' } })
          }
          if (body.model === 'mock-max-vague' && (body.max_tokens ?? 0) > 4096) {
            return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens is too large for this model' } })
          }
          // 流式请求只回一段文字 OK
          if (body.stream && !wantsTool) {
            const events = [
              { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-mock', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } },
              { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
              { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
              { type: 'content_block_stop', index: 0 },
              { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
              { type: 'message_stop' },
            ]
            res.writeHead(200, { 'Content-Type': 'text/event-stream' })
            res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
            return
          }
          return send(200, {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: 'claude-mock',
            content: wantsTool
              ? [{ type: 'tool_use', id: 'toolu_1', name: 'echo', input: { text: 'OK' } }]
              : [{ type: 'text', text: 'OK' }],
            stop_reason: wantsTool ? 'tool_use' : 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 1 },
          })
        }
      }

      send(404, { error: { message: `no route ${req.method} ${path}` } })
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

// 先占一个端口再释放，得到一个当前没人监听的地址
export async function unusedLocalUrl(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `http://127.0.0.1:${port}`
}
