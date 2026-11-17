import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'
import { z } from 'zod'

export const MAX_TASK_MESSAGE_CHARS = 20_000
export const MAX_TASK_MESSAGE_TITLE_CHARS = 500
export const MAX_TASK_MESSAGE_ERROR_CHARS = 4_000
export const MAX_PENDING_TASK_MESSAGES = 1_000
export const MAX_PENDING_TASK_MESSAGES_PER_SESSION = 100
const MAX_MESSAGE_FILE_BYTES = 256 * 1_024
const MESSAGE_ID = /^[A-Za-z0-9-]{1,64}$/
const RESERVED_FILE_ID = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const INTERRUPTED_MESSAGE = 'Execution was interrupted before completion was recorded. Side effects may already have happened. Review the target task before explicitly retrying with a new message id; this message will not run again.'

const idSchema = z.string().regex(MESSAGE_ID).refine((id) => !RESERVED_FILE_ID.test(id), 'Reserved file id')
const sourceSchema = z.strictObject({ sessionId: idSchema, title: z.string().max(MAX_TASK_MESSAGE_TITLE_CHARS), reply: z.literal(true).optional() })
const inputSchema = z.strictObject({
  id: idSchema.optional(),
  sourceSessionId: idSchema,
  targetSessionId: idSchema,
  text: z.string().min(1).max(MAX_TASK_MESSAGE_CHARS).refine((text) => text.trim().length > 0, 'Message must not be blank'),
  from: sourceSchema,
}).refine((input) => input.sourceSessionId === input.from.sessionId, 'Message source does not match from.sessionId')
  .refine((input) => input.sourceSessionId !== input.targetSessionId, 'Cannot send a message to the same task')

const messageSchema = z.strictObject({
  version: z.literal(1),
  id: idSchema,
  sourceSessionId: idSchema,
  targetSessionId: idSchema,
  text: z.string().min(1).max(MAX_TASK_MESSAGE_CHARS).refine((text) => text.trim().length > 0, 'Message must not be blank'),
  from: sourceSchema,
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']),
  turnId: idSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  error: z.string().min(1).max(MAX_TASK_MESSAGE_ERROR_CHARS).optional(),
}).refine((message) => message.sourceSessionId === message.from.sessionId && message.sourceSessionId !== message.targetSessionId, 'Invalid message source')

const finishSchema = z.strictObject({ status: z.enum(['completed', 'failed', 'cancelled']), error: z.string().min(1).max(MAX_TASK_MESSAGE_ERROR_CHARS).optional() })

export type TaskMessageInput = z.infer<typeof inputSchema>
export type TaskMessage = z.infer<typeof messageSchema>
export type TaskMessageStatus = TaskMessage['status']
export type TaskMessageFinish = z.infer<typeof finishSchema>

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

// root 是专用邮箱目录，每条消息一个 <id>.json；只保存消息和回执，不保存会话配置。
// 一个 core 共用一个实例。claim 成功落盘后才能执行对应 turnId；执行结果落盘后再 finish。
export class TaskMailbox {
  private static readonly operations = new Map<string, Promise<unknown>>()
  private readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  async enqueue(input: TaskMessageInput): Promise<TaskMessage> {
    const parsed = inputSchema.parse(input)
    return this.serial(async () => {
      await this.directory()
      const id = parsed.id ?? randomUUID()
      const existing = await this.read(id)
      if (existing) {
        if (existing.sourceSessionId !== parsed.sourceSessionId || existing.targetSessionId !== parsed.targetSessionId || existing.text !== parsed.text || existing.from.title !== parsed.from.title || existing.from.reply !== parsed.from.reply) {
          throw new Error(`Message id ${id} is already used for a different message.`)
        }
        return existing
      }
      const pending = (await this.all()).filter((message) => message.status === 'pending' || message.status === 'running')
      if (pending.length >= MAX_PENDING_TASK_MESSAGES) throw new Error('The task message queue is full.')
      if (pending.filter((message) => message.targetSessionId === parsed.targetSessionId).length >= MAX_PENDING_TASK_MESSAGES_PER_SESSION) throw new Error(`The message queue for task ${parsed.targetSessionId} is full.`)
      const now = new Date().toISOString()
      const message: TaskMessage = { ...parsed, id, version: 1, status: 'pending', turnId: randomUUID(), createdAt: now, updatedAt: now }
      await this.write(message)
      return message
    })
  }

  async claim(id: string): Promise<TaskMessage | null> {
    const parsedId = idSchema.parse(id)
    return this.serial(async () => {
      await this.directory()
      const message = await this.read(parsedId)
      if (!message || message.status !== 'pending') return null
      const running: TaskMessage = { ...message, status: 'running', updatedAt: new Date().toISOString() }
      await this.write(running)
      return running
    })
  }

