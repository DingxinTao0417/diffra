import { join } from 'node:path'
import { PROTOCOLS, REASONING_EFFORTS } from '@diffra/core/types'
import { z } from 'zod'
import {
  COMPACT_AT_PERCENTS,
  CONTENT_WIDTHS,
  AGENT_BROWSERS,
  DEFAULT_APPEARANCE,
  DEFAULT_BROWSER,
  DEFAULT_EXECUTION,
  DEFAULT_LAYOUT,
  DEFAULT_SECURITY,
  FONT_SIZES,
  FONT_STYLES,
  GOAL_ROUND_OPTIONS,
  MAX_BROWSER_SITES,
  MAX_STEP_OPTIONS,
  MAX_MODEL_ID_LENGTH,
  MAX_MODEL_DISPLAY_NAME_LENGTH,
  MAX_MODEL_CONTEXT_WINDOWS,
  MCP_TRANSPORTS,
  PALETTES,
  type Settings,
  THEME_MODES,
} from '../shared/settings'
import { readJsonFile, WriteQueue, writeJsonFileAtomic } from './json-file'

export const modelRefSchema = z.object({ providerId: z.string().min(1), modelId: z.string().min(1), reasoningEffort: z.enum(REASONING_EFFORTS).optional() })

export const providerFieldsSchema = z.object({
  presetId: z.string().nullable(),
  // 第 131 步加的，旧设置文件里没有
  icon: z.string().max(100).nullable().default(null),
  name: z.string().trim().min(1, '名称不能为空'),
  protocol: z.enum(PROTOCOLS),
  baseUrl: z.url({ protocol: /^https?$/, error: '地址必须是 http(s) 开头的完整 URL' }),
  models: z
    .array(
      z.object({
        id: z.string().trim().min(1, '模型 ID 不能为空').max(MAX_MODEL_ID_LENGTH),
        displayName: z.string().trim().max(MAX_MODEL_DISPLAY_NAME_LENGTH).optional(),
        enabled: z.boolean().optional(),
        contextWindows: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).max(MAX_MODEL_CONTEXT_WINDOWS).optional(),
        contextWindow: z.number().int().positive().nullable(),
        // 图片输入那一步加的，旧设置文件里没有
        images: z.boolean().default(false),
        reasoningEfforts: z.array(z.enum(REASONING_EFFORTS)).max(REASONING_EFFORTS.length).optional(),
      }),
    )
    .refine((models) => new Set(models.map((model) => model.id)).size === models.length, '模型 ID 重复'),
})

const checkCommandSchema = z.string().trim().min(1).nullable()

export const sessionChecksSchema = z.object({ afterEdit: checkCommandSchema, beforeFinish: checkCommandSchema })

// 只接受项目内的相对路径；统一成 / 分隔、去掉 ./ 和首尾斜杠
export const readOnlyPathSchema = z
  .string()
  .trim()
  .transform((path) => path.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+|\/+$/g, ''))
  .refine(
    (path) => path !== '' && !/^[a-zA-Z]:/.test(path) && !path.split('/').includes('..'),
    '禁写目录要填相对项目根目录的路径，不能是绝对路径，也不能包含 ..',
  )

export const projectSettingsSchema = z.object({
  checks: sessionChecksSchema,
  readOnlyPaths: z.array(readOnlyPathSchema).default([]),
  // 以前按项目存的规范设置（rules）不再使用，读的时候丢掉，下次保存就没了
})

export const appearanceSchema = z.object({
  fontStyle: z.enum(FONT_STYLES).optional(),
  theme: z.enum(THEME_MODES),
  palette: z.enum(PALETTES),
  fontSize: z.enum(FONT_SIZES),
  contentWidth: z.enum(CONTENT_WIDTHS),
})

const layoutSizeSchema = z.number().int().min(0).max(10_000).nullable().default(null)

export const layoutSchema = z.object({
  sidebarWidth: layoutSizeSchema,
  widePanelWidth: layoutSizeSchema,
  monitorWidth: layoutSizeSchema,
  designChatWidth: layoutSizeSchema,
  terminalHeight: layoutSizeSchema,
})

// 主机名：小写，去掉协议、路径和端口，写成 example.com
const siteSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((value) => value.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^\*\./, ''))
  .pipe(z.string().regex(/^[a-z0-9.-]+$/, '网站要写主机名，比如 example.com').min(1).max(253))

