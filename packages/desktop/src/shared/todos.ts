// 待办：侧栏「待办」页记的点子。project 是记下时所在的项目，无项目为 null；
// sentTo 是最近一次派给哪个任务（发送或填入输入框），没派过为 null
export interface Todo {
  id: string
  text: string
  project: string | null
  // 自定义标签；旧数据没有这个字段，读出来时补成空数组
  tags: string[]
  createdAt: string
  done: boolean
  sentTo: { sessionId: string; title: string; at: string } | null
  // 定了时间的待办；旧数据没有这个字段
  schedule?: TodoSchedule | null
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

export const TODO_MAX_ITEMS = 1000
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
