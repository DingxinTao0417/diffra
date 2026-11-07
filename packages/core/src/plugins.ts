import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk'
import { z } from 'zod'
import { commandRoots, loadCommands } from './commands.js'
import type { PluginInfo, PluginRef } from './protocol.js'
import { loadSkills } from './skills.js'

// 插件是一个文件夹，兼容 Claude Code 插件的一部分：清单 .diffra-plugin/plugin.json 或 .claude-plugin/plugin.json，
// commands/ 里的命令、skills/ 里的 Skill、.mcp.json 里的 MCP 服务器。agents、hooks 等不支持，读到时列出来
const MANIFESTS = [join('.diffra-plugin', 'plugin.json'), join('.claude-plugin', 'plugin.json')]
const UNSUPPORTED = ['agents', 'hooks', 'output-styles', 'monitors']

const manifestSchema = z.object({
  name: z.string().trim().min(1).optional(),
  version: z.string().optional(),
  description: z.string().optional(),
})

const nameValues = z.record(z.string(), z.string()).optional()
const mcpEntrySchema = z.union([
  z.object({ type: z.enum(['http', 'streamable-http']), url: z.string(), headers: nameValues }),
  z.object({ type: z.literal('stdio').optional(), command: z.string(), args: z.array(z.string()).optional(), env: nameValues }),
])

const exists = (path: string) => stat(path).then(() => true, () => false)

async function readJson(path: string): Promise<unknown> {
  const text = await readFile(path, 'utf8').catch(() => null)
  if (text === null) return null
  try {
    return JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    throw new Error(`${path} 不是合法的 JSON`)
  }
}

async function readManifest(dir: string): Promise<z.infer<typeof manifestSchema> | null> {
  for (const file of MANIFESTS) {
    const raw = await readJson(join(dir, file))
    if (raw === null) continue
    const parsed = manifestSchema.safeParse(raw)
    if (!parsed.success) throw new Error(`${file} 格式不对：${parsed.error.issues.map((issue) => issue.message).join('；')}`)
    return parsed.data
  }
  return null
}

// .mcp.json 有两种写法：{ "mcpServers": { 名字: 配置 } }，或者直接 { 名字: 配置 }
async function readMcpEntries(dir: string): Promise<Array<[string, z.infer<typeof mcpEntrySchema>]>> {
  const raw = await readJson(join(dir, '.mcp.json'))
  if (raw === null || typeof raw !== 'object') return []
  const servers = 'mcpServers' in raw && typeof raw.mcpServers === 'object' && raw.mcpServers !== null ? raw.mcpServers : raw
  return Object.entries(servers).flatMap(([name, value]) => {
    const parsed = mcpEntrySchema.safeParse(value)
    if (!parsed.success) console.error(`[plugins] ${dir} 的 .mcp.json 里 ${name} 格式不对`, parsed.error)
    return parsed.success ? [[name, parsed.data] as [string, z.infer<typeof mcpEntrySchema>]] : []
  })
}

export async function inspectPlugin(dir: string): Promise<PluginInfo> {
  const manifest = await readManifest(dir)
  const name = manifest?.name ?? basename(dir)
  const plugin = { name, dir }
  const [commands, skills, mcpServers] = await Promise.all([
    loadCommands(commandRoots(dir, [plugin]).filter((root) => root.source === 'plugin')),
    loadSkills([{ source: 'plugin', dir: join(dir, 'skills') }]),
    readMcpEntries(dir),
  ])
  const unsupported: string[] = []
  for (const item of UNSUPPORTED) if (await exists(join(dir, item))) unsupported.push(item)
  if (!manifest && commands.length === 0 && skills.length === 0 && mcpServers.length === 0) {
    throw new Error('这个文件夹不是插件：没有 .claude-plugin/plugin.json，也没有 commands、skills 或 .mcp.json')
  }
  return {
    name,
    version: manifest?.version ?? '',
    description: manifest?.description ?? '',
    commands: commands.map((command) => command.name),
    skills: skills.map((skill) => skill.name),
    mcpServers: mcpServers.map(([server]) => pluginServerName(name, server)),
    unsupported,
  }
}

// 插件的 MCP 服务器名前面加插件名，免得和用户自己配的重名；只留工具名里允许的字符
export function pluginServerName(plugin: string, server: string): string {
  return `${plugin}-${server}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 48)
}

// 插件根目录用 ${CLAUDE_PLUGIN_ROOT} 或 ${DIFFRA_PLUGIN_ROOT}；其他 ${名字} 取环境变量，没有就是空
function expand(value: string, root: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) =>
    name === 'CLAUDE_PLUGIN_ROOT' || name === 'DIFFRA_PLUGIN_ROOT' ? root : (process.env[name] ?? ''),
  )
}

const pairs = (record: Record<string, string> | undefined, root: string) =>
  Object.entries(record ?? {}).map(([name, value]) => ({ name, value: expand(value, root) }))

// 开着的插件里的 MCP 服务器；读不了的插件跳过，不影响建任务
export async function pluginMcpServers(plugins: PluginRef[]): Promise<McpServer[]> {
  const servers: McpServer[] = []
  for (const plugin of plugins) {
    const entries = await readMcpEntries(plugin.dir).catch((error: unknown) => {
      console.error(`[plugins] 读取 ${plugin.name} 的 .mcp.json 失败`, error)
      return []
    })
    for (const [name, entry] of entries) {
      const serverName = pluginServerName(plugin.name, name)
      servers.push(
        'url' in entry
          ? { type: 'http', name: serverName, url: expand(entry.url, plugin.dir), headers: pairs(entry.headers, plugin.dir) }
          : {
              name: serverName,
              command: expand(entry.command, plugin.dir),
              args: (entry.args ?? []).map((arg) => expand(arg, plugin.dir)),
              env: pairs(entry.env, plugin.dir),
            },
      )
    }
  }
  return servers
}

// 插件里的 Skill 目录，排在用户自己的后面、兼容目录的前面
export function pluginSkillRoots(plugins: PluginRef[]) {
  return plugins.map((plugin) => ({ source: 'plugin' as const, dir: join(plugin.dir, 'skills') }))
}
