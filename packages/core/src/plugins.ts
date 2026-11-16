import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk'
import { z } from 'zod'
import { commandRoots, loadCommands } from './commands.js'
import { PLUGIN_HOOK_EVENTS, type PluginBlock, type PluginHookEvent, type PluginHookInfo, type PluginInfo, type PluginRef } from './protocol.js'
import { RICH_BLOCK_KINDS } from './rich/blocks.js'
import { type LspServerSpec, pluginLspServers as readPluginLspServers, readLspServers } from './lsp/config.js'
import { loadSkills } from './skills.js'
import { loadPluginAgentTypes } from './subagents.js'

// 插件是一个文件夹，兼容 Claude Code 插件的一部分：清单 .diffra-plugin/plugin.json 或 .claude-plugin/plugin.json，
// commands/ 里的命令、skills/ 里的 Skill、agents/ 里的子智能体、hooks/hooks.json 里的钩子、.mcp.json 里的 MCP 服务器、
// .lsp.json 和清单 lspServers 里的语言服务器（v2，见 lsp/config.ts）。
// output-styles、monitors 不支持，读到时列出来
const MANIFESTS = [join('.diffra-plugin', 'plugin.json'), join('.claude-plugin', 'plugin.json')]
const UNSUPPORTED = ['output-styles', 'monitors']
const HOOKS_FILE = join('hooks', 'hooks.json')
const BLOCKS_FILE = join('blocks', 'blocks.json')
const MAX_BLOCKS = 20
const MAX_TEMPLATE_BYTES = 200_000

// blocks/blocks.json（第 682 步）：{ "blocks": [{ "kind": "deploy-status", "title": "部署状态", "description": "…", "renders": "keyvalue" }] }，
// renders 也可以是 template，再给 "template": "templates/x.html"（插件里的相对路径）
const blockEntrySchema = z.object({
  kind: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/).max(40),
  title: z.string().trim().min(1).max(40),
  description: z.string().trim().max(300).default(''),
  renders: z.enum(['template', ...RICH_BLOCK_KINDS]),
  template: z.string().trim().min(1).max(200).optional(),
})

const manifestSchema = z.object({
  name: z.string().trim().min(1).optional(),
  version: z.string().optional(),
  description: z.string().optional(),
  // 清单里另写的钩子不读，只认 hooks/hooks.json
  hooks: z.unknown().optional(),
  // 语言服务器：文件路径、内联配置或数组，和 .lsp.json 合在一起读
  lspServers: z.unknown().optional(),
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

// 插件注册的富块；格式不对的条目跳过，写进 unsupported
async function readBlocks(dir: string, plugin: string): Promise<{ blocks: PluginBlock[]; unsupported: string[] }> {
  const raw = await readJson(join(dir, BLOCKS_FILE))
  if (raw === null) return { blocks: [], unsupported: [] }
  const entries = typeof raw === 'object' && raw !== null && 'blocks' in raw && Array.isArray(raw.blocks) ? (raw.blocks as unknown[]) : null
  if (!entries) return { blocks: [], unsupported: ['blocks/blocks.json 格式不对'] }
  const blocks: PluginBlock[] = []
  const unsupported: string[] = []
  for (const entry of entries.slice(0, MAX_BLOCKS)) {
    const parsed = blockEntrySchema.safeParse(entry)
    const label = typeof (entry as { kind?: unknown })?.kind === 'string' ? (entry as { kind: string }).kind : '一项'
    if (!parsed.success) {
      unsupported.push(`富块 ${label}（格式不对）`)
      continue
    }
    const { template, ...block } = parsed.data
    if (block.renders !== 'template') {
      blocks.push({ plugin, ...block })
      continue
    }
    const file = template ? join(dir, template) : null
    const inside = file !== null && !template!.split(/[\\/]/).includes('..')
    const info = inside ? await stat(file!).catch(() => null) : null
    if (!info?.isFile() || info.size > MAX_TEMPLATE_BYTES) {
      unsupported.push(`富块 ${label}（模板不在插件里、不存在或超过 200 KB）`)
      continue
    }
    blocks.push({ plugin, ...block, template: await readFile(file!, 'utf8') })
  }
  if (entries.length > MAX_BLOCKS) unsupported.push(`富块超过 ${MAX_BLOCKS} 个的部分`)
  return { blocks, unsupported }
}

// 开着的插件注册的富块，同名的只留先开的那个；读不了的插件跳过，不影响建任务
export async function pluginBlocks(plugins: PluginRef[]): Promise<PluginBlock[]> {
  const blocks: PluginBlock[] = []
  for (const plugin of plugins) {
    const loaded = await readBlocks(plugin.dir, plugin.name).catch((error: unknown) => {
      console.error(`[plugins] 读取 ${plugin.name} 的富块失败`, error)
      return { blocks: [] }
    })
    for (const block of loaded.blocks) if (!blocks.some((item) => item.kind === block.kind)) blocks.push(block)
  }
  return blocks
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
  const [commands, skills, mcpServers, agents, hooks, blocks, lsp] = await Promise.all([
    loadCommands(commandRoots(dir, [plugin]).filter((root) => root.source === 'plugin')),
    loadSkills([{ source: 'plugin', dir: join(dir, 'skills') }]),
    readMcpEntries(dir),
    loadPluginAgentTypes([plugin]),
    readHooks(dir),
    readBlocks(dir, name),
    readLspServers(plugin, manifest?.lspServers),
  ])
  const unsupported: string[] = []
  for (const item of UNSUPPORTED) if (await exists(join(dir, item))) unsupported.push(item)
  if (manifest?.hooks !== undefined) unsupported.push('plugin.json 里的 hooks')
  unsupported.push(...hooks.unsupported, ...blocks.unsupported, ...lsp.problems)
  if (
    !manifest &&
    commands.length === 0 &&
    skills.length === 0 &&
    mcpServers.length === 0 &&
    agents.length === 0 &&
    hooks.hooks.length === 0 &&
    blocks.blocks.length === 0 &&
    lsp.servers.length === 0
  ) {
    throw new Error('这个文件夹不是插件：没有 .claude-plugin/plugin.json，也没有 commands、skills、agents、hooks、blocks、.mcp.json 或 .lsp.json')
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
    blocks: blocks.blocks.map((block) => block.kind),
    lspServers: lsp.servers.map((server) => server.name),
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

// 开着的插件里的语言服务器；读不了的插件跳过
export function pluginLspServers(plugins: PluginRef[]): Promise<LspServerSpec[]> {
  return readPluginLspServers(plugins, async (dir) => (await readManifest(dir).catch(() => null))?.lspServers)
}

// 插件里的 Skill 目录，排在用户自己的后面、兼容目录的前面
export function pluginSkillRoots(plugins: PluginRef[]) {
  return plugins.map((plugin) => ({ source: 'plugin' as const, dir: join(plugin.dir, 'skills') }))
}
