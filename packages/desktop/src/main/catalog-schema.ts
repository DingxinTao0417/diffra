import { z } from 'zod'
import {
  CATALOG_MCP,
  CATALOG_PLUGINS,
  CATALOG_UPDATED_AT,
  type CatalogMcp,
  type CatalogPlugin,
  MCP_GROUP_LABELS,
  type McpGroup,
  PLUGIN_GROUP_LABELS,
  type PluginGroup,
  type Prerequisite,
  PREREQUISITES,
} from '../shared/extensions.ts'

// 联网目录的格式和逐项校验。不引 Electron：官网构建脚本生成 catalog.json 时用同一份校验，node --test 也直接测它（scripts/catalog.test.ts）
const https = z.url({ protocol: /^https$/ })
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
const text = (max: number) => z.string().min(1).max(max)
const prerequisites = Object.keys(PREREQUISITES) as [Prerequisite, ...Prerequisite[]]

const keySchema = z.object({
  label: text(60),
  header: z.string().regex(/^[A-Za-z0-9-]{1,60}$/),
  template: z.string().max(200).includes('{key}'),
  helpUrl: https,
  hint: z.string().max(300),
  optional: z.boolean(),
})

// 本地命令只能是目录认得的那几个前置命令（npx、uvx、docker、railway），参数不能带换行；联网的目录不能让人跑任意程序
const connectionSchema = z.discriminatedUnion('transport', [
  z.object({ transport: z.literal('http'), url: https }),
  z.object({ transport: z.literal('oauth'), url: https }),
  z
    .object({
      transport: z.literal('stdio'),
      command: z.string(),
      args: z.array(z.string().max(300).regex(/^[^\r\n]*$/)).max(30),
      requires: z.enum(prerequisites),
    })
    .refine((connection) => PREREQUISITES[connection.requires].command === connection.command, '本地命令和要先装的命令对不上'),
])

const mcpSchema = z.object({
  id,
  name: text(60),
  publisher: text(60),
  group: z.enum(Object.keys(MCP_GROUP_LABELS) as [McpGroup, ...McpGroup[]]),
  description: text(200),
  recommended: z.boolean(),
  connection: connectionSchema,
  key: keySchema.nullable(),
  note: z.string().max(400).nullable(),
}) satisfies z.ZodType<CatalogMcp>

// 仓库只能是 https 的 Git 地址；子目录是相对路径，不能往上跳
const pluginSchema = z.object({
  id,
  pluginName: z.string().regex(/^[A-Za-z0-9][\w.-]{0,63}$/),
  name: text(60),
  publisher: text(60),
  group: z.enum(Object.keys(PLUGIN_GROUP_LABELS) as [PluginGroup, ...PluginGroup[]]),
  description: text(200),
  contents: text(200),
  recommended: z.boolean(),
  repo: https,
  path: z
    .string()
    .regex(/^[\w.-]+(\/[\w.-]+)*$/)
    .refine((path) => !path.split('/').some((part) => part === '..' || part === '.'), '子目录不能有 . 或 ..')
    .nullable(),
  note: z.string().max(400).nullable(),
  unavailable: z.string().max(200).nullable(),
}) satisfies z.ZodType<CatalogPlugin>

const documentSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  mcp: z.array(z.unknown()).max(300),
  plugins: z.array(z.unknown()).max(300),
})

export interface CatalogDocument {
  version: 1
  updatedAt: string
  mcp: CatalogMcp[]
  plugins: CatalogPlugin[]
}

// 丢掉的项：哪一类、id、为什么
export interface DroppedEntry {
  kind: 'mcp' | 'plugin'
  id: string
  reason: string
}

// 逐项校验：一项不对只丢这一项（比如以后的版本加了这一版认不出的连接方式），id 重复的留第一个
function entries<T extends { id: string }>(raw: unknown[], schema: z.ZodType<T>, kind: DroppedEntry['kind'], dropped: DroppedEntry[]): T[] {
  const seen = new Set<string>()
  const result: T[] = []
  for (const item of raw) {
    const parsed = schema.safeParse(item)
    const label = typeof item === 'object' && item !== null && 'id' in item ? String(item.id) : '?'
    if (!parsed.success) {
      dropped.push({ kind, id: label, reason: z.prettifyError(parsed.error) })
      continue
    }
    if (seen.has(parsed.data.id)) {
      dropped.push({ kind, id: label, reason: 'id 重复' })
      continue
    }
    seen.add(parsed.data.id)
    result.push(parsed.data)
  }
  return result
}

// 整份格式不对（不是第 1 版、没有日期）时抛错；单项不对的放进 dropped
export function parseCatalog(raw: unknown): { document: CatalogDocument; dropped: DroppedEntry[] } {
  const parsed = documentSchema.parse(raw)
  const dropped: DroppedEntry[] = []
  const document: CatalogDocument = {
    version: 1,
    updatedAt: parsed.updatedAt,
    mcp: entries(parsed.mcp, mcpSchema, 'mcp', dropped),
    plugins: entries(parsed.plugins, pluginSchema, 'plugin', dropped),
  }
  return { document, dropped }
}

export function builtinCatalog(): CatalogDocument {
  return { version: 1, updatedAt: CATALOG_UPDATED_AT, mcp: CATALOG_MCP, plugins: CATALOG_PLUGINS }
}
