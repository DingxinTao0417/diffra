import type { McpServer } from '@diffra/core/types'
import type { McpServerConfig } from '../shared/settings'
import type { SecretStore } from './secret-store'
import type { SettingsStore } from './settings-store'

// 环境变量和请求头的值存在密钥库里，按服务器 id 和名字分开
export function mcpSecretKey(serverId: string, kind: 'env' | 'header', name: string): string {
  return `mcp:${serverId}:${kind}:${name}`
}

export function mcpSecretKeys(server: McpServerConfig): string[] {
  return [
    ...server.envNames.map((name) => mcpSecretKey(server.id, 'env', name)),
    ...server.headerNames.map((name) => mcpSecretKey(server.id, 'header', name)),
  ]
}

// 开着的 MCP 服务器，带上密钥库里的值，交给 core；值读不出来时传空，由服务器自己报错，不挡住建任务
export async function mcpServersFor(settings: SettingsStore, secrets: SecretStore): Promise<McpServer[]> {
  const values = (server: McpServerConfig, kind: 'env' | 'header', names: string[]) =>
    Promise.all(
      names.map(async (name) => {
        const value = await secrets.get(mcpSecretKey(server.id, kind, name)).catch((error: unknown) => {
          console.error(`[mcp] 读取 ${server.name} 的 ${name} 失败`, error)
          return null
        })
        return { name, value: value ?? '' }
      }),
    )
  return Promise.all(
    settings
      .get()
      .mcpServers.filter((server) => server.enabled)
      .map(
        async (server): Promise<McpServer> =>
          server.transport === 'http'
            ? { type: 'http', name: server.name, url: server.url, headers: await values(server, 'header', server.headerNames) }
            : { name: server.name, command: server.command, args: server.args, env: await values(server, 'env', server.envNames) },
      ),
  )
}
