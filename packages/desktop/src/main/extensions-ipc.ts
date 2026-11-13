import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { mcpStatus } from '@diffra/core'
import type { McpServer } from '@diffra/core/types'
import { app, ipcMain } from 'electron'
import { z } from 'zod'
import { catalogMcp, PREREQUISITES, type CatalogConnection, type Prerequisite, type PrerequisiteState } from '../shared/extensions'
import { IPC_CHANNELS } from '../shared/ipc'
import type { McpServerInput } from '../shared/settings'
import { coreConnection } from './core-process'
import { parse } from './ipc-input'
import type { SecretStore } from './secret-store'
import { saveMcpServer, settingsView } from './settings-ipc'
import type { SettingsStore } from './settings-store'
import { testOverridesAllowed } from './test-overrides'

// e2e 把目录里的服务和插件换成本机的假服务、本地 Git 仓库：DIFFRA_CATALOG_OVERRIDES 是一段 JSON
const overridesSchema = z.object({
  mcp: z.record(z.string(), z.object({ url: z.string() })).default({}),
  plugins: z.record(z.string(), z.object({ repo: z.string(), path: z.string().nullable() })).default({}),
})

export function catalogOverrides(): z.infer<typeof overridesSchema> {
  const raw = testOverridesAllowed() ? process.env.DIFFRA_CATALOG_OVERRIDES : undefined
  return overridesSchema.parse(raw ? JSON.parse(raw) : {})
}

// 只在 PATH 里找，不运行它；Windows 按 PATHEXT 找 npx.cmd 这类
function onPath(command: string): boolean {
  const pathKey = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
  const dirs = (process.env[pathKey] ?? '').split(delimiter).filter(Boolean)
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : ['']
  return dirs.some((dir) => extensions.some((extension) => existsSync(join(dir, `${command}${extension}`))))
}

export function prerequisiteState(): PrerequisiteState {
  return Object.fromEntries(Object.entries(PREREQUISITES).map(([key, item]) => [key, onPath(item.command)])) as PrerequisiteState
}

// 目录里的名字被自己手动加的服务器占了时，往后加数字
function freeName(base: string, taken: string[]): string {
  const used = new Set(taken.map((name) => name.toLowerCase()))
  for (let index = 1; ; index++) {
    const name = index === 1 ? base : `${base}-${index}`
    if (!used.has(name)) return name
  }
}

export function registerExtensionsIpc(settings: SettingsStore, secrets: SecretStore): void {
  ipcMain.handle(IPC_CHANNELS.extensionPrerequisites, () => prerequisiteState())

  // 一键装：只收目录 id 和用户填的 Key，地址、命令都按目录来。先连一次，连不上就不保存，把原因告诉用户
  ipcMain.handle(IPC_CHANNELS.extensionInstallMcp, async (_event, rawId: unknown, rawKey: unknown) => {
    const entry = catalogMcp(parse(z.string().min(1), rawId))
    const key = parse(z.string().trim().max(4000).nullable(), rawKey) || null
    if (!entry) throw new Error('目录里没有这个服务')
    const override = catalogOverrides().mcp[entry.id]
    const connection: CatalogConnection = override && entry.connection.transport === 'http' ? { transport: 'http', url: override.url } : entry.connection
    if (connection.transport === 'oauth') throw new Error(`${entry.name} 只支持浏览器登录，下一版支持`)
    if (connection.transport === 'stdio' && !prerequisiteState()[connection.requires as Prerequisite]) {
      throw new Error(`没检测到 ${PREREQUISITES[connection.requires].command} 命令，先装好 ${PREREQUISITES[connection.requires].label}`)
    }
    if (entry.key && !entry.key.optional && !key) throw new Error(`请填写 ${entry.key.label}`)
    const headers = entry.key && key ? [{ name: entry.key.header, value: entry.key.template.replace('{key}', key) }] : []
    const name = freeName(entry.id, settings.get().mcpServers.map((server) => server.name))
    const server: McpServer =
      connection.transport === 'http'
        ? { type: 'http', name, url: connection.url, headers }
        : { name, command: connection.command, args: connection.args, env: [] }
    const cwd = settings.get().lastProject ?? app.getPath('home')
    const [status] = await mcpStatus(await coreConnection(), { cwd, servers: [server] }, true)
    if (!status || status.state !== 'connected') {
      const detail = status?.error ?? '没有返回状态'
      const denied = /^HTTP (401|403)/.exec(detail)
      throw new Error(denied && entry.key ? `连不上 ${entry.name}：${entry.key.label} 不对，或者权限不够（HTTP ${denied[1]}）` : `连不上 ${entry.name}：${detail}`)
    }
    const input: McpServerInput =
      connection.transport === 'http'
        ? { name, enabled: true, transport: 'http', command: '', args: [], url: connection.url, env: [], headers }
        : { name, enabled: true, transport: 'stdio', command: connection.command, args: connection.args, url: '', env: [], headers: [] }
    await saveMcpServer(settings, secrets, input)
    return settingsView(settings, secrets)
  })
}
