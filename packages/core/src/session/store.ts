import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelMessage } from 'ai'
import { z } from 'zod'
import { PROMPT_IMAGE_TYPES, type SessionSearchResult, type StoredTurn } from '../protocol.js'
import { taskStateSchema, type TaskState } from './task-state.js'

// 会话 id 拼进文件名，只接受 UUID 这类字符，防止路径穿越
const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/
const INDEX_FILE = 'index.json'
const MAX_SEARCH_RESULTS = 20
const SNIPPET_RADIUS = 40

export interface StoredTurnRecord extends StoredTurn {
  // 这一轮开始前的检查点提交；没打上检查点时为 null
  checkpoint: string | null
  // 这一轮里 Git 命令挪了 HEAD 之后的基线提交（检查点仓库里），见 Session.turnGitBases；没挪过的轮次没有
  gitBase?: string
  // 这一轮的提问在 messages 里的位置
  messageStart: number | null
}

// 上下文压缩：发给模型的是 summary 这条消息加上 messages[upTo..]，messages 本身保留原文
export interface Compaction {
  upTo: number
  summary: string
}

// 一个会话一个文件，每轮开始和结束时整体重写。不存模型接入点和密钥，加载时用当时的设置
export interface SessionRecord {
  taskState?: TaskState
  version: 1
  id: string
  cwd: string
  title: string
  createdAt: string
  updatedAt: string
  archived: boolean
  // 设计任务（见 SessionConfig.design）；旧记录没有
  design?: boolean
  // 设计任务的风格预设（见 SessionConfig.designStyle）；旧记录没有
  designStyle?: string | null
  // 无项目任务（见 SessionConfig.noProject）；旧记录没有
  noProject?: boolean
  turns: StoredTurnRecord[]
  messages: ModelMessage[]
  compaction: Compaction | null
}

export interface SessionIndexEntry {
  id: string
  cwd: string
  title: string
  createdAt: string
  updatedAt: string
  archived: boolean
  turnCount: number
  design: boolean
  noProject: boolean
}

const indexEntrySchema = z.object({
  id: z.string(),
  cwd: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archived: z.boolean(),
  turnCount: z.number(),
  // 必填：旧索引没有这一项，读取时走重建，从会话文件拿到真实值
  design: z.boolean(),
  // 旧任务都不是无项目任务，不用重建
  noProject: z.boolean().default(false),
})
const indexSchema = z.object({ version: z.literal(1), sessions: z.array(indexEntrySchema) })
// 消息和更新是 AI SDK / ACP 的结构，这里只检查外层，内容原样还给它们
const recordSchema = z.object({
  taskState: taskStateSchema.optional(),
  version: z.literal(1),
  id: z.string(),
  cwd: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archived: z.boolean(),
  // 设计模式加的，旧记录都是普通任务
  design: z.boolean().default(false),
  // 风格预设加的，旧记录都没用预设
  designStyle: z.string().nullable().default(null),
  // 无项目任务加的，旧记录都在项目里
  noProject: z.boolean().default(false),
  turns: z.array(
    z.object({
      id: z.string(),
      // 第 14 步加的，旧记录都是普通提问；第 15 步加了出计划
      kind: z.enum(['prompt', 'deep-scan', 'plan', 'goal', 'compact', 'diagnose']).default('prompt'),
      prompt: z.string(),
      startedAt: z.string(),
      endedAt: z.string().nullable(),
      stopReason: z.string().nullable(),
      updates: z.array(z.unknown()),
      checkpoint: z.string().nullable(),
      // 第 413 步加的，只有 Git 命令挪过 HEAD 的轮次有
      gitBase: z.string().optional(),
      messageStart: z.number().int().nonnegative().nullable().default(null),
      // 第 17 步加的
      skills: z.array(z.string()).default([]),
  images: z.array(z.object({ mimeType: z.enum(PROMPT_IMAGE_TYPES), data: z.string() })).default([]),
      // 第 72 步加的，旧记录没有
      restoredAt: z.string().optional(),
      from: z.object({ sessionId: z.string(), title: z.string() }).optional(),
      // 第 360 步加的，旧记录没有
      remote: z.object({ deviceId: z.string(), name: z.string() }).optional(),
    }),
  ),
  messages: z.array(z.unknown()),
  // 第 7 步加的，旧记录没有压缩过
  compaction: z.object({ upTo: z.number().int().nonnegative(), summary: z.string() }).nullable().default(null),
})

const sameDir = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

