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
          const message = wantsTool
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
            choices: [{ index: 0, message, finish_reason: wantsTool ? 'tool_calls' : 'stop' }],
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
