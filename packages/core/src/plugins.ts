import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk'
import { z } from 'zod'
import { commandRoots, loadCommands } from './commands.js'
import { PLUGIN_HOOK_EVENTS, type PluginHookEvent, type PluginHookInfo, type PluginInfo, type PluginRef } from './protocol.js'
import { loadSkills } from './skills.js'
import { loadPluginAgentTypes } from './subagents.js'

// 插件是一个文件夹，兼容 Claude Code 插件的一部分：清单 .diffra-plugin/plugin.json 或 .claude-plugin/plugin.json，
// commands/ 里的命令、skills/ 里的 Skill、agents/ 里的子智能体、hooks/hooks.json 里的钩子、.mcp.json 里的 MCP 服务器。
// output-styles、monitors 不支持，读到时列出来
const MANIFESTS = [join('.diffra-plugin', 'plugin.json'), join('.claude-plugin', 'plugin.json')]
const UNSUPPORTED = ['output-styles', 'monitors']
const HOOKS_FILE = join('hooks', 'hooks.json')

const manifestSchema = z.object({
  name: z.string().trim().min(1).optional(),
  version: z.string().optional(),
  description: z.string().optional(),
  // 清单里另写的钩子不读，只认 hooks/hooks.json
  hooks: z.unknown().optional(),
})

const nameValues = z.record(z.string(), z.string()).optional()
const mcpEntrySchema = z.union([
  z.object({ type: z.enum(['http', 'streamable-http']), url: z.string(), headers: nameValues }),
  z.object({ type: z.literal('stdio').optional(), command: z.string(), args: z.array(z.string()).optional(), env: nameValues }),
])

const hooksFileSchema = z.object({
  hooks: z.record(
    z.string(),
    z.array(
      z.object({
        matcher: z.string().optional(),
        hooks: z.array(z.object({ type: z.string(), command: z.string().optional(), timeout: z.number().positive().optional() })),
      }),
    ),
  ),
})

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

const isHookEvent = (event: string): event is PluginHookEvent => (PLUGIN_HOOK_EVENTS as readonly string[]).includes(event)

// hooks/hooks.json 里 Diffra 支持的钩子，和读到了但不支持的时机、类型
async function readHooks(dir: string): Promise<{ hooks: PluginHookInfo[]; unsupported: string[] }> {
  const raw = await readJson(join(dir, HOOKS_FILE))
  if (raw === null) return { hooks: [], unsupported: [] }
  const parsed = hooksFileSchema.safeParse(raw)
  if (!parsed.success) throw new Error(`hooks/hooks.json 格式不对：${parsed.error.issues.map((issue) => issue.message).join('；')}`)
  const hooks: PluginHookInfo[] = []
  const unsupported = new Set<string>()
  for (const [event, groups] of Object.entries(parsed.data.hooks)) {
    if (!isHookEvent(event)) {
      unsupported.add(`钩子 ${event}`)
      continue
    }
    for (const group of groups) {
      for (const hook of group.hooks) {
        if (hook.type !== 'command' || !hook.command?.trim()) {
          unsupported.add(`钩子 ${event} 的 ${hook.type} 类型`)
          continue
        }
        hooks.push({ event, matcher: group.matcher ?? '', command: hook.command, timeout: hook.timeout ?? null })
      }
    }
  }
  return { hooks, unsupported: [...unsupported] }
}

// 用户允许钩子时记下它；之后插件里的钩子变了，指纹对不上就不跑
export function hooksFingerprint(hooks: PluginHookInfo[]): string | null {
  if (hooks.length === 0) return null
  return createHash('sha256').update(JSON.stringify(hooks)).digest('hex').slice(0, 16)
}

export async function inspectPlugin(dir: string): Promise<PluginInfo> {
  const manifest = await readManifest(dir)
  const name = manifest?.name ?? basename(dir)
  const plugin = { name, dir }
  const [commands, skills, mcpServers, agents, hooks] = await Promise.all([
    loadCommands(commandRoots(dir, [plugin]).filter((root) => root.source === 'plugin')),
    loadSkills([{ source: 'plugin', dir: join(dir, 'skills') }]),
    readMcpEntries(dir),
    loadPluginAgentTypes([plugin]),
    readHooks(dir),
  ])
  const unsupported: string[] = []
  for (const item of UNSUPPORTED) if (await exists(join(dir, item))) unsupported.push(item)
  if (manifest?.hooks !== undefined) unsupported.push('plugin.json 里的 hooks')
  unsupported.push(...hooks.unsupported)
  if (!manifest && commands.length === 0 && skills.length === 0 && mcpServers.length === 0 && agents.length === 0 && hooks.hooks.length === 0) {
    throw new Error('这个文件夹不是插件：没有 .claude-plugin/plugin.json，也没有 commands、skills、agents、hooks 或 .mcp.json')
  }
  return {
    name,
    version: manifest?.version ?? '',
    description: manifest?.description ?? '',
    commands: commands.map((command) => command.name),
    skills: skills.map((skill) => skill.name),
    mcpServers: mcpServers.map(([server]) => pluginServerName(name, server)),
    agents: agents.map((agent) => agent.name),
    hooks: hooks.hooks,
    hooksFingerprint: hooksFingerprint(hooks.hooks),
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

export interface LoadedPluginHook extends PluginHookInfo {
  plugin: string
  root: string
}

// 用户允许了、而且和允许时一样的钩子；读不了或变了的插件跳过，不影响建任务
export async function pluginHooks(plugins: PluginRef[]): Promise<LoadedPluginHook[]> {
  const loaded: LoadedPluginHook[] = []
  for (const plugin of plugins) {
    if (!plugin.hooks) continue
    try {
      const { hooks } = await readHooks(plugin.dir)
      if (hooksFingerprint(hooks) !== plugin.hooks) {
        console.warn(`[plugins] ${plugin.name} 的钩子和允许时不一样了，不运行`)
        continue
      }
      loaded.push(...hooks.map((hook) => ({ ...hook, plugin: plugin.name, root: plugin.dir })))
    } catch (error) {
      console.error(`[plugins] 读取 ${plugin.name} 的钩子失败`, error)
    }
  }
  return loaded
}

// 插件里的 Skill 目录，排在用户自己的后面、兼容目录的前面
export function pluginSkillRoots(plugins: PluginRef[]) {
  return plugins.map((plugin) => ({ source: 'plugin' as const, dir: join(plugin.dir, 'skills') }))
}
