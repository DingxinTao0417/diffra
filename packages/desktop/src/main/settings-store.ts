import { join } from 'node:path'
import { PROTOCOLS } from '@diffra/core/types'
import { z } from 'zod'
import { CONTENT_WIDTHS, DEFAULT_APPEARANCE, FONT_SIZES, PALETTES, type Settings, THEME_MODES } from '../shared/settings'
import { readJsonFile, WriteQueue, writeJsonFileAtomic } from './json-file'

export const modelRefSchema = z.object({ providerId: z.string().min(1), modelId: z.string().min(1) })

export const providerFieldsSchema = z.object({
  presetId: z.string().nullable(),
  name: z.string().trim().min(1, '名称不能为空'),
  protocol: z.enum(PROTOCOLS),
  baseUrl: z.url({ protocol: /^https?$/, error: '地址必须是 http(s) 开头的完整 URL' }),
  models: z
    .array(
      z.object({
        id: z.string().trim().min(1, '模型 ID 不能为空'),
        contextWindow: z.number().int().positive().nullable(),
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

export const projectRuleSettingsSchema = z.object({
  disabledPacks: z.array(z.string().min(1)),
  disabledRules: z.array(z.string().min(1)),
  includeRecommended: z.boolean(),
  review: z.boolean(),
})

export const projectSettingsSchema = z.object({
  checks: sessionChecksSchema,
  readOnlyPaths: z.array(readOnlyPathSchema).default([]),
  // 第 10 步加的，旧设置文件里没有这一项
  rules: projectRuleSettingsSchema.default(() => ({ disabledPacks: [], disabledRules: [], includeRecommended: false, review: false })),
})

export const appearanceSchema = z.object({
  theme: z.enum(THEME_MODES),
  palette: z.enum(PALETTES),
  fontSize: z.enum(FONT_SIZES),
  contentWidth: z.enum(CONTENT_WIDTHS),
})

export const permissionModeSchema = z.enum(['ask', 'auto', 'full'])

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
  defaultPermissionMode: permissionModeSchema.default('ask'),
})

const EMPTY_SETTINGS: Settings = {
  version: 1,
  providers: [],
  roles: { coder: null, planner: null, reviewer: null, fallback: null },
  projects: {},
  lastProject: null,
  appearance: DEFAULT_APPEARANCE,
  defaultPermissionMode: 'ask',
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
