import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

// 测试用的远程 MCP 服务器：官方 SDK 的 Streamable HTTP 服务端（回复走 SSE，和多数线上服务器一样），
// 每个连接一个会话；要求请求头 Authorization: Bearer <token>。core 单测和桌面端 e2e 共用
export interface HttpMcpServer {
  url: string
  // 收到的每个请求带的 Authorization
  authorizations(): string[]
  close(): Promise<void>
}

function buildServer(): McpServer {
  const server = new McpServer({ name: 'diffra-http-test', version: '1.0.0' })
  server.registerTool(
    'echo',
    { description: 'Echo the text back', inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
    async ({ text }) => ({ content: [{ type: 'text', text: `remote echo: ${text}` }] }),
  )
  server.registerPrompt('summarize', { description: 'Summarize a topic', argsSchema: { topic: z.string() } }, ({ topic }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `Summarize ${topic}` } }],
  }))
  return server
}

export async function startHttpMcpServer(token: string): Promise<HttpMcpServer> {
  const transports = new Map<string, StreamableHTTPServerTransport>()
  const authorizations: string[] = []

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    authorizations.push(req.headers.authorization ?? '')
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'Content-Type': 'text/plain' }).end('invalid token')
      return
    }
    const sessionId = req.headers['mcp-session-id']
    let transport = typeof sessionId === 'string' ? transports.get(sessionId) : undefined
    if (!transport) {
      if (typeof sessionId === 'string') {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('unknown session')
        return
      }
      const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => {
          transports.set(id, created)
        },
      })
      created.onclose = () => {
        if (created.sessionId) transports.delete(created.sessionId)
      }
      await buildServer().connect(created)
      transport = created
    }
    await transport.handleRequest(req, res)
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error('[mcp-http-server]', error)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    authorizations: () => [...authorizations],
    close: async () => {
      for (const transport of transports.values()) await transport.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
