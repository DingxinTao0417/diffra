import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  auth,
  discoverAuthorizationServerMetadata,
  discoverOAuthServerInfo,
  type OAuthClientProvider,
  refreshAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'

// 远程 MCP 服务器的浏览器登录（v2 · M4）：OAuth 2.1 + PKCE，按 MCP 的授权规范（RFC 9728 找授权服务器、RFC 8414 读它的元数据、
// RFC 7591 动态注册客户端），回调走本机回环地址（RFC 8252）。令牌和注册信息经 OAuthStorage 存（桌面端是 SecretStore，加密），
// 不进设置文件、日志和会话记录。一个服务器地址一份登录，用户自己配的和插件带的同一个地址共用

export interface OAuthStorage {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

export type McpOAuthStatus = 'signed-out' | 'signed-in' | 'expired'

export interface McpOAuthState {
  status: McpOAuthStatus
  // 令牌什么时候过期（ISO）；服务器没说时为 null
  expiresAt: string | null
  scope: string | null
}

export class McpOAuthError extends Error {}

// 存下来的令牌：SDK 给的加上拿到的时刻，算过期用；授权服务器地址，刷新时不用再找一遍
interface StoredTokens {
  tokens: OAuthTokens
  savedAt: number
  authorizationServer: string | null
}

const LOGIN_TIMEOUT_MS = 5 * 60_000
const REQUEST_TIMEOUT_MS = 15_000
// 离过期还有这么久就先刷新，免得建会话时拿到马上过期的令牌
const REFRESH_EARLY_MS = 60_000

// 服务器地址规范化后取哈希当键：同一个服务器写法不同（结尾斜杠、大小写主机名）也是一份登录
export function oauthKey(serverUrl: string): string {
  const url = new URL(serverUrl)
  const normalized = `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}${url.search}`
  return `mcp-oauth:${createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`
}

// 带超时的 fetch：授权服务器卡住时不一直等
const timedFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) })

export interface McpOAuthOptions {
  // 用系统浏览器打开授权页
  openBrowser(url: string): Promise<void>
  // 只给测试缩短
  loginTimeoutMs?: number
}

export class McpOAuth {
  private readonly key: string

  constructor(
    readonly serverUrl: string,
    private readonly storage: OAuthStorage,
    private readonly options: McpOAuthOptions,
  ) {
    this.key = oauthKey(serverUrl)
  }

  private async load(): Promise<StoredTokens | null> {
    const raw = await this.storage.get(`${this.key}:tokens`)
    if (!raw) return null
    try {
      return JSON.parse(raw) as StoredTokens
    } catch {
      return null
    }
  }

