import { appendFile, readFile, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_PEERS } from '@diffra/relay/protocol'
import { z } from 'zod'
import { REMOTE_LEVELS, type RemoteAuditEntry } from '../../shared/remote'
import { readJsonFile, WriteQueue, writeJsonFileAtomic } from '../json-file'

// 设备连接的状态都在数据目录的 remote/ 下：state.json 是总开关、本机名称、授权给别人的设备、自己连接的设备；
// audit.jsonl 是操作记录。总开关和名称不放进 settings.json，和配对、授权由同一个模块管

const deviceId = z.string().regex(/^[0-9a-f]{32}$/)
const key = z.base64().refine((value) => Buffer.from(value, 'base64').length === 32, '要 32 字节')
export const deviceNameSchema = z.string().trim().min(1).max(60)
export const projectGrantSchema = z.object({ path: z.string().min(1).max(1024), level: z.enum(REMOTE_LEVELS) })

const deviceSchema = z.object({
  deviceId,
  name: deviceNameSchema,
  signingKey: key,
  noiseKey: key,
  pairedAt: z.string(),
  lastSeenAt: z.string().nullable().default(null),
})

const stateSchema = z.object({
  version: z.literal(1),
  name: deviceNameSchema,
  allowIncoming: z.boolean(),
  // 本机授权给它们的设备（本机是被连接端）
  grants: z.array(deviceSchema.extend({ projects: z.array(projectGrantSchema).max(200) })),
  // 本机去连接的设备（本机是连接端）
  peers: z.array(deviceSchema),
})

export type RemoteState = z.infer<typeof stateSchema>
export type StoredDevice = z.infer<typeof deviceSchema>
export type StoredGrant = RemoteState['grants'][number]

// 中转的白名单一台设备最多 64 个，授权的和自己连接的加起来不能超过
export const MAX_DEVICES = MAX_PEERS

export class RemoteStateStore {
  private current: RemoteState
  private readonly queue = new WriteQueue()
  loadError: string | null = null

  private constructor(
    private readonly file: string,
    initial: RemoteState,
  ) {
    this.current = initial
  }

  static async open(dir: string, defaultName: string): Promise<RemoteStateStore> {
    const file = join(dir, 'state.json')
    const content = await readJsonFile(file, stateSchema)
    const name = deviceNameSchema.safeParse(defaultName).success ? defaultName.trim() : 'Diffra'
    const store = new RemoteStateStore(file, content.state === 'loaded' ? content.value : { version: 1, name, allowIncoming: false, grants: [], peers: [] })
    if (content.state === 'invalid') {
      console.error('[remote] 设备连接的状态文件解析失败', content.error)
      store.loadError = `设备连接的状态文件无法解析，为避免覆盖已暂停保存：${file}`
    }
    return store
  }

  get(): RemoteState {
    return this.current
  }

  update(change: (current: RemoteState) => RemoteState): Promise<RemoteState> {
    return this.queue.run(async () => {
      if (this.loadError) throw new Error(this.loadError)
      const next = stateSchema.parse(change(this.current))
      if (next.grants.length + next.peers.length > MAX_DEVICES) throw new Error(`配对的设备最多 ${MAX_DEVICES} 台`)
      await writeJsonFileAtomic(this.file, next)
      this.current = next
      return next
    })
  }
}

const AUDIT_MAX_BYTES = 5 * 1024 * 1024
const AUDIT_RECENT = 200
const auditSchema = z.object({ at: z.string(), deviceId, name: z.string(), action: z.string() })

// 操作记录：一行一条，单个文件超过 5 MB 就改名成 audit.1.jsonl（覆盖更旧的），留两份
export class AuditLog {
  private readonly queue = new WriteQueue()
  private readonly file: string
  private readonly older: string

  constructor(dir: string) {
    this.file = join(dir, 'audit.jsonl')
    this.older = join(dir, 'audit.1.jsonl')
  }

  // 记录失败不挡操作本身（撤销这类收紧权限的操作更不能因为记不下就不做），只报错
  append(entry: Omit<RemoteAuditEntry, 'at'>): Promise<void> {
    return this.queue
      .run(async () => {
        const size = await stat(this.file).then((info) => info.size, () => 0)
        if (size > AUDIT_MAX_BYTES) await rename(this.file, this.older)
        await appendFile(this.file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8')
      })
      .catch((error: unknown) => console.error('[remote] 写操作记录失败', error))
  }

  // 最近的在前
  async recent(): Promise<RemoteAuditEntry[]> {
    const lines: string[] = []
    for (const path of [this.older, this.file]) {
      const text = await readFile(path, 'utf8').catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return ''
        throw error
      })
      lines.push(...text.split('\n'))
    }
    const entries: RemoteAuditEntry[] = []
    for (const line of lines.slice(-AUDIT_RECENT * 2).reverse()) {
      if (!line.trim()) continue
      try {
        const parsed = auditSchema.safeParse(JSON.parse(line))
        if (parsed.success) entries.push(parsed.data)
      } catch {
        // 进程崩溃留下的半行，跳过
      }
      if (entries.length >= AUDIT_RECENT) break
    }
    return entries
  }
}
