import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { app, BrowserWindow, ipcMain, Notification } from 'electron'
import { z } from 'zod'
import { IPC_CHANNELS } from '../shared/ipc'
import { MAX_ATTACHMENT_PATH_LENGTH, MAX_PROMPT_FILE_REFERENCES } from '../shared/attachments'
import { mergeTodoLists, mergeTombstones, syncableTodo, type Todo, TODO_MAX_IMAGES, TODO_MAX_ITEMS, TODO_MAX_TAGS, TODO_MAX_TAG_LENGTH, TODO_MAX_TEXT, TODO_REPEAT_KINDS, type TodoTombstone } from '../shared/todos'
import { parse } from './ipc-input'
import { readJsonFile, WriteQueue, writeJsonFileAtomic } from './json-file'

const IMAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// 和输入框里的图片（lib/images.ts）同一个上限
const MAX_IMAGE_CHARS = 4_000_000
// 存了图片还没存待办（对话框开着）时不能当成没人用删掉；超过这么久还没被哪条待办用上的才清掉
const ORPHAN_IMAGE_MS = 24 * 60 * 60 * 1000

const todoSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().trim().min(1).max(TODO_MAX_TEXT),
  // 正文、优先级都是第 485 步加的，旧数据没有；必须是选填，不然旧文件读进来整份作废
  body: z.string().max(TODO_MAX_TEXT).optional(),
  priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).nullable().optional(),
  project: z.string().min(1).nullable(),
  // 旧数据没有 tags，读出来补成空数组
  tags: z.array(z.string().trim().min(1).max(TODO_MAX_TAG_LENGTH)).max(TODO_MAX_TAGS).default([]),
  createdAt: z.iso.datetime(),
  done: z.boolean(),
  sentTo: z.object({ sessionId: z.string().min(1), title: z.string(), at: z.iso.datetime() }).nullable(),
  acceptedAt: z.iso.datetime().nullable().optional(),
  schedule: z
    .object({
      at: z.iso.datetime(),
      action: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('remind') }),
        z.object({
          kind: z.literal('send'),
          text: z.string().trim().min(1).max(TODO_MAX_TEXT * 10),
          target: z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('new'), project: z.string().min(1).nullable(), design: z.boolean() }),
            z.object({ kind: z.literal('existing'), sessionId: z.string().min(1), cwd: z.string().min(1), title: z.string() }),
          ]),
        }),
      ]),
      result: z
        .object({ kind: z.enum(['reminded', 'sent', 'missed', 'failed']), at: z.iso.datetime(), error: z.string().max(2000).optional() })
        .nullable(),
      // v2 加的：重复和上一次的处理结果，都是选填（旧版读到会丢掉，待办停在下一次）
      repeat: z.object({ every: z.enum(TODO_REPEAT_KINDS), interval: z.number().int().min(1).max(366), start: z.iso.datetime() }).nullable().optional(),
      last: z
        .object({ kind: z.enum(['reminded', 'sent', 'missed', 'failed', 'done']), at: z.iso.datetime(), error: z.string().max(2000).optional() })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  // v2：最近一次改动的时间（局域网同步按它决定谁新），选填
  updatedAt: z.iso.datetime().optional(),
  images: z.array(z.string().regex(IMAGE_ID)).max(TODO_MAX_IMAGES).optional(),
  files: z
    .array(z.object({ path: z.string().min(1).max(MAX_ATTACHMENT_PATH_LENGTH).refine(isAbsolute, '必须是本地绝对路径'), name: z.string().min(1).max(MAX_ATTACHMENT_PATH_LENGTH), kind: z.enum(['file', 'directory']) }))
    .max(MAX_PROMPT_FILE_REFERENCES)
    .optional(),
}) satisfies z.ZodType<Todo>

const fileSchema = z.object({ version: z.literal(1), todos: z.array(todoSchema) })
// 局域网同步（v2）：删掉的待办的墓碑，单独一个文件（todos.json 的格式不动，旧版照样读）
const tombstoneSchema = z.object({ id: z.string().min(1).max(64), at: z.iso.datetime() })
const syncFileSchema = z.object({ version: z.literal(1), deleted: z.array(tombstoneSchema) })

