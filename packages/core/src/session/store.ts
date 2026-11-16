import { createHash } from 'node:crypto'
import { access, copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelMessage } from 'ai'
import { z } from 'zod'
import { type CandidateRunView, PROMPT_IMAGE_TYPES, type SessionAgentRef, type SessionSearchResult, type StoredTurn } from '../protocol.js'
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

// 一个会话的完整记录（内存里的样子）。磁盘上拆成两部分（第 437 步）：<id>.json 是会话头，存元数据、对话和每轮的元数据（version 2，
// 轮次里没有 updates）；每轮的界面更新存在 <id>/<轮次>.json。保存时只重写有变化的轮次（一般只有正在跑的这一轮）和会话头。
// 以前（version 1）所有更新都在一个文件里，长会话一次保存要序列化几十 MB；第一次保存时转成新格式，原文件留成 <id>.json.v1-backup。
// 不存模型接入点和密钥，加载时用当时的设置
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
  // 外接智能体的任务（v2）：用的哪个智能体、它那边的会话 id（重开时用 session/load 接上）。Diffra 自己的任务没有；
  // 旧版读到会丢掉这两项，当成没有对话历史的普通任务打开
  agent?: SessionAgentRef
  externalSessionId?: string | null
  // 多候选方案（v2）：每组候选在哪个仓库、起点是哪棵树、各自的 worktree 在哪；清理、应用、重开后接着选都靠它。旧记录没有
  candidateRuns?: CandidateRun[]
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
  agent?: SessionAgentRef
}

const agentRefSchema = z.object({ id: z.string().min(1), name: z.string().min(1) })

// 一组候选方案的内部记录：界面看到的（CandidateRunView）加上 worktree 的位置
export interface CandidateRun extends CandidateRunView {
  repoRoot: string
  subdir: string
  baseTree: string | null
  worktrees: Array<{ id: string; dir: string; links: string[]; tree: string | null }>
}

const candidateRunSchema = z.object({
  turnId: z.string(),
  status: z.enum(['running', 'ready', 'applied', 'discarded', 'cancelled', 'failed']),
  appliedId: z.string().nullable(),
  conflicts: z.array(z.string()).optional(),
  candidates: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      approach: z.string(),
      status: z.enum(['running', 'done', 'failed', 'cancelled']),
      verification: z.enum(['verified', 'unverified', 'no-edits', 'failed']).nullable(),
      summary: z.string().nullable(),
      error: z.string().nullable(),
      stats: z.object({ files: z.number(), added: z.number(), removed: z.number() }).nullable(),
      paths: z.array(z.string()),
    }),
  ),
  repoRoot: z.string(),
  subdir: z.string(),
  baseTree: z.string().nullable(),
  worktrees: z.array(z.object({ id: z.string(), dir: z.string(), links: z.array(z.string()), tree: z.string().nullable() })),
}) satisfies z.ZodType<CandidateRun>

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
  // 外接智能体（v2）加的，旧任务都是 Diffra 自己的
  agent: agentRefSchema.optional(),
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
  // 外接智能体（v2）加的，旧记录都是 Diffra 自己的任务
  agent: agentRefSchema.optional(),
  externalSessionId: z.string().min(1).nullable().optional(),
  // 多候选方案（v2）加的，旧记录没有
  candidateRuns: z.array(candidateRunSchema).optional(),
  turns: z.array(
    z.object({
      id: z.string(),
      // 第 14 步加的，旧记录都是普通提问；第 15 步加了出计划
      kind: z.enum(['prompt', 'deep-scan', 'plan', 'goal', 'compact', 'diagnose', 'apply']).default('prompt'),
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
      // v2 按计划执行加的，旧记录没有
      fromPlan: z.string().optional(),
      // 第 676 步加的：重新生成之前的那几次，和这一轮的更新一起存在轮次文件里
      versions: z
        .array(z.object({ startedAt: z.string(), endedAt: z.string().nullable(), stopReason: z.string().nullable(), updates: z.array(z.unknown()), edited: z.boolean(), messages: z.array(z.unknown()).optional() }))
        .optional(),
    }),
  ),
  messages: z.array(z.unknown()),
  // 第 7 步加的，旧记录没有压缩过
  compaction: z.object({ upTo: z.number().int().nonnegative(), summary: z.string() }).nullable().default(null),
})

const sameDir = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

// 写进某一轮文件时的样子：条数和最后一条（对象本身）。界面更新只会追加、合并最后一条或替换用量那条，两样都没变就是没改过
interface WrittenTurn {
  length: number
  last: unknown
  versions: number
}

export class SessionStore {
  // 写文件和改索引排成一队，避免两次保存交错
  private tail: Promise<unknown> = Promise.resolve()
  // 会话 id → 轮次 id → 这一轮文件上次写进去的样子。没有记录的会话（这个进程里第一次保存、或从旧格式读出来的）整份写
  private readonly written = new Map<string, Map<string, WrittenTurn>>()

