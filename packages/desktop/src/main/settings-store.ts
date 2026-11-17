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

// 测试里的脚本模型按固定步数回复；e2e 启动时把下一句建议默认关掉，专门的用例再显式打开
const defaultSuggestions = () => ({ nextPrompt: process.env.DIFFRA_SUGGESTIONS_OFF !== '1' })

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
        maxOutputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
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

const hookCommandSchema = z.string().trim().max(1000).nullable().default(null).transform((value) => value || null)

export const projectSettingsSchema = z.object({
  checks: sessionChecksSchema,
  readOnlyPaths: z.array(readOnlyPathSchema).default([]),
  // 第 445 步加的：用户在这个项目里选过「始终允许同类命令」的命令键（如 pnpm test、git commit），旧设置没有
  allowedCommands: z.array(z.string().trim().min(1).max(200)).max(200).default([]),
  // 第 447 步加的：项目钩子，在固定时机替用户跑的命令；旧设置没有
  hooks: z.object({ afterEdit: hookCommandSchema, beforeCommand: hookCommandSchema, turnEnd: hookCommandSchema }).default({ afterEdit: null, beforeCommand: null, turnEnd: null }),
  // v2 · M10：按项目单独设的安全开关；旧设置没有
  security: z.lazy(() => projectSecuritySchema).optional(),
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
  chromeDirect: z.boolean().optional(),
  chromePath: z.string().min(1).max(4096).nullable().optional(),
  devTools: z.boolean().optional(),
})

export const permissionModeSchema = z.enum(['ask', 'auto', 'full'])

// 旧设置文件里还有结束时检查的开关（staticCheck、lightScan、review、taint、licenses、semgrep），读的时候丢掉，下次保存就没了
export const securitySchema = z.object({
  deepScan: z.boolean(),
})

// 用量的单价和预算（v2 · M11）：金额是小数字符串（最多 6 位小数），按整数算
const priceString = z.string().trim().regex(/^\d{1,7}(\.\d{1,6})?$/, '单价要填数字，最多 6 位小数')
export const usageSettingsSchema = z.object({
  currency: z.enum(['CNY', 'USD']),
  prices: z.array(z.object({
  providerId: z.string().max(200).nullable(),
  modelId: z.string().min(1).max(300),
  input: priceString,
  cachedInput: priceString.nullable().optional(),
  cacheWrite: priceString.nullable().optional(),
  output: priceString,
})).max(500),
  monthlyBudget: priceString.nullable(),
  budgetNotice: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), level: z.union([z.literal(80), z.literal(100)]) }).nullable(),
})

// 按项目单独设的安全开关（v2 · M10）：每项都可以不写
export const projectSecuritySchema = z.object({ deepScan: z.boolean() }).partial()

// goalMaxRounds 是第 17 步加的，旧设置文件里没有
export const executionSchema = z.object({
  compactAtPercent: z.literal(COMPACT_AT_PERCENTS),
  maxSteps: z.literal(MAX_STEP_OPTIONS).nullable(),
  goalMaxRounds: z.literal(GOAL_ROUND_OPTIONS).default(DEFAULT_EXECUTION.goalMaxRounds),
  // 第 446 步加的，旧设置文件里没有
  autoMemory: z.boolean().default(false),
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
  // v2 加的：浏览器登录的远程服务器，旧设置没有
  auth: z.literal('oauth').optional(),
})

export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

export const externalAgentConfigSchema = z.object({
  id: z.string().min(1).max(100),
  presetId: z.string().min(1).nullable(),
  name: z.string().trim().min(1).max(60),
  command: z.string().trim().min(1).max(1000),
  args: z.array(z.string().max(2000)).max(50),
  envNames: z.array(z.string().regex(ENV_NAME_PATTERN)).max(50),
})

// projects 和 lastProject 是第 4 步加的，带默认值，第 3 步写下的设置文件照样能读
const settingsSchema = z.object({
  version: z.literal(1),
  providers: z.array(providerFieldsSchema.extend({ id: z.string().min(1) })),
  roles: z.object({
    coder: modelRefSchema.nullable(),
    planner: modelRefSchema.nullable(),
    explorer: modelRefSchema.nullable().default(null),
    implementer: modelRefSchema.nullable().default(null),
    reviewer: modelRefSchema.nullable(),
    tester: modelRefSchema.nullable().default(null),
    fallback: modelRefSchema.nullable(),
  }),
  projects: z.record(z.string(), projectSettingsSchema).default({}),
  lastProject: z.string().nullable().default(null),
  // 从侧边栏归档的项目；第 700 步加的，旧设置文件里没有
  archivedProjects: z.array(z.string().min(1)).default([]),
  // 第 11 步加的
  appearance: appearanceSchema.default(() => ({ ...DEFAULT_APPEARANCE })),
  // 第 263 步加的
  layout: layoutSchema.default(() => ({ ...DEFAULT_LAYOUT })),
  // 第 273 步加的
  browser: browserSettingsSchema.default(() => ({ ...DEFAULT_BROWSER })),
  // v2 加的：电脑操控，默认关
  computerUse: z.object({ enabled: z.boolean(), acknowledged: z.boolean() }).optional(),
  // v2 加的：托盘和开机自启，默认都关
  system: z.object({ tray: z.boolean(), launchAtLogin: z.boolean() }).optional(),
  // 下一句建议；旧设置没有，默认开
  suggestions: z.object({ nextPrompt: z.boolean() }).default(defaultSuggestions),
  // v2 · M11：用量的单价和预算；旧设置没有
  usage: z.lazy(() => usageSettingsSchema).optional(),
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
        // 第 598 步加的
        subdir: z.string().nullable().default(null),
        enabled: z.boolean(),
        // 第 600 步加的
        hooksApproved: z.string().nullable().default(null),
      }),
    )
    .default([]),
  // 第 119 步加的
  defaultWorkspace: z.string().nullable().default(null),
  // 第 293 步加的：上次启动的版本，升级后第一次启动提示改了什么
  lastSeenVersion: z.string().nullable().default(null),
  // 第 531 步加的
  reasoningChoices: z.record(z.string(), z.enum(REASONING_EFFORTS)).default({}),
  // 外接智能体（v2）加的；旧版 Diffra 读到会丢掉这一项，下次保存时就没了，任务记录不受影响
  externalAgents: z.array(externalAgentConfigSchema).default([]),
})

const EMPTY_SETTINGS: Settings = {
  version: 1,
  providers: [],
  roles: { coder: null, planner: null, explorer: null, implementer: null, reviewer: null, tester: null, fallback: null },
  projects: {},
  lastProject: null,
  archivedProjects: [],
  appearance: DEFAULT_APPEARANCE,
  layout: DEFAULT_LAYOUT,
  browser: DEFAULT_BROWSER,
  defaultPermissionMode: 'ask',
  security: DEFAULT_SECURITY,
  execution: DEFAULT_EXECUTION,
  mcpServers: [],
  plugins: [],
  defaultWorkspace: null,
  lastSeenVersion: null,
  reasoningChoices: {},
  externalAgents: [],
  suggestions: defaultSuggestions(),
}

export class SettingsStore {
  private current: Settings = EMPTY_SETTINGS
  private readonly queue = new WriteQueue()
  private readonly file: string
  loadError: string | null = null

  private constructor(file: string) {
    this.file = file
  }

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
