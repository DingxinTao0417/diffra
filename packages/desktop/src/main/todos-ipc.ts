import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, Notification } from 'electron'
import { z } from 'zod'
import { IPC_CHANNELS } from '../shared/ipc'
import { type Todo, TODO_MAX_ITEMS, TODO_MAX_TAGS, TODO_MAX_TAG_LENGTH, TODO_MAX_TEXT } from '../shared/todos'
import { parse } from './ipc-input'
import { readJsonFile, WriteQueue, writeJsonFileAtomic } from './json-file'

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
    })
    .nullable()
    .optional(),
}) satisfies z.ZodType<Todo>

const fileSchema = z.object({ version: z.literal(1), todos: z.array(todoSchema) })

// 待办：存在数据目录的 todos.json，整份读写。条数有上限，一份文件不会大到拖慢
export function registerTodosIpc(userDataDir: string): void {
  const path = join(userDataDir, 'todos.json')
  const queue = new WriteQueue()
  let cache: Todo[] | null = null
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

  ipcMain.handle(IPC_CHANNELS.todosList, () => load())
  ipcMain.handle(IPC_CHANNELS.todosSave, (_event, raw: unknown) => {
    const todos = parse(z.array(todoSchema).max(TODO_MAX_ITEMS, `待办最多 ${TODO_MAX_ITEMS} 条，先删掉一些已完成的`), raw)
    pending++
    return queue.run(async () => {
      await writeJsonFileAtomic(path, { version: 1, todos })
      cache = todos
      return todos
    }).finally(() => pending--)
  })
}