  private async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const raw = await this.storage.get(`${this.key}:client`)
    return raw ? (JSON.parse(raw) as OAuthClientInformationMixed) : undefined
  }

  private expiresAt(stored: StoredTokens): number | null {
    return typeof stored.tokens.expires_in === 'number' ? stored.savedAt + stored.tokens.expires_in * 1000 : null
  }

  async state(): Promise<McpOAuthState> {
    const stored = await this.load()
    if (!stored) return { status: 'signed-out', expiresAt: null, scope: null }
    const expiresAt = this.expiresAt(stored)
    const expired = expiresAt !== null && expiresAt <= Date.now() && !stored.tokens.refresh_token
    return { status: expired ? 'expired' : 'signed-in', expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(), scope: stored.tokens.scope ?? null }
  }

  // 浏览器登录：起一个只收这一次回调的本机端口，重新注册客户端（回调地址的端口每次不同），打开授权页，等用户在浏览器里同意。
  // signal 是用户点了取消
  async login(signal?: AbortSignal): Promise<McpOAuthState> {
    const callback = await startCallbackServer()
    try {
      const state = randomBytes(16).toString('hex')
      let verifier = ''
      await this.storage.delete(`${this.key}:client`)
      await this.storage.delete(`${this.key}:tokens`)
      let authorizationServer: string | null = null
      const provider: OAuthClientProvider = {
        redirectUrl: callback.url,
        clientMetadata: {
          client_name: 'Diffra',
          redirect_uris: [callback.url],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        } satisfies OAuthClientMetadata,
        state: () => state,
        clientInformation: () => this.clientInformation(),
        saveClientInformation: (info) => this.storage.set(`${this.key}:client`, JSON.stringify(info)),
        tokens: async () => (await this.load())?.tokens,
        saveTokens: (tokens) => this.storage.set(`${this.key}:tokens`, JSON.stringify({ tokens, savedAt: Date.now(), authorizationServer } satisfies StoredTokens)),
        redirectToAuthorization: (url) => this.options.openBrowser(url.toString()),
        saveCodeVerifier: (value) => {
          verifier = value
        },
        codeVerifier: () => verifier,
      }
      // 找不到授权服务器的元数据（RFC 8414）就是不支持浏览器登录；SDK 这时会退回把服务器自己当授权服务器，注册时才报 404，说不清楚
      const info = await discoverOAuthServerInfo(this.serverUrl, { fetchFn: timedFetch }).catch((error: unknown) => {
        throw new McpOAuthError(`找不到这个服务器的登录方式（OAuth 元数据）：${errorText(error)}`)
      })
      if (!info.authorizationServerMetadata) throw new McpOAuthError('找不到这个服务器的登录方式：它没有提供 OAuth 授权服务器的元数据，可能不支持浏览器登录，改用 Key 或请求头')
      authorizationServer = info.authorizationServerUrl
      const first = await auth(provider, { serverUrl: this.serverUrl, fetchFn: timedFetch }).catch((error: unknown) => {
        throw new McpOAuthError(`开始登录失败：${errorText(error)}`)
      })
      if (first !== 'REDIRECT') return this.state()
      const result = await callback.waitForCode(state, this.options.loginTimeoutMs ?? LOGIN_TIMEOUT_MS, signal)
      await auth(provider, { serverUrl: this.serverUrl, authorizationCode: result, fetchFn: timedFetch }).catch((error: unknown) => {
        throw new McpOAuthError(`换取令牌失败：${errorText(error)}`)
      })
      return this.state()
    } finally {
      callback.close()
    }
  }

  // 建会话时用：没登录是 null；快过期就先用刷新令牌换新的，换不了（被撤销、过期太久）也是 null，状态变成过期。
  // 不会弹浏览器：后台不能替用户登录
  async accessToken(): Promise<string | null> {
    const stored = await this.load()
    if (!stored) return null
    const expiresAt = this.expiresAt(stored)
    if (expiresAt === null || expiresAt - Date.now() > REFRESH_EARLY_MS) return stored.tokens.access_token
    if (!stored.tokens.refresh_token) return null
    const client = await this.clientInformation()
    if (!client) return null
    try {
      const info = await discoverOAuthServerInfo(this.serverUrl, { fetchFn: timedFetch })
      const metadata = info.authorizationServerMetadata ?? (await discoverAuthorizationServerMetadata(info.authorizationServerUrl, { fetchFn: timedFetch }))
      const tokens = await refreshAuthorization(info.authorizationServerUrl, {
        metadata,
        clientInformation: client,
        refreshToken: stored.tokens.refresh_token,
        ...(info.resourceMetadata?.resource ? { resource: info.resourceMetadata.resource } : {}),
        fetchFn: timedFetch,
      })
      // 有的服务器刷新时不再给新的刷新令牌，沿用原来的
      const next: StoredTokens = { tokens: { ...tokens, refresh_token: tokens.refresh_token ?? stored.tokens.refresh_token }, savedAt: Date.now(), authorizationServer: info.authorizationServerUrl }
      await this.storage.set(`${this.key}:tokens`, JSON.stringify(next))
      return next.tokens.access_token
    } catch (error) {
      console.error(`[mcp-oauth] 刷新 ${new URL(this.serverUrl).host} 的令牌失败`, errorText(error))
      // 刷新令牌也用不了了：留着记录，状态显示过期，等用户重新登录
      await this.storage.set(`${this.key}:tokens`, JSON.stringify({ ...stored, tokens: { ...stored.tokens, refresh_token: undefined, expires_in: 0 }, savedAt: 0 } satisfies StoredTokens))
      return null
    }
  }

  // 退出登录：授权服务器支持撤销（RFC 7009）就先撤销令牌（尽力而为，失败不挡着），再删掉本机存的
  async logout(): Promise<{ revoked: boolean }> {
    const stored = await this.load()
    const client = await this.clientInformation()
    let revoked = false
    if (stored && client) {
      try {
        const info = await discoverOAuthServerInfo(this.serverUrl, { fetchFn: timedFetch })
        const endpoint = (info.authorizationServerMetadata as { revocation_endpoint?: string } | undefined)?.revocation_endpoint
        if (endpoint) {
          for (const [token, hint] of [
            [stored.tokens.refresh_token, 'refresh_token'],
            [stored.tokens.access_token, 'access_token'],
          ] as const) {
            if (!token) continue
            const response = await timedFetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ token, token_type_hint: hint, client_id: client.client_id }),
            })
            revoked = revoked || response.ok
          }
        }
      } catch (error) {
        console.error(`[mcp-oauth] 撤销 ${new URL(this.serverUrl).host} 的令牌失败`, errorText(error))
      }
    }
    await this.storage.delete(`${this.key}:tokens`)
    await this.storage.delete(`${this.key}:client`)
    return { revoked }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// 只收一次回调的本机端口：127.0.0.1 上随机端口，路径 /callback，state 对不上的不收
async function startCallbackServer(): Promise<{ url: string; waitForCode(state: string, timeoutMs: number, signal?: AbortSignal): Promise<string>; close(): void }> {
  // 浏览器可能在打开授权页的调用还没返回时就跳回来了：先收着，等开始等的时候再取
  type Result = { code?: string; error?: string; state?: string }
  const received: Result[] = []
  let settle: ((result: Result) => void) | null = null
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback') {
      res.writeHead(404).end()
      return
    }
    const error = url.searchParams.get('error')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(
      `<!doctype html><meta charset="utf-8"><title>Diffra</title><body style="font-family:system-ui;padding:3rem;text-align:center">${error ? '登录没有完成，可以关掉这个页面回到 Diffra 再试一次。' : '登录完成，可以关掉这个页面回到 Diffra 了。'}</body>`,
    )
    const result = { code: url.searchParams.get('code') ?? undefined, error: error ?? undefined, state: url.searchParams.get('state') ?? undefined }
    if (settle) settle(result)
    else received.push(result)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/callback`,
    waitForCode: (state, timeoutMs, signal) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new McpOAuthError(`等了 ${Math.round(timeoutMs / 60_000)} 分钟还没在浏览器里完成登录，已取消`)), timeoutMs)
        const onAbort = () => reject(new McpOAuthError('已取消登录'))
        signal?.addEventListener('abort', onAbort, { once: true })
        settle = (result) => {
          if (result.state !== state) return
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          if (result.code) resolve(result.code)
          else reject(new McpOAuthError(`授权服务器拒绝了登录：${result.error ?? '没有给授权码'}`))
        }
        for (const result of received.splice(0)) settle(result)
      }),
    close: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}