  async finish(id: string, input: TaskMessageFinish): Promise<TaskMessage> {
    const parsedId = idSchema.parse(id)
    const finish = finishSchema.parse(input)
    return this.serial(async () => {
      await this.directory()
      const message = await this.read(parsedId)
      if (!message) throw new Error(`No task message with id ${parsedId}.`)
      if (message.status !== 'pending' && message.status !== 'running') {
        if (message.status === finish.status && message.error === finish.error) return message
        throw new Error(`Task message ${parsedId} already ended with status ${message.status}.`)
      }
      if (finish.status === 'completed' && message.status !== 'running') throw new Error(`Task message ${parsedId} must be claimed before completion.`)
      const ended: TaskMessage = { ...message, ...finish, updatedAt: new Date().toISOString() }
      await this.write(ended)
      return ended
    })
  }

  async get(id: string): Promise<TaskMessage | null> {
    const parsedId = idSchema.parse(id)
    return this.serial(async () => {
      await this.directory()
      return this.read(parsedId)
    })
  }

  async pending(targetSessionId?: string): Promise<TaskMessage[]> {
    const target = targetSessionId === undefined ? undefined : idSchema.parse(targetSessionId)
    return this.serial(async () => {
      await this.directory()
      return (await this.all()).filter((message) => message.status === 'pending' && (target === undefined || message.targetSessionId === target))
    })
  }

  // 仅在启动、尚未分发任何消息时调用。running 可能已经有副作用，永不自动改回 pending。
  recover(): Promise<TaskMessage[]> {
    return this.serial(async () => {
      await this.directory()
      const recovered: TaskMessage[] = []
      for (const message of await this.all()) {
        if (message.status !== 'running') continue
        const failed: TaskMessage = { ...message, status: 'failed', error: INTERRUPTED_MESSAGE, updatedAt: new Date().toISOString() }
        await this.write(failed)
        recovered.push(failed)
      }
      return recovered
    })
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const key = process.platform === 'win32' ? this.root.toLowerCase() : this.root
    const next = (TaskMailbox.operations.get(key) ?? Promise.resolve()).then(work)
    // 前一次写失败不能堵住后续操作；调用方仍收到 next 的原始错误。
    const tail = next.then(() => undefined, () => undefined)
    TaskMailbox.operations.set(key, tail)
    return next.finally(() => {
      if (TaskMailbox.operations.get(key) === tail) TaskMailbox.operations.delete(key)
    })
  }

  private async directory(): Promise<void> {
    const paths: string[] = []
    for (let path = this.root; path !== parse(path).root; path = dirname(path)) paths.unshift(path)
    for (const path of paths) {
      let info
      try {
        info = await lstat(path)
      } catch (error) {
        if (!isMissing(error)) throw error
        try {
          await mkdir(path, { mode: 0o700 })
        } catch (mkdirError) {
          if (!(mkdirError instanceof Error && 'code' in mkdirError && mkdirError.code === 'EEXIST')) throw mkdirError
        }
        info = await lstat(path)
      }
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Task mailbox directory must not contain links or non-directories: ${path}`)
    }
  }

  private async file(path: string) {
    try {
      const info = await lstat(path)
      if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new Error(`Task mailbox file must be a regular, unlinked file: ${path}`)
      return info
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  private async read(id: string): Promise<TaskMessage | null> {
    const path = join(this.root, `${id}.json`)
    const info = await this.file(path)
    if (!info) return null
    if (info.size > MAX_MESSAGE_FILE_BYTES) throw new Error(`Task message ${id} is too large.`)
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let text: string
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== info.dev || opened.ino !== info.ino || opened.size > MAX_MESSAGE_FILE_BYTES) throw new Error(`Task message ${id} changed while being opened.`)
      text = await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
    const message = messageSchema.parse(JSON.parse(text))
    if (message.id !== id) throw new Error(`Task message ${id} does not match its file name.`)
    return message
  }

  private async all(): Promise<TaskMessage[]> {
    const messages: TaskMessage[] = []
    for (const name of await readdir(this.root)) {
      if (!name.endsWith('.json')) continue
      const id = idSchema.parse(name.slice(0, -'.json'.length))
      const message = await this.read(id)
      if (message) messages.push(message)
    }
    return messages.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  }

  private async write(message: TaskMessage): Promise<void> {
    await this.directory()
    const path = join(this.root, `${message.id}.json`)
    await this.file(path)
    const temporary = join(this.root, `.${message.id}.${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    let renamed = false
    try {
      try {
        await handle.writeFile(`${JSON.stringify(message)}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.directory()
      await this.file(path)
      await rename(temporary, path)
      renamed = true
      // Windows 不支持打开目录 fsync；文件内容已在 rename 前同步。
      if (process.platform !== 'win32') {
        const directory = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try {
          await directory.sync()
        } finally {
          await directory.close()
        }
      }
    } finally {
      if (!renamed) {
        await this.directory()
        if (await this.file(temporary)) await unlink(temporary)
      }
    }
  }
}
