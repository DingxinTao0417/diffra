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
  // 最近一次改动的时间（v2，局域网同步按它决定谁新）；旧数据没有，按 createdAt 算
  updatedAt?: string
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
  // 重复（v2）：到点处理完就挪到下一次（result 清空），这一次怎么处理的记在 last；旧版读到会丢掉这两项，待办停在下一次
  repeat?: TodoRepeat | null
  // done 是用户把这一次勾掉了
  last?: { kind: 'reminded' | 'sent' | 'missed' | 'failed' | 'done'; at: string; error?: string } | null
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
      // 嵌套标签按 / 分层：每层去掉首尾空白，空的层去掉
      const tag = part
        .trim()
        .replace(/^#+/, '')
        .split('/')
        .map((segment) => segment.trim())
        .filter(Boolean)
        .join('/')
        .slice(0, TODO_MAX_TAG_LENGTH)
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

// 重复（v2 · M8）：每天、每个工作日、每周、每月，可以隔几个周期；按本机时区算（钟点不变，跨夏令时也一样），
// 从第一次的时刻（start）往后数，按月重复时 31 号在小月落到月底、下个月回到 31 号，不越漂越早
export const TODO_REPEAT_KINDS = ['day', 'weekday', 'week', 'month'] as const
export type TodoRepeatKind = (typeof TODO_REPEAT_KINDS)[number]
export const TODO_REPEAT_LABELS: Record<TodoRepeatKind, string> = { day: '每天', weekday: '每个工作日', week: '每周', month: '每月' }

export interface TodoRepeat {
  every: TodoRepeatKind
  // 隔几个周期，1 是每个周期；工作日不用
  interval: number
  // 第一次的时刻（UTC ISO），后面的都从它算
  start: string
}

function occurrence(start: Date, repeat: TodoRepeat, index: number): Date {
  const next = new Date(start)
  if (repeat.every === 'day') next.setDate(start.getDate() + index * repeat.interval)
  else if (repeat.every === 'week') next.setDate(start.getDate() + index * 7 * repeat.interval)
  else if (repeat.every === 'month') {
    const day = start.getDate()
    next.setDate(1)
    next.setMonth(start.getMonth() + index * repeat.interval)
    const last = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()
    next.setDate(Math.min(day, last))
  }
  return next
}

// 晚于 after 的下一次（UTC ISO）。工作日：往后一天一天找，跳过周六周日
export function nextOccurrence(repeat: TodoRepeat, after: number): string {
  const start = new Date(repeat.start)
  if (repeat.every === 'weekday') {
    const next = new Date(start)
    while (next.getTime() <= after || next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1)
    return next.toISOString()
  }
  // 先按平均周期估一个起点，再往后数，不用从第一次一个个试
  const days = repeat.every === 'day' ? 1 : repeat.every === 'week' ? 7 : 30
  let index = Math.max(1, Math.floor((after - start.getTime()) / (days * repeat.interval * 86_400_000)) - 1)
  while (occurrence(start, repeat, index).getTime() <= after) index++
  return occurrence(start, repeat, index).toISOString()
}

// 重复的待办这一次处理完（到点提醒、发送、错过，或者用户勾掉）：挪到下一次，不标完成
export function advanceRepeat(todo: Todo, last: NonNullable<TodoSchedule['last']>, now: number): Todo {
  const schedule = todo.schedule
  if (!schedule?.repeat) return todo
  const at = nextOccurrence(schedule.repeat, Math.max(now, Date.parse(schedule.at)))
  return { ...todo, schedule: { ...schedule, at, result: null, last } }
}

export function repeatLabel(repeat: TodoRepeat): string {
  if (repeat.every === 'weekday' || repeat.interval === 1) return TODO_REPEAT_LABELS[repeat.every]
  return { day: `每 ${repeat.interval} 天`, week: `每 ${repeat.interval} 周`, month: `每 ${repeat.interval} 个月` }[repeat.every]
}

// 嵌套标签（v2 · M8）：「工作/项目A」写成一个标签，用 / 分层；按上一层筛选时下面各层都算
export function tagMatches(tag: string, filter: string): boolean {
  const lower = tag.toLowerCase()
  const parent = filter.toLowerCase()
  return lower === parent || lower.startsWith(`${parent}/`)
}

// 标签树：每个标签和它的各层上级（「工作/项目A」也列出「工作」），按层排好，depth 是第几层
export function tagTree(tags: readonly string[]): Array<{ tag: string; label: string; depth: number }> {
  const all = new Map<string, string>()
  for (const tag of tags) {
    const parts = tag.split('/')
    for (let index = 1; index <= parts.length; index++) {
      const path = parts.slice(0, index).join('/')
      if (!all.has(path.toLowerCase())) all.set(path.toLowerCase(), path)
    }
  }
  return [...all.values()]
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase(), 'zh-CN'))
    .map((tag) => ({ tag, label: tag.split('/').at(-1)!, depth: tag.split('/').length - 1 }))
}

// 局域网同步（v2 · M8）：两台电脑的待办合在一起。同一条取改得晚的（updatedAt，旧数据按 createdAt），
// 删掉的记墓碑（id 和删的时间），墓碑晚于那一条最后一次改动就删掉。墓碑留 90 天、最多 2000 条
export interface TodoTombstone {
  id: string
  at: string
}

const TOMBSTONE_KEEP_MS = 90 * 24 * 3600_000
const MAX_TOMBSTONES = 2000

export const todoStamp = (todo: Pick<Todo, 'updatedAt' | 'createdAt'>) => Date.parse(todo.updatedAt ?? todo.createdAt)

// 先出现的那份为准（a 在前）：一样新时留 a 的；顺序按 a、再接 b 里新的
export function mergeTodoLists(a: readonly Todo[], b: readonly Todo[], tombstones: readonly TodoTombstone[]): Todo[] {
  const deleted = new Map(tombstones.map((item) => [item.id, Date.parse(item.at)]))
  const chosen = new Map<string, Todo>()
  for (const todo of [...a, ...b]) {
    const existing = chosen.get(todo.id)
    if (!existing || todoStamp(todo) > todoStamp(existing)) chosen.set(todo.id, todo)
  }
  const order = [...new Set([...a.map((todo) => todo.id), ...b.map((todo) => todo.id)])]
  return order.flatMap((id) => {
    const todo = chosen.get(id)!
    const gone = deleted.get(id)
    return gone !== undefined && gone >= todoStamp(todo) ? [] : [todo]
  })
}

export function mergeTombstones(a: readonly TodoTombstone[], b: readonly TodoTombstone[], now: number): TodoTombstone[] {
  const latest = new Map<string, TodoTombstone>()
  for (const item of [...a, ...b]) {
    const existing = latest.get(item.id)
    if (!existing || Date.parse(item.at) > Date.parse(existing.at)) latest.set(item.id, item)
  }
  return [...latest.values()]
    .filter((item) => now - Date.parse(item.at) <= TOMBSTONE_KEEP_MS)
    .sort((x, y) => Date.parse(y.at) - Date.parse(x.at))
    .slice(0, MAX_TOMBSTONES)
}

// 同步哪些：定时发给任务的不同步（任务只在这台电脑上，到另一台去发会发错地方）
export function syncableTodo(todo: Pick<Todo, 'schedule'>): boolean {
  return todo.schedule?.action.kind !== 'send'
}
