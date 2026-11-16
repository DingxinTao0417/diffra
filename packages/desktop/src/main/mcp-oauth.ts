import { McpOAuth, type McpOAuthState, type OAuthStorage } from '@diffra/core'
import { ipcMain, shell } from 'electron'
import { z } from 'zod'
import { IPC_CHANNELS } from '../shared/ipc'
import type { McpServerConfig } from '../shared/settings'
import { parse } from './ipc-input'
import type { SecretStore } from './secret-store'
import { settingsView } from './settings-ipc'
import type { SettingsStore } from './settings-store'

// MCP 的浏览器登录（v2 · M4）：令牌和注册信息加密存在密钥库里（键按服务器地址算，见 core 的 oauthKey），不进设置文件
export function oauthStorage(secrets: SecretStore): OAuthStorage {
  return { get: (key) => secrets.get(key), set: (key, value) => secrets.set(key, value), delete: (key) => secrets.delete(key) }
}

// 授权页用系统浏览器打开；只开 http(s)
export function oauthFor(secrets: SecretStore, url: string): McpOAuth {
  return new McpOAuth(url, oauthStorage(secrets), {
    openBrowser: async (target) => {
      const parsed = new URL(target)
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('授权页不是 http(s) 地址')
      await shell.openExternal(parsed.toString())
    },
  })
}

export async function oauthStates(settings: SettingsStore, secrets: SecretStore): Promise<Record<string, McpOAuthState>> {
  const entries = await Promise.all(
    settings
      .get()
      .mcpServers.filter((server) => server.auth === 'oauth')
      .map(async (server) => [server.id, await oauthFor(secrets, server.url).state().catch((): McpOAuthState => ({ status: 'signed-out', expiresAt: null, scope: null }))] as const),
  )
  return Object.fromEntries(entries)
}

// 建会话、查状态时的请求头：浏览器登录的服务器带上访问令牌（快过期先刷新）；没登录、刷新不了时是 null，这个服务器不带进任务
export async function oauthHeader(secrets: SecretStore, server: McpServerConfig): Promise<{ name: string; value: string } | null> {
  const token = await oauthFor(secrets, server.url)
    .accessToken()
    .catch((error: unknown) => {
      console.error(`[mcp] 读取 ${server.name} 的登录令牌失败`, error)
      return null
    })
  return token ? { name: 'Authorization', value: `Bearer ${token}` } : null
}

// 正在等浏览器里登录的：按服务器 id（目录一键装时是 catalog:<目录 id>），用户点取消时中断
const pending = new Map<string, AbortController>()

export async function loginWithCancel(key: string, auth: McpOAuth): Promise<void> {
  pending.get(key)?.abort()
  const controller = new AbortController()
  pending.set(key, controller)
  try {
    await auth.login(controller.signal)
  } finally {
    if (pending.get(key) === controller) pending.delete(key)
  }
}

export function registerMcpOAuthIpc(settings: SettingsStore, secrets: SecretStore): void {
  const serverOf = (raw: unknown) => {
    const id = parse(z.string().min(1), raw)
    const server = settings.get().mcpServers.find((item) => item.id === id)
    if (!server || server.auth !== 'oauth') throw new Error('这个 MCP 服务器不用浏览器登录')
    return server
  }

  ipcMain.handle(IPC_CHANNELS.mcpOAuthLogin, async (_event, raw: unknown) => {
    const server = serverOf(raw)
    await loginWithCancel(server.id, oauthFor(secrets, server.url))
    return settingsView(settings, secrets)
  })

  ipcMain.handle(IPC_CHANNELS.mcpOAuthCancel, (_event, raw: unknown) => {
    pending.get(parse(z.string().min(1), raw))?.abort()
  })

  ipcMain.handle(IPC_CHANNELS.mcpOAuthLogout, async (_event, raw: unknown) => {
    const server = serverOf(raw)
    await oauthFor(secrets, server.url).logout()
    return settingsView(settings, secrets)
  })
}