export const browserSettingsSchema = z.object({
  agent: z.enum(AGENT_BROWSERS),
  allowSites: z.array(siteSchema).max(MAX_BROWSER_SITES),
  blockSites: z.array(siteSchema).max(MAX_BROWSER_SITES),
})

export const permissionModeSchema = z.enum(['ask', 'auto', 'full'])

export const securitySchema = z.object({ staticCheck: z.boolean(), lightScan: z.boolean(), deepScan: z.boolean() })

// goalMaxRounds 是第 17 步加的，旧设置文件里没有
export const executionSchema = z.object({
  compactAtPercent: z.literal(COMPACT_AT_PERCENTS),
  maxSteps: z.literal(MAX_STEP_OPTIONS).nullable(),
  goalMaxRounds: z.literal(GOAL_ROUND_OPTIONS).default(DEFAULT_EXECUTION.goalMaxRounds),
})

export const MCP_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

export const mcpServerConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().regex(MCP_NAME_PATTERN),
  enabled: z.boolean(),
  transport: z.enum(MCP_TRANSPORTS),
  command: z.string(),
  args: z.array(z.string()),
  envNames: z.array(z.string().min(1)),
  url: z.string(),
  headerNames: z.array(z.string().min(1)),
})

// projects 和 lastProject 是第 4 步加的，带默认值，第 3 步写下的设置文件照样能读
const settingsSchema = z.object({
  version: z.literal(1),
  providers: z.array(providerFieldsSchema.extend({ id: z.string().min(1) })),
  roles: z.object({
    coder: modelRefSchema.nullable(),
    planner: modelRefSchema.nullable(),
    reviewer: modelRefSchema.nullable(),
    fallback: modelRefSchema.nullable(),
  }),
  projects: z.record(z.string(), projectSettingsSchema).default({}),
  lastProject: z.string().nullable().default(null),
  // 第 11 步加的
  appearance: appearanceSchema.default(() => ({ ...DEFAULT_APPEARANCE })),
  // 第 263 步加的
  layout: layoutSchema.default(() => ({ ...DEFAULT_LAYOUT })),
  // 第 273 步加的
  browser: browserSettingsSchema.default(() => ({ ...DEFAULT_BROWSER })),
  defaultPermissionMode: permissionModeSchema.default('ask'),
  // 第 14 步加的
  security: securitySchema.default(() => ({ ...DEFAULT_SECURITY })),
  // 第 7 步加的
  execution: executionSchema.default(() => ({ ...DEFAULT_EXECUTION })),
  // 第 18 步加的
  mcpServers: z.array(mcpServerConfigSchema).default([]),
  // 第 19 步加的
  plugins: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        dir: z.string().min(1),
        source: z.enum(['folder', 'git']),
        url: z.string().nullable(),
        enabled: z.boolean(),
      }),
    )
    .default([]),
  // 第 119 步加的
  defaultWorkspace: z.string().nullable().default(null),
})

const EMPTY_SETTINGS: Settings = {
  version: 1,
  providers: [],
  roles: { coder: null, planner: null, reviewer: null, fallback: null },
  projects: {},
  lastProject: null,
  appearance: DEFAULT_APPEARANCE,
  layout: DEFAULT_LAYOUT,
  browser: DEFAULT_BROWSER,
  defaultPermissionMode: 'ask',
  security: DEFAULT_SECURITY,
  execution: DEFAULT_EXECUTION,
  mcpServers: [],
  plugins: [],
  defaultWorkspace: null,
}

export class SettingsStore {
  private current: Settings = EMPTY_SETTINGS
  private readonly queue = new WriteQueue()
  loadError: string | null = null

  private constructor(private readonly file: string) {}

  static async open(userDataDir: string): Promise<SettingsStore> {
    const store = new SettingsStore(join(userDataDir, 'settings.json'))
    const content = await readJsonFile(store.file, settingsSchema)
    if (content.state === 'loaded') store.current = content.value
    if (content.state === 'invalid') {
      console.error('[settings] 设置文件解析失败', content.error)
      store.loadError = `设置文件无法解析，为避免覆盖已暂停保存：${store.file}`
    }
    return store
  }

  get(): Settings {
    return this.current
  }

  update(change: (current: Settings) => Settings): Promise<Settings> {
    return this.queue.run(async () => {
      if (this.loadError) throw new Error(this.loadError)
      const next = settingsSchema.parse(change(structuredClone(this.current)))
      await writeJsonFileAtomic(this.file, next)
      this.current = next
      return next
    })
  }
}
