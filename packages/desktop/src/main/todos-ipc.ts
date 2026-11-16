import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { app, BrowserWindow, ipcMain, Notification } from 'electron'
import { z } from 'zod'
import type { TodoActionParams, TodoActionResult, TodoQuery, TodoView } from '@diffra/core/types'
import { IPC_CHANNELS } from '../shared/ipc'
import { MAX_ATTACHMENT_PATH_LENGTH, MAX_PROMPT_FILE_REFERENCES } from '../shared/attachments'
import { mergeTodoLists, mergeTombstones, normalizeTodoTags, syncableTodo, tagMatches, type Todo, type TodoRepeatKind, TODO_MAX_IMAGES, TODO_MAX_ITEMS, TODO_MAX_TAGS, TODO_MAX_TAG_LENGTH, TODO_MAX_TEXT, TODO_REPEAT_KINDS, type TodoTombstone } from '../shared/todos'
import { parse } from './ipc-input'
import { readJsonFile, WriteQueue, writeJsonFileAtomic } from './json-file'
import { logEvent } from './app-log'

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
  archivedAt: z.iso.datetime().nullable().optional(),
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

// 智能体读写待办（v2 工具层）：和界面用同一个 cache / write，不直接改 todos.json。注册 IPC 时填上
export const todoHost: {
  act(params: TodoActionParams): Promise<TodoActionResult>
} = {
  act: () => Promise.reject(new Error('待办还没准备好')),
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

  const samePath = (a: string | null, b: string | null) => (process.platform === 'win32' ? (a ?? '').toLowerCase() === (b ?? '').toLowerCase() : a === b)
  const toView = (todo: Todo): TodoView => ({
    id: todo.id,
    text: todo.text,
    ...(todo.body !== undefined ? { body: todo.body } : {}),
    ...(todo.priority !== undefined ? { priority: todo.priority } : {}),
    project: todo.project,
    tags: todo.tags,
    createdAt: todo.createdAt,
    ...(todo.updatedAt !== undefined ? { updatedAt: todo.updatedAt } : {}),
    done: todo.done,
    ...(todo.archivedAt !== undefined ? { archivedAt: todo.archivedAt } : {}),
    ...(todo.schedule
      ? {
          schedule: {
            at: todo.schedule.at,
            repeat: todo.schedule.repeat ? { every: todo.schedule.repeat.every, interval: todo.schedule.repeat.interval, start: todo.schedule.repeat.start } : null,
          },
        }
      : {}),
  })
  const matches = (todo: Todo, query: TodoQuery): boolean => {
    if (query.archived === true ? !todo.archivedAt : Boolean(todo.archivedAt)) return false
    if (query.project !== undefined && !samePath(todo.project, query.project)) return false
    if (query.done !== undefined && todo.done !== query.done) return false
    if (query.priority !== undefined && todo.priority !== query.priority) return false
    if (query.tags && query.tags.length > 0 && !query.tags.every((tag) => todo.tags.some((item) => tagMatches(item, tag)))) return false
    if (query.query) {
      const words = query.query.toLowerCase()
      if (!`${todo.text}\n${todo.body ?? ''}`.toLowerCase().includes(words)) return false
    }
    if (query.dueFrom && (!todo.schedule || todo.schedule.at < query.dueFrom)) return false
    if (query.dueTo && (!todo.schedule || todo.schedule.at > query.dueTo)) return false
    return true
  }
  const scheduleOf = (at: string, repeat: { every: TodoRepeatKind; interval?: number } | undefined) => ({
    at,
    action: { kind: 'remind' as const },
    result: null,
    ...(repeat ? { repeat: { every: repeat.every, interval: repeat.interval ?? 1, start: at } } : {}),
  })
  const fail = (error: string): TodoActionResult => ({ ok: false, error })

  // 智能体工具：读、增、改、归档/删除、完成。读不加锁；写和界面保存排同一个队列，避免互相覆盖
  todoHost.act = async (params) => {
    pending++
    try {
      return await queue.run(async () => {
        const current = await load()
        if (params.action === 'read') {
          const list = current.filter((todo) => matches(todo, params.query)).slice(0, params.query.limit ?? 50)
          logEvent(`[todo] read session=${params.sessionId} count=${list.length}`)
          return { ok: true, todos: list.map(toView), summary: `找到 ${list.length} 条待办` }
        }
        const change = params.write
        const now = new Date().toISOString()
        const deleted = await loadTombstones()
        if (change.action === 'add') {
          const added: Todo[] = change.items.map((item) => ({
            id: randomUUID(),
            text: item.text.trim(),
            ...(item.body !== undefined ? { body: item.body.trim() } : {}),
            ...(item.priority !== undefined && item.priority !== null ? { priority: item.priority } : {}),
            project: item.project === undefined ? null : item.project,
            tags: normalizeTodoTags(item.tags ?? []),
            createdAt: now,
            done: false,
            sentTo: null,
            updatedAt: now,
            ...(item.remindAt ? { schedule: scheduleOf(item.remindAt, item.repeat) } : {}),
          }))
          await write([...added, ...current], deleted, null)
          for (const listener of listeners) listener()
          logEvent(`[todo] add session=${params.sessionId} count=${added.length}`)
          return { ok: true, todos: added.map(toView), summary: `已新建 ${added.length} 条待办` }
        }
        const ids = new Set(change.ids)
        const missing = change.ids.filter((id) => !current.some((todo) => todo.id === id))
        if (missing.length > 0) return fail(`找不到这些待办：${missing.join('、')}`)
        if (change.action === 'delete') {
          const removed = current.filter((todo) => ids.has(todo.id))
          if (change.mode === 'delete') {
            const next = current.filter((todo) => !ids.has(todo.id))
            const allDeleted = mergeTombstones(deleted, removed.map((todo) => ({ id: todo.id, at: now })), Date.now())
            await write(next, allDeleted, null)
            for (const listener of listeners) listener()
            logEvent(`[todo] permanent-delete session=${params.sessionId} count=${removed.length}`)
            return { ok: true, todos: removed.map(toView), summary: `已永久删除 ${removed.length} 条待办` }
          }
          const next = current.map((todo) => (ids.has(todo.id) ? { ...todo, archivedAt: now, updatedAt: now } : todo))
          await write(next, deleted, null)
          for (const listener of listeners) listener()
          logEvent(`[todo] archive session=${params.sessionId} count=${removed.length}`)
          return { ok: true, todos: next.filter((todo) => ids.has(todo.id)).map(toView), summary: `已归档 ${removed.length} 条待办` }
        }
        if (change.action === 'complete') {
          const next = current.map((todo) => (ids.has(todo.id) ? { ...todo, done: change.done, updatedAt: now } : todo))
          await write(next, deleted, null)
          for (const listener of listeners) listener()
          logEvent(`[todo] complete session=${params.sessionId} done=${change.done} count=${ids.size}`)
          return { ok: true, todos: next.filter((todo) => ids.has(todo.id)).map(toView), summary: `${change.done ? '已完成' : '已取消完成'} ${ids.size} 条待办` }
        }
        const fields = change.fields
        if (fields.repeat !== undefined && fields.remindAt === undefined) {
          const noSchedule = current.filter((todo) => ids.has(todo.id) && !todo.schedule)
          if (noSchedule.length > 0) return fail('这几条待办还没有提醒时间，不能单独设置重复')
        }
        let next = current.map((todo) => {
          if (!ids.has(todo.id)) return todo
          const updated: Todo = {
            ...todo,
            ...(fields.text !== undefined ? { text: fields.text.trim() } : {}),
            ...(fields.body !== undefined ? { body: fields.body.trim() } : {}),
            ...(fields.priority !== undefined ? { priority: fields.priority } : {}),
            ...(fields.project !== undefined ? { project: fields.project } : {}),
            ...(fields.tags !== undefined ? { tags: normalizeTodoTags(fields.tags) } : {}),
            ...(fields.done !== undefined ? { done: fields.done } : {}),
            ...(fields.archived !== undefined ? { archivedAt: fields.archived ? now : null } : {}),
            updatedAt: now,
          }
          if (fields.remindAt !== undefined) {
            if (fields.remindAt === null) delete updated.schedule
            else updated.schedule = scheduleOf(fields.remindAt, fields.repeat ?? undefined)
          } else if (fields.repeat !== undefined && updated.schedule) {
            updated.schedule = {
              ...updated.schedule,
              repeat: fields.repeat ? { every: fields.repeat.every, interval: fields.repeat.interval ?? 1, start: updated.schedule.at } : null,
            }
          }
          return updated
        })
        if (fields.position) {
          const selected = next.filter((todo) => ids.has(todo.id))
          const rest = next.filter((todo) => !ids.has(todo.id))
          next = fields.position === 'top' ? [...selected, ...rest] : [...rest, ...selected]
        }
        await write(next, deleted, null)
        for (const listener of listeners) listener()
        logEvent(`[todo] update session=${params.sessionId} count=${ids.size}`)
        return { ok: true, todos: next.filter((todo) => ids.has(todo.id)).map(toView), summary: `已修改 ${ids.size} 条待办` }
      })
    } finally {
      pending--
    }
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
