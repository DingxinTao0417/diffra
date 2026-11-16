import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

// 测试用的、要浏览器登录的远程 MCP 服务器（v2 · M4）：同一个端口上既是授权服务器（RFC 8414 元数据、RFC 7591 动态注册、
// 授权码 + PKCE、刷新、RFC 7009 撤销），也是受保护的 MCP 服务器（RFC 9728 元数据，没带有效令牌回 401 和 WWW-Authenticate）。
// /authorize 不要人点：直接带着授权码跳回回调地址（deny 时带 error）。core 单测和桌面端 e2e 共用
export interface OAuthMcpServer {
  // MCP 的地址
  url: string
  registrations(): number
  // 换令牌的请求，按 grant_type 记
  tokenRequests(): string[]
  revoked(): string[]
  // 下一次发的访问令牌多久过期（秒）
  setExpiresIn(seconds: number): void
  // 用户在授权页点了拒绝
  setDeny(deny: boolean): void
  // 让已经发出去的刷新令牌都失效
  revokeRefreshTokens(): void
  close(): Promise<void>
}

const base64url = (buffer: Buffer) => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function buildServer(): McpServer {
  const server = new McpServer({ name: 'diffra-oauth-test', version: '1.0.0' })
  server.registerTool('whoami', { description: 'Who is signed in', inputSchema: { note: z.string().optional() }, annotations: { readOnlyHint: true } }, async () => ({
    content: [{ type: 'text', text: 'signed in via oauth' }],
  }))
  return server
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export async function startOAuthMcpServer(): Promise<OAuthMcpServer> {
  let base = ''
  let expiresIn = 3600
  let deny = false
  let registrations = 0
  const tokenRequests: string[] = []
  const revoked: string[] = []
  const clients = new Map<string, string[]>()
  const codes = new Map<string, { client: string; redirect: string; challenge: string }>()
  const access = new Map<string, number>()
  const refresh = new Set<string>()
  const transports = new Map<string, StreamableHTTPServerTransport>()

  const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  const issue = (res: ServerResponse) => {
    const accessToken = `at-${randomUUID()}`
    const refreshToken = `rt-${randomUUID()}`
    access.set(accessToken, Date.now() + expiresIn * 1000)
    refresh.add(refreshToken)
    json(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: expiresIn, refresh_token: refreshToken, scope: 'mcp' })
  }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', base)
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] })
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        revocation_endpoint: `${base}/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      })
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      registrations++
      const body = JSON.parse(await readBody(req)) as { redirect_uris: string[] }
      const id = `client-${registrations}`
      clients.set(id, body.redirect_uris)
      return json(res, 201, { ...body, client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000) })
    }
    if (url.pathname === '/authorize') {
      const client = url.searchParams.get('client_id') ?? ''
      const redirect = url.searchParams.get('redirect_uri') ?? ''
      if (!clients.get(client)?.includes(redirect) || url.searchParams.get('code_challenge_method') !== 'S256') return json(res, 400, { error: 'invalid_request' })
      const target = new URL(redirect)
      target.searchParams.set('state', url.searchParams.get('state') ?? '')
      if (deny) target.searchParams.set('error', 'access_denied')
      else {
        const code = `code-${randomUUID()}`
        codes.set(code, { client, redirect, challenge: url.searchParams.get('code_challenge') ?? '' })
        target.searchParams.set('code', code)
      }
      return res.writeHead(302, { Location: target.toString() }).end()
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const body = new URLSearchParams(await readBody(req))
      const grant = body.get('grant_type') ?? ''
      tokenRequests.push(grant)
      if (grant === 'authorization_code') {
        const saved = codes.get(body.get('code') ?? '')
        codes.delete(body.get('code') ?? '')
        const challenge = base64url(createHash('sha256').update(body.get('code_verifier') ?? '').digest())
        if (!saved || saved.challenge !== challenge || saved.redirect !== body.get('redirect_uri') || saved.client !== body.get('client_id')) return json(res, 400, { error: 'invalid_grant' })
        return issue(res)
      }
      if (grant === 'refresh_token') {
        const token = body.get('refresh_token') ?? ''
        if (!refresh.has(token)) return json(res, 400, { error: 'invalid_grant' })
        refresh.delete(token)
        return issue(res)
      }
      return json(res, 400, { error: 'unsupported_grant_type' })
    }
    if (url.pathname === '/revoke' && req.method === 'POST') {
      const token = new URLSearchParams(await readBody(req)).get('token') ?? ''
      revoked.push(token)
      access.delete(token)
      refresh.delete(token)
      return res.writeHead(200).end()
    }
    if (url.pathname === '/mcp') {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? ''
      const expires = access.get(token)
      if (expires === undefined || expires < Date.now()) {
        return res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`, 'Content-Type': 'text/plain' }).end('unauthorized')
      }
      const sessionId = req.headers['mcp-session-id']
      let transport = typeof sessionId === 'string' ? transports.get(sessionId) : undefined
      if (!transport) {
        const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: (id) => void transports.set(id, created) })
        created.onclose = () => {
          if (created.sessionId) transports.delete(created.sessionId)
        }
        await buildServer().connect(created)
        transport = created
      }
      return transport.handleRequest(req, res)
    }
    res.writeHead(404).end()
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error('[oauth-mcp-server]', error)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url: `${base}/mcp`,
    registrations: () => registrations,
    tokenRequests: () => [...tokenRequests],
    revoked: () => [...revoked],
    setExpiresIn: (seconds) => (expiresIn = seconds),
    setDeny: (value) => (deny = value),
    revokeRefreshTokens: () => refresh.clear(),
    close: async () => {
      for (const transport of transports.values()) await transport.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
