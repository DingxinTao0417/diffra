import type { FileReference } from './attachments'

// 待办：侧栏「待办」页记的点子。project 是记下时所在的项目，无项目为 null；
// sentTo 是最近一次派给哪个任务（发送或填入输入框），没派过为 null
export interface Todo {
  id: string
  // 标题。字段名不改：旧版 Diffra 读到不认识的必填字段会把整份 todos.json 当成坏的、按空列表打开再覆盖
  text: string
  // 正文；旧数据没有这个字段（第 485 步之前），显示时按 todoParts 从 text 里拆
  body?: string
  // 优先级，0 是 P0（最急）；旧数据没有这个字段，当没设
  priority?: TodoPriority | null
  project: string | null
  // 自定义标签；旧数据没有这个字段，读出来时补成空数组
  tags: string[]
  createdAt: string
  done: boolean
  sentTo: { sessionId: string; title: string; at: string } | null
  // 派出去的任务完成后，用户验收的时间；旧数据没有这个字段
  acceptedAt?: string | null
  // 定了时间的待办；旧数据没有这个字段
  schedule?: TodoSchedule | null
  // 附件（第 638 步），派给任务时一起发；旧数据没有这两个字段。图片存在数据目录的 todo-attachments 里，这里只记 id；
  // 文件和输入框里加的一样只记路径，不复制内容
  images?: string[]
  files?: FileReference[]
}

export const TODO_MAX_IMAGES = 6

// 几条待办的附件合在一起：图片按 id、文件按路径去重
export function todoAttachments(todos: readonly Pick<Todo, 'images' | 'files'>[]): { images: string[]; files: FileReference[] } {
  const images = [...new Set(todos.flatMap((todo) => todo.images ?? []))]
  const files = todos.flatMap((todo) => todo.files ?? []).filter((file, index, all) => all.findIndex((item) => item.path === file.path) === index)
  return { images, files }
}

// 到时发给哪个任务：新任务（项目、是否设计任务）或已有任务
export type TodoSendTarget = { kind: 'new'; project: string | null; design: boolean } | { kind: 'existing'; sessionId: string; cwd: string; title: string }

export interface TodoSchedule {
  // 到期时刻（UTC ISO），界面按本地时间显示
  at: string
  // 到时只提醒，还是把 text 发给 target
  action: { kind: 'remind' } | { kind: 'send'; text: string; target: TodoSendTarget }
  // 到点后怎么处理的，没到点为 null。missed：应用没开着或晚了太久，定时发送不自动补发，等用户决定
  result: { kind: 'reminded' | 'sent' | 'missed' | 'failed'; at: string; error?: string } | null
}

export type TodoPriority = 0 | 1 | 2 | 3
export const TODO_PRIORITIES: readonly TodoPriority[] = [0, 1, 2, 3]

export const TODO_MAX_ITEMS = 1000
// 对话框里写的标题上限；旧数据的 text 可能更长，校验仍按 TODO_MAX_TEXT
export const TODO_MAX_TITLE = 200
export const TODO_MAX_TEXT = 4000
export const TODO_MAX_TAGS = 12
export const TODO_MAX_TAG_LENGTH = 30
// 一次输入里允许写多个标签（用逗号分开）时，输入框能容纳的字数
export const TODO_MAX_TAG_INPUT = TODO_MAX_TAG_LENGTH * TODO_MAX_TAGS

// 标签去掉首尾空白和开头的 #，不区分大小写去重；逗号分隔的一次拆成多个
export function normalizeTodoTags(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const tags: string[] = []
  for (const value of values) {
    for (const part of value.split(/[,，]/)) {
      const tag = part.trim().replace(/^#+/, '').slice(0, TODO_MAX_TAG_LENGTH)
      if (tag === '') continue
      const key = tag.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      tags.push(tag)
      if (tags.length >= TODO_MAX_TAGS) return tags
    }
  }
  return tags
}

// 标题和正文。旧数据没有 body：第一行当标题、其余当正文，只在显示时拆，不改写文件；用对话框编辑过一次后按拆开的存
export function todoParts(todo: Pick<Todo, 'text' | 'body'>): { title: string; body: string } {
  if (todo.body !== undefined) return { title: todo.text, body: todo.body }
  const text = todo.text.trim()
  const index = text.search(/\r?\n/)
  return index < 0 ? { title: text, body: '' } : { title: text.slice(0, index).trim(), body: text.slice(index).trim() }
}

// 派给任务时发出去的内容：标题加正文，不带优先级
export function todoMessage(todo: Pick<Todo, 'text' | 'body'>): string {
  const { title, body } = todoParts(todo)
  return body ? `${title}\n\n${body}` : title
}

// 快速记开头写 p0–p3 加空格就设优先级，大小写都行；只认开头，正文里出现的 p1 不算
export function parseTodoPriority(input: string): { text: string; priority: TodoPriority | null } {
  const match = /^\s*[pP]([0-3])\s+(\S[\s\S]*)$/.exec(input)
  return match ? { text: match[2]!, priority: Number(match[1]) as TodoPriority } : { text: input, priority: null }
}
