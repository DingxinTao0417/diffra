import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import type { PluginRef } from '../protocol.js'

// 插件里的 LSP 服务器（v2 · M4）：兼容 Claude Code 的写法，插件根目录的 .lsp.json（名字 → 配置），
// 加上 plugin.json 的 lspServers（文件路径、内联的名字 → 配置，或者这两种的数组），后写的同名覆盖前面的。
// 每个配置的字段是严格的：有不认识的字段这个服务器就不用（和 Claude Code 一样），原因列进插件的「不支持」
const serverSchema = z.strictObject({
  command: z.string().trim().min(1),
  extensionToLanguage: z
    .record(z.string().regex(/^\.[^\s/\\]+$/, '扩展名要以 . 开头'), z.string().min(1))
    .refine((map) => Object.keys(map).length > 0, '至少一个扩展名'),
  args: z.array(z.string()).optional(),
  // Claude Code 也接受 socket，但都按 stdio 跑
  transport: z.enum(['stdio', 'socket']).optional(),
  env: z.record(z.string(), z.string()).optional(),
  initializationOptions: z.unknown().optional(),
  settings: z.unknown().optional(),
  workspaceFolder: z.string().optional(),
  startupTimeout: z.number().int().positive().optional(),
  shutdownTimeout: z.number().int().positive().optional(),
  requestTimeout: z.number().int().positive().optional(),
  restartOnCrash: z.boolean().optional(),
  maxRestarts: z.number().int().min(0).optional(),
  diagnostics: z.boolean().optional(),
})

// 没写时的时限：启动（initialize 的回复）、请求、退出前等它自己收尾
const DEFAULT_STARTUP_TIMEOUT_MS = 20_000
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000
const DEFAULT_MAX_RESTARTS = 3

export interface LspServerSpec {
  // 插件名-服务器名，界面、日志和给模型的说明里用
  name: string
  plugin: string
  // 插件目录（${CLAUDE_PLUGIN_ROOT}）
  root: string
  // 下面几项里的 ${…} 到启动时才展开（${CLAUDE_PROJECT_DIR} 要看是哪个项目）
  command: string
  args: string[]
  env: Record<string, string>
  workspaceFolder: string | null
  // 扩展名（小写，带点）→ LSP 的语言 id
  extensions: Record<string, string>
  initializationOptions: unknown
  settings: unknown
  startupTimeoutMs: number
  requestTimeoutMs: number
  shutdownTimeoutMs: number
  restartOnCrash: boolean
  maxRestarts: number
  // 改完文件后要不要把诊断给模型
  diagnostics: boolean
}

export function lspServerName(plugin: string, server: string): string {
  return `${plugin}-${server}`.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 48)
}

// 插件里写的路径：./ 开头、在插件目录里
function pluginPath(root: string, path: string): string | null {
  if (!path.startsWith('./')) return null
  const full = resolve(root, path)
  const inside = relative(root, full)
  return inside === '' || inside.startsWith('..') || isAbsolute(inside) ? null : full
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

// .lsp.json 直接是「名字 → 配置」；也认外面包一层 { "lspServers": … }
const mapOf = (raw: unknown): Record<string, unknown> | null => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const inner = record.lspServers
  return typeof inner === 'object' && inner !== null && !Array.isArray(inner) && Object.keys(record).length === 1 ? (inner as Record<string, unknown>) : record
}

export interface PluginLspServers {
  servers: LspServerSpec[]
  // 用不了的：哪个服务器、为什么；放进插件的「不支持」
  problems: string[]
}

export async function readLspServers(plugin: { name: string; dir: string }, manifestEntry: unknown): Promise<PluginLspServers> {
  const problems: string[] = []
  const configs = new Map<string, unknown>()
  const addMap = (map: Record<string, unknown> | null, where: string) => {
    if (!map) {
      problems.push(`${where} 里的 LSP 服务器（格式不对）`)
      return
    }
    for (const [name, config] of Object.entries(map)) configs.set(name, config)
  }
  const fromFile = async (path: string, where: string) => {
    const raw = await readJson(path).catch(() => undefined)
    if (raw === undefined) problems.push(`${where}（不是 JSON）`)
    else if (raw !== null) addMap(mapOf(raw), where)
    else if (where !== '.lsp.json') problems.push(`${where}（文件不存在）`)
  }
  await fromFile(join(plugin.dir, '.lsp.json'), '.lsp.json')
  const entries = manifestEntry === undefined ? [] : Array.isArray(manifestEntry) ? manifestEntry : [manifestEntry]
  for (const entry of entries) {
    if (typeof entry === 'string') {
      const path = pluginPath(plugin.dir, entry)
      if (!path) problems.push(`plugin.json 的 lspServers 路径 ${entry}（要以 ./ 开头、在插件目录里）`)
      else await fromFile(path, entry)
    } else addMap(mapOf(entry), 'plugin.json 的 lspServers')
  }
  const servers: LspServerSpec[] = []
  for (const [server, config] of configs) {
    const parsed = serverSchema.safeParse(config)
    if (!parsed.success) {
      problems.push(`LSP 服务器 ${server}（${parsed.error.issues.map((issue) => [issue.path.join('.'), issue.message].filter(Boolean).join('：')).join('；')}）`)
      continue
    }
    const value = parsed.data
    servers.push({
      name: lspServerName(plugin.name, server),
      plugin: plugin.name,
      root: plugin.dir,
      command: value.command,
      args: value.args ?? [],
      env: value.env ?? {},
      workspaceFolder: value.workspaceFolder ?? null,
      extensions: Object.fromEntries(Object.entries(value.extensionToLanguage).map(([extension, language]) => [extension.toLowerCase(), language])),
      initializationOptions: value.initializationOptions ?? null,
      settings: value.settings ?? null,
      startupTimeoutMs: value.startupTimeout ?? DEFAULT_STARTUP_TIMEOUT_MS,
      requestTimeoutMs: value.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS,
      shutdownTimeoutMs: value.shutdownTimeout ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      restartOnCrash: value.restartOnCrash ?? true,
      maxRestarts: value.maxRestarts ?? DEFAULT_MAX_RESTARTS,
      diagnostics: value.diagnostics ?? true,
    })
  }
  return { servers, problems }
}

// 插件根目录 ${CLAUDE_PLUGIN_ROOT}（或 ${DIFFRA_PLUGIN_ROOT}），项目 ${CLAUDE_PROJECT_DIR}；其他 ${名字} 取环境变量，没有就是空
export function expandLsp(value: string, root: string, project: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) =>
    name === 'CLAUDE_PLUGIN_ROOT' || name === 'DIFFRA_PLUGIN_ROOT' ? root : name === 'CLAUDE_PROJECT_DIR' ? project : (process.env[name] ?? ''),
  )
}

// 开着的插件里的 LSP 服务器；读不了的插件跳过，不影响建任务
export async function pluginLspServers(plugins: PluginRef[], manifestEntry: (dir: string) => Promise<unknown>): Promise<LspServerSpec[]> {
  const servers: LspServerSpec[] = []
  for (const plugin of plugins) {
    try {
      const result = await readLspServers(plugin, await manifestEntry(plugin.dir))
      for (const problem of result.problems) console.warn(`[lsp] ${plugin.name}：${problem}`)
      servers.push(...result.servers)
    } catch (error) {
      console.error(`[lsp] 读取 ${plugin.name} 的 LSP 服务器失败`, error)
    }
  }
  return servers
}