  constructor(private readonly dir: string) {}

  save(record: SessionRecord): Promise<void> {
    return this.enqueue(async () => {
      const known = this.written.get(record.id)
      if (!known) await this.backupV1(record.id)
      const turns = known ?? new Map<string, WrittenTurn>()
      const turnDir = this.turnDirOf(record.id)
      await mkdir(turnDir, { recursive: true })
      for (const turn of record.turns) {
        const before = turns.get(turn.id)
        const last = turn.updates.at(-1)
        const versions = turn.versions?.length ?? 0
        if (before && before.length === turn.updates.length && before.last === last && before.versions === versions) continue
        // 有重新生成之前的版本时文件是 { updates, versions }，没有时照旧只是更新的数组
        await this.writeAtomic(join(turnDir, turnFileName(turn.id)), versions > 0 ? { updates: turn.updates, versions: turn.versions } : turn.updates)
        turns.set(turn.id, { length: turn.updates.length, last, versions })
      }
      // 重新生成撤掉的轮次
      const live = new Set(record.turns.map((turn) => turn.id))
      for (const id of [...turns.keys()]) {
        if (live.has(id)) continue
        await rm(join(turnDir, turnFileName(id)), { force: true })
        turns.delete(id)
      }
      this.written.set(record.id, turns)
      await this.writeAtomic(this.fileOf(record.id), { ...record, version: 2, turns: record.turns.map(({ updates: _updates, versions: _versions, ...turn }) => turn) })
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
    const raw = JSON.parse(text) as { version?: unknown; turns?: unknown }
    const split = raw.version === 2 && Array.isArray(raw.turns)
    // 新格式：把每轮的更新从轮次文件里读回来，拼成和旧格式一样的完整记录再校验
    const turns = split ? await Promise.all((raw.turns as Array<Record<string, unknown>>).map(async (turn) => ({ ...turn, ...(await this.readTurn(id, turn.id)) }))) : raw.turns
    const parsed = recordSchema.safeParse(split ? { ...raw, version: 1, turns } : raw)
    if (!parsed.success) throw new Error(`会话记录 ${id} 已损坏，无法打开`)
    const record = parsed.data as SessionRecord
    // 读出来的就是磁盘上的样子；这个进程里已经在写的会话不覆盖，它记的是内存里那份对象
    if (split && !this.written.has(id)) this.written.set(id, new Map(record.turns.map((turn) => [turn.id, { length: turn.updates.length, last: turn.updates.at(-1), versions: turn.versions?.length ?? 0 }])))
    return record
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
      await rm(this.turnDirOf(id), { recursive: true, force: true })
      await rm(`${this.fileOf(id)}${V1_BACKUP_SUFFIX}`, { force: true })
      this.written.delete(id)
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

  private turnDirOf(id: string): string {
    if (!SESSION_ID.test(id)) throw new Error(`无效的会话 id：${id}`)
    return join(this.dir, id)
  }

  // 某一轮的更新；文件没了或坏了只丢这一轮的显示，会话照样能打开
  private async readTurn(id: string, turnId: unknown): Promise<{ updates: unknown[]; versions?: unknown[] }> {
    if (typeof turnId !== 'string') return { updates: [] }
    try {
      const content: unknown = JSON.parse(await readFile(join(this.turnDirOf(id), turnFileName(turnId)), 'utf8'))
      if (Array.isArray(content)) return { updates: content }
      // 带重新生成之前的版本（第 676 步）
      const { updates, versions } = (content ?? {}) as { updates?: unknown; versions?: unknown }
      if (Array.isArray(updates)) return { updates, ...(Array.isArray(versions) ? { versions } : {}) }
      console.error(`[sessions] 会话 ${id} 第 ${turnId} 轮的记录格式不对，这一轮不显示`)
    } catch (error) {
      console.error(`[sessions] 会话 ${id} 第 ${turnId} 轮的记录读不了，这一轮不显示`, error)
    }
    return { updates: [] }
  }

  // 旧格式（所有更新在一个文件里）第一次转成新格式前，原文件复制一份留着；已经有备份或不是旧格式就不动
  private async backupV1(id: string): Promise<void> {
    const file = this.fileOf(id)
    const backup = `${file}${V1_BACKUP_SUFFIX}`
    if (await exists(this.turnDirOf(id)) || !(await exists(file)) || await exists(backup)) return
    await copyFile(file, backup)
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
    ...(record.agent ? { agent: record.agent } : {}),
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

const V1_BACKUP_SUFFIX = '.v1-backup'

// 轮次 id 由客户端给，平常是 UUID；拼文件名前和会话 id 一样只放行安全字符，别的换成哈希
function turnFileName(turnId: string): string {
  return `${SESSION_ID.test(turnId) ? turnId : createHash('sha256').update(turnId).digest('hex').slice(0, 32)}.json`
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}
