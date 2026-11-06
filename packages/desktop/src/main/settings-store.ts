import { join } from 'node:path'
import { PROTOCOLS } from '@diffra/core/types'
import { z } from 'zod'
import type { Settings } from '../shared/settings'
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

const settingsSchema = z.object({
  version: z.literal(1),
  providers: z.array(providerFieldsSchema.extend({ id: z.string().min(1) })),
  roles: z.object({
    coder: modelRefSchema.nullable(),
    planner: modelRefSchema.nullable(),
    reviewer: modelRefSchema.nullable(),
    fallback: modelRefSchema.nullable(),
  }),
})

const EMPTY_SETTINGS: Settings = {
  version: 1,
  providers: [],
  roles: { coder: null, planner: null, reviewer: null, fallback: null },
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
