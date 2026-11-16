import { createReadStream } from 'node:fs'
import { appendFile, mkdir, open, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { LanguageModelUsage } from 'ai'
import { z } from 'zod'
import type { ModelProvider, ModelRole, UsageRecord } from '../protocol.js'

const MONTH_FILE = /^\d{4}-\d{2}\.jsonl$/

const count = z.number().int().nonnegative().nullable()
const usageRecordSchema = z.object({
  v: z.literal(1),
  at: z.iso.datetime(),
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  providerId: z.string().nullable(),
  providerName: z.string().nullable(),
  modelId: z.string().min(1),
  role: z.enum(['coder', 'reviewer', 'planner', 'subagent']),
  input: count,
  cacheRead: count,
  cacheWrite: count,
  output: count,
  reasoning: count,
}) satisfies z.ZodType<UsageRecord>

// 主循环交给 agent 的一次调用；agent 补上会话和时间再落盘
export interface ModelCallUsage {
  role: ModelRole
  provider: ModelProvider | null
  modelId: string
  usage: LanguageModelUsage
}

export function toUsageRecord(call: ModelCallUsage, session: { id: string; cwd: string }, at: Date): UsageRecord {
  const { usage } = call
  return {
    v: 1,
    at: at.toISOString(),
    sessionId: session.id,
    cwd: session.cwd,
    providerId: call.provider?.id ?? null,
    providerName: call.provider?.name ?? null,
    modelId: call.modelId,
    role: call.role,
    input: usage.inputTokens ?? null,
    cacheRead: usage.inputTokenDetails.cacheReadTokens ?? null,
    cacheWrite: usage.inputTokenDetails.cacheWriteTokens ?? null,
    output: usage.outputTokens ?? null,
    reasoning: usage.outputTokenDetails.reasoningTokens ?? null,
  }
}

// 一个月一个文件（按 UTC 月份），一行一次模型调用，只追加不改写。
// 只有 core 进程写；同一进程里的追加排队执行，行不会交错
export class UsageLog {
  private queue: Promise<void> = Promise.resolve()
  // 这个进程里已经检查过结尾的文件
  private readonly checked = new Set<string>()

  constructor(private readonly dir: string) {}

  append(record: UsageRecord): Promise<void> {
    const write = this.queue.then(async () => {
      await mkdir(this.dir, { recursive: true })
      const path = join(this.dir, monthFile(new Date(record.at)))
      const prefix = (await this.endsMidLine(path)) ? '\n' : ''
      await appendFile(path, `${prefix}${JSON.stringify(record)}\n`, 'utf8')
    })
    this.queue = write.catch(() => {})
    return write
  }

  // 上次进程在写一行时崩溃的话，文件末尾是半行；先补个换行，免得把新记录也接坏
  private async endsMidLine(path: string): Promise<boolean> {
    if (this.checked.has(path)) return false
    this.checked.add(path)
    const handle = await open(path, 'r').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!handle) return false
    try {
      const { size } = await handle.stat()
      if (size === 0) return false
      const last = Buffer.alloc(1)
      await handle.read(last, 0, 1, size - 1)
      return last[0] !== 0x0a
    } finally {
      await handle.close()
    }
  }

  // 各月的记录文件和大小（清理前给用户看），按月份排
  async files(): Promise<Array<{ month: string; bytes: number }>> {
    const names = await readdir(this.dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [] as string[]
      throw error
    })
    const files = await Promise.all(names.filter((name) => MONTH_FILE.test(name)).map(async (name) => ({ month: name.slice(0, 7), bytes: (await stat(join(this.dir, name))).size })))
    return files.sort((a, b) => (a.month < b.month ? -1 : 1))
  }

  // 删掉 before（YYYY-MM，UTC 月份）之前各月的记录文件；用户在用量页确认后才调（v2 · M11）。排在追加写后面，不和写入抢文件
  removeBefore(before: string): Promise<string[]> {
    const work = this.queue.then(async () => {
      const removed: string[] = []
      for (const file of await this.files()) {
        if (file.month >= before) continue
        await rm(join(this.dir, `${file.month}.jsonl`), { force: true })
        removed.push(file.month)
      }
      return removed
    })
    this.queue = work.then(
      () => {},
      () => {},
    )
    return work
  }

  // 逐行读 [from, to) 之间的记录，不把整个文件读进内存；格式不对的行跳过并计数
  // visit 返回 Promise 时等它（导出时边读边写，不把记录攒在内存里）
  async scan(from: Date, to: Date, visit: (record: UsageRecord) => unknown): Promise<{ skippedLines: number }> {
    const names = await readdir(this.dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [] as string[]
      throw error
    })
    const first = monthFile(from)
    const last = monthFile(new Date(to.getTime() - 1))
    let skippedLines = 0
    for (const name of names.filter((item) => MONTH_FILE.test(item) && item >= first && item <= last).sort()) {
      const lines = createInterface({ input: createReadStream(join(this.dir, name), 'utf8'), crlfDelay: Infinity })
      for await (const line of lines) {
        if (!line.trim()) continue
        const record = parseLine(line)
        if (!record) {
          skippedLines++
          continue
        }
        const at = Date.parse(record.at)
        if (at >= from.getTime() && at < to.getTime()) {
          const result = visit(record)
          if (result instanceof Promise) await result
        }
      }
    }
    return { skippedLines }
  }
}

function parseLine(line: string): UsageRecord | null {
  try {
    const parsed = usageRecordSchema.safeParse(JSON.parse(line))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function monthFile(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}.jsonl`
}
