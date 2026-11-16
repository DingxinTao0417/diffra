import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { McpOAuth, oauthKey, type OAuthStorage } from '../src/mcp-oauth.js'
import { type OAuthMcpServer, startOAuthMcpServer } from './fixtures/oauth-mcp-server.js'

let server: OAuthMcpServer
let stored: Map<string, string>
const storage: OAuthStorage = {
  get: async (key) => stored.get(key) ?? null,
  set: async (key, value) => void stored.set(key, value),
  delete: async (key) => void stored.delete(key),
}
// 测试里的「浏览器」：打开授权页、跟着跳回本机的回调地址，相当于用户点了同意
const browser = { opened: [] as string[], open: async (url: string) => void (browser.opened.push(url), await fetch(url)) }

beforeEach(async () => {
  server = await startOAuthMcpServer()
  stored = new Map()
  browser.opened = []
})

afterEach(async () => {
  await server.close()
})

async function callWhoami(token: string | null): Promise<string> {
  const client = new Client({ name: 'test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(server.url), token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {})
  try {
    await client.connect(transport)
    const result = await client.callTool({ name: 'whoami', arguments: {} })
    return (result.content as Array<{ text: string }>)[0]!.text
  } finally {
    await client.close().catch(() => {})
  }
}

describe('MCP 的浏览器登录（OAuth 2.1 + PKCE）', () => {
  test('登录：找到授权服务器、动态注册、在浏览器里同意后换到令牌；令牌只在存储里，用它能连上', async () => {
    const auth = new McpOAuth(server.url, storage, { openBrowser: browser.open })
    expect(await auth.state()).toEqual({ status: 'signed-out', expiresAt: null, scope: null })
    const state = await auth.login()
    expect(state).toMatchObject({ status: 'signed-in', scope: 'mcp' })
    expect(server.registrations()).toBe(1)
    // 授权页带着 PKCE（S256）和回环地址的回调
    const authorize = new URL(browser.opened[0]!)
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorize.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(server.tokenRequests()).toEqual(['authorization_code'])
    const token = await auth.accessToken()
    expect(token).toMatch(/^at-/)
    expect([...stored.keys()].sort()).toEqual([`${oauthKey(server.url)}:client`, `${oauthKey(server.url)}:tokens`])
    expect(await callWhoami(token)).toBe('signed in via oauth')
    await expect(callWhoami(null)).rejects.toThrow()
  })

  test('快过期时用刷新令牌换新的，不弹浏览器；刷新令牌也不能用了就算过期、要重新登录', async () => {
    server.setExpiresIn(30)
    const auth = new McpOAuth(server.url, storage, { openBrowser: browser.open })
    await auth.login()
    const first = await auth.accessToken()
    // 离过期不到一分钟：先刷新
    expect(server.tokenRequests()).toEqual(['authorization_code', 'refresh_token'])
    expect(first).toMatch(/^at-/)
    expect(await callWhoami(first)).toBe('signed in via oauth')
    expect(browser.opened).toHaveLength(1)

    server.revokeRefreshTokens()
    expect(await auth.accessToken()).toBeNull()
    expect((await auth.state()).status).toBe('expired')
    expect(browser.opened).toHaveLength(1)
  })

  test('退出登录：在授权服务器上撤销两个令牌，本机的删掉，旧令牌连不上了', async () => {
    const auth = new McpOAuth(server.url, storage, { openBrowser: browser.open })
    await auth.login()
    const token = await auth.accessToken()
    expect(await auth.logout()).toEqual({ revoked: true })
    expect(server.revoked()).toHaveLength(2)
    expect(server.revoked()).toContain(token)
    expect(stored.size).toBe(0)
    expect((await auth.state()).status).toBe('signed-out')
    await expect(callWhoami(token)).rejects.toThrow()
  })

  test('用户在授权页拒绝、一直没去浏览器里点、点了取消：说明原因，不留半截登录', async () => {
    server.setDeny(true)
    const denied = new McpOAuth(server.url, storage, { openBrowser: browser.open })
    await expect(denied.login()).rejects.toThrow('授权服务器拒绝了登录：access_denied')
    expect((await denied.state()).status).toBe('signed-out')

    const slow = new McpOAuth(server.url, storage, { openBrowser: async () => {}, loginTimeoutMs: 300 })
    await expect(slow.login()).rejects.toThrow('还没在浏览器里完成登录')

    const controller = new AbortController()
    const cancelled = new McpOAuth(server.url, storage, { openBrowser: async () => void setTimeout(() => controller.abort(), 50) })
    await expect(cancelled.login(controller.signal)).rejects.toThrow('已取消登录')
  })

  test('服务器不支持浏览器登录（没有 OAuth 元数据）：说明找不到登录方式', async () => {
    const plain = createServer((_req, res) => res.writeHead(404).end())
    await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve))
    try {
      const auth = new McpOAuth(`http://127.0.0.1:${(plain.address() as AddressInfo).port}/mcp`, storage, { openBrowser: browser.open })
      await expect(auth.login()).rejects.toThrow('找不到这个服务器的登录方式')
    } finally {
      plain.close()
    }
  })

  test('同一个服务器写法不同（结尾斜杠、主机名大小写）是同一份登录', () => {
    expect(oauthKey('https://MCP.Vercel.com/')).toBe(oauthKey('https://mcp.vercel.com'))
    expect(oauthKey('https://mcp.vercel.com/a')).not.toBe(oauthKey('https://mcp.vercel.com/b'))
  })
})