export class SessionStore {
  // 写文件和改索引排成一队，避免两次保存交错
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly dir: string) {}

  save(record: SessionRecord): Promise<void> {
    return this.enqueue(async () => {
      await this.writeAtomic(this.fileOf(record.id), record)
      const index = await this.readIndex()
      const entry = toEntry(record)
      await this.writeIndex([entry, ...index.filter((item) => item.id !== record.id)])
    })
  }

  async load(id: string): Promise<SessionRecord> {
    const text = await readFile(this.fileOf(id), 'utf8').catch((error: unknown) => {
      if (isMissing(error)) throw new Error(`没有找到会话记录 ${id}`)
      throw error
    })
    const parsed = recordSchema.safeParse(JSON.parse(text))
    if (!parsed.success) throw new Error(`会话记录 ${id} 已损坏，无法打开`)
    return parsed.data as SessionRecord
  }

  async list(cwd?: string): Promise<SessionIndexEntry[]> {
    const index = await this.enqueue(() => this.readIndex())
    return index
      .filter((entry) => !cwd || sameDir(entry.cwd, cwd))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async update(id: string, change: { title?: string; archived?: boolean }): Promise<SessionIndexEntry> {
    const record = await this.load(id)
    const next: SessionRecord = {
      ...record,
      title: change.title ?? record.title,
      archived: change.archived ?? record.archived,
    }
    await this.save(next)
    return toEntry(next)
  }

  remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      await rm(this.fileOf(id), { force: true })
      const index = await this.readIndex()
      await this.writeIndex(index.filter((entry) => entry.id !== id))
    })
  }

  // 在标题、每轮的提问和 agent 的回复里找，不分大小写；归档的会话不搜。
  // 每次都要读一遍会话文件，个人使用的规模（几百个会话）没问题
  async search(query: string): Promise<SessionSearchResult[]> {
    const needle = query.trim().toLowerCase()
    if (!needle) return []
    const results: SessionSearchResult[] = []
    for (const entry of await this.list()) {
      if (entry.archived) continue
      const snippet = entry.title.toLowerCase().includes(needle)
        ? entry.title
        : await this.load(entry.id).then(
            (record) => findSnippet(record, needle),
            () => null,
          )
      if (snippet === null) continue
      results.push({ sessionId: entry.id, cwd: entry.cwd, title: entry.title, updatedAt: entry.updatedAt, snippet })
      if (results.length >= MAX_SEARCH_RESULTS) break
    }
    return results
  }

  private fileOf(id: string): string {
    if (!SESSION_ID.test(id)) throw new Error(`无效的会话 id：${id}`)
    return join(this.dir, `${id}.json`)
  }

  // 索引丢了或坏了就扫一遍会话文件重建，会话文件才是权威数据
  private async readIndex(): Promise<SessionIndexEntry[]> {
    try {
      const parsed = indexSchema.safeParse(JSON.parse(await readFile(join(this.dir, INDEX_FILE), 'utf8')))
      if (parsed.success) return parsed.data.sessions
      console.error('[sessions] 索引格式不对，重建', parsed.error)
    } catch (error) {
      if (!isMissing(error)) console.error('[sessions] 索引读取失败，重建', error)
    }
    return this.rebuildIndex()
  }

  private async rebuildIndex(): Promise<SessionIndexEntry[]> {
    const names = await readdir(this.dir).catch((error: unknown) => {
      if (isMissing(error)) return []
      throw error
    })
    const entries: SessionIndexEntry[] = []
    for (const name of names) {
      if (!name.endsWith('.json') || name === INDEX_FILE) continue
      try {
        entries.push(toEntry(await this.load(name.slice(0, -'.json'.length))))
      } catch (error) {
        console.error(`[sessions] 跳过无法读取的会话文件 ${name}`, error)
      }
    }
    await this.writeIndex(entries)
    return entries
  }

  private writeIndex(sessions: SessionIndexEntry[]): Promise<void> {
    return this.writeAtomic(join(this.dir, INDEX_FILE), { version: 1, sessions })
  }

  private async writeAtomic(path: string, value: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const temp = `${path}.tmp`
    await writeFile(temp, JSON.stringify(value), 'utf8')
    await rename(temp, path)
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task)
    this.tail = result.catch(() => {})
    return result
  }
}

export function toEntry(record: SessionRecord): SessionIndexEntry {
  return {
    id: record.id,
    cwd: record.cwd,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    archived: record.archived,
    turnCount: record.turns.length,
    design: record.design ?? false,
    noProject: record.noProject ?? false,
  }
}

function findSnippet(record: SessionRecord, needle: string): string | null {
  for (const turn of record.turns) {
    const texts = [
      turn.prompt,
      ...turn.updates.flatMap((update) =>
        update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? [update.content.text] : [],
      ),
    ]
    for (const text of texts) {
      const at = text.toLowerCase().indexOf(needle)
      if (at < 0) continue
      const start = Math.max(0, at - SNIPPET_RADIUS)
      const end = Math.min(text.length, at + needle.length + SNIPPET_RADIUS)
      return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`
    }
  }
  return null
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