// 局域网同步用：本机的待办和墓碑；合进对方的（主进程写盘、推给界面）。注册 IPC 时填上
export const todoSync: {
  snapshot(): Promise<{ todos: Todo[]; deleted: TodoTombstone[] }>
  merge(todos: unknown[], deleted: TodoTombstone[]): Promise<{ todos: Todo[]; deleted: TodoTombstone[] }>
  // 本机的待办变了（同步的那边据此尽快推给对方）
  onChange(listener: () => void): void
} = {
  snapshot: () => Promise.reject(new Error('待办还没准备好')),
  merge: () => Promise.reject(new Error('待办还没准备好')),
  onChange: () => {},
}

// 对方发来的待办：一条条校验，不对的丢掉；本机没有的图片去掉（图片只在记下它的那台电脑上）
export function parseSyncedTodos(raw: unknown[], hasImage: (id: string) => boolean): Todo[] {
  return raw.flatMap((item) => {
    const parsed = todoSchema.safeParse(item)
    if (!parsed.success || !syncableTodo(parsed.data)) return []
    const todo = parsed.data
    return [todo.images ? { ...todo, images: todo.images.filter(hasImage) } : todo]
  })
}

// 待办：存在数据目录的 todos.json，整份读写。条数有上限，一份文件不会大到拖慢
export function registerTodosIpc(userDataDir: string): void {
  const path = join(userDataDir, 'todos.json')
  const imageDir = join(userDataDir, 'todo-attachments')
  const imagePath = (id: string) => join(imageDir, `${id}.webp`)
  const syncPath = join(userDataDir, 'todos-sync.json')
  const queue = new WriteQueue()
  let cache: Todo[] | null = null
  let tombstones: TodoTombstone[] | null = null
  const listeners: Array<() => void> = []
  const shown = new Set<Notification>()
  // 还没写完的保存次数。退出时有没写完的就先等写完再退（第 498 步）：主进程不等异步写盘，
  // Ctrl+J 记完马上退出应用，最后几条会丢（界面上的条数是内存里的，看着已经记上了）
  let pending = 0
  app.on('before-quit', (event) => {
    if (pending === 0) return
    event.preventDefault()
    void queue.run(async () => {}).finally(() => app.quit())
  })

  const load = async (): Promise<Todo[]> => {
    if (cache) return cache
    const content = await readJsonFile(path, fileSchema)
    if (content.state === 'invalid') console.error('[todos] todos.json 格式不对，按空列表打开；原文件下次保存时覆盖', content.error)
    cache = content.state === 'loaded' ? content.value.todos : []
    return cache
  }

  ipcMain.handle(IPC_CHANNELS.todosNotify, (_event, raw: unknown) => {
    const notice = parse(z.object({ todoId: z.string().min(1), title: z.string().min(1).max(200), body: z.string().max(TODO_MAX_TEXT) }), raw)
    if (!Notification.isSupported()) return
    const notification = new Notification({ title: notice.title, body: notice.body.length > 200 ? `${notice.body.slice(0, 200)}…` : notice.body })
    // 通知对象被回收后点击就没反应了，关掉之前一直留着
    shown.add(notification)
    notification.on('close', () => shown.delete(notification))
    notification.on('click', () => {
      shown.delete(notification)
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) return
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
      window.webContents.send(IPC_CHANNELS.todosFocus, notice.todoId)
    })
    notification.show()
  })

  // 删掉的待办、移除的图片留下的文件：没有哪条待办用、又放了一天以上的才删
  const removeOrphanImages = async (todos: Todo[]) => {
    const used = new Set(todos.flatMap((todo) => todo.images ?? []))
    const names = await readdir(imageDir).catch(() => [])
    for (const name of names) {
      const id = name.replace(/.webp$/, '')
      if (!IMAGE_ID.test(id) || name !== `${id}.webp` || used.has(id)) continue
      const info = await stat(imagePath(id))
      if (Date.now() - info.mtimeMs > ORPHAN_IMAGE_MS) await rm(imagePath(id), { force: true })
    }
  }

  ipcMain.handle(IPC_CHANNELS.todosSaveImage, async (_event, raw: unknown) => {
    const image = parse(z.object({ mimeType: z.literal('image/webp'), data: z.string().min(1).max(MAX_IMAGE_CHARS).regex(/^[A-Za-z0-9+/]+=*$/) }), raw)
    const id = randomUUID()
    await mkdir(imageDir, { recursive: true })
    await writeFile(imagePath(id), Buffer.from(image.data, 'base64'))
    return id
  })
  ipcMain.handle(IPC_CHANNELS.todosReadImage, async (_event, raw: unknown) => {
    const id = parse(z.string().regex(IMAGE_ID), raw)
    return { mimeType: 'image/webp', data: (await readFile(imagePath(id))).toString('base64') }
  })

  const loadTombstones = async (): Promise<TodoTombstone[]> => {
    if (tombstones) return tombstones
    const content = await readJsonFile(syncPath, syncFileSchema)
    tombstones = content.state === 'loaded' ? content.value.deleted : []
    return tombstones
  }

  // 写盘；和界面手里的不一样（合进了对方的）时推给界面换上
  const write = async (todos: Todo[], deleted: TodoTombstone[], shown: Todo[] | null) => {
    await writeJsonFileAtomic(path, { version: 1, todos })
    if (deleted !== tombstones) await writeJsonFileAtomic(syncPath, { version: 1, deleted })
    cache = todos
    tombstones = deleted
    if (shown === null || JSON.stringify(shown) !== JSON.stringify(todos)) for (const window of BrowserWindow.getAllWindows()) window.webContents.send(IPC_CHANNELS.todosChanged, todos)
    await removeOrphanImages(todos).catch((error: unknown) => console.error('[todos] 清理没用的附件图片失败', error))
  }

  ipcMain.handle(IPC_CHANNELS.todosList, () => load())
  // 界面存的是它手里的整份；base 是它改之前手里有哪些（v2）：基准里有、新列表里没有的才算界面删的，
  // 其间同步进来的（基准里没有）留着；同一条按改动时间取新的。没传 base 的（旧界面）按整份覆盖
  ipcMain.handle(IPC_CHANNELS.todosSave, (_event, raw: unknown, rawBase: unknown) => {
    const todos = parse(z.array(todoSchema).max(TODO_MAX_ITEMS, `待办最多 ${TODO_MAX_ITEMS} 条，先删掉一些已完成的`), raw)
    const base = parse(z.array(z.string().min(1).max(64)).max(TODO_MAX_ITEMS * 2).optional(), rawBase)
    pending++
    return queue
      .run(async () => {
        const current = await load()
        const kept = new Set(todos.map((todo) => todo.id))
        const removed = (base ?? current.map((todo) => todo.id)).filter((id) => !kept.has(id))
        const now = new Date().toISOString()
        const deleted = removed.length > 0 ? mergeTombstones(await loadTombstones(), removed.map((id) => ({ id, at: now })), Date.now()) : await loadTombstones()
        const merged = base ? mergeTodoLists(todos, current, deleted).slice(0, TODO_MAX_ITEMS) : todos
        await write(merged, deleted, todos)
        for (const listener of listeners) listener()
        return merged
      })
      .finally(() => pending--)
  })

  todoSync.snapshot = async () => ({ todos: (await load()).filter(syncableTodo), deleted: await loadTombstones() })
  todoSync.merge = (raw, deleted) =>
    queue.run(async () => {
      const current = await load()
      const incoming = parseSyncedTodos(raw, (id) => existsSync(imagePath(id)))
      const allDeleted = mergeTombstones(await loadTombstones(), deleted, Date.now())
      const merged = mergeTodoLists(current, incoming, allDeleted).slice(0, TODO_MAX_ITEMS)
      if (JSON.stringify(merged) !== JSON.stringify(current) || allDeleted.length !== (tombstones?.length ?? 0)) await write(merged, allDeleted, current)
      return { todos: merged.filter(syncableTodo), deleted: allDeleted }
    })
  todoSync.onChange = (listener) => {
    listeners.push(listener)
  }
}
