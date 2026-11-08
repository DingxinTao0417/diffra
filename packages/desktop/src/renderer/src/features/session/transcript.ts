import { TASK_PROGRESS_META_KEY, type TaskProgressView } from '@diffra/core/types'
import type { PromptImage, SessionUpdate, StopReason, StoredTurn, ToolCallContent, ToolCallStatus, ToolKind, TurnKind, UsageBreakdown } from '@diffra/core/types'

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'agent'; id: string; text: string }
  | { kind: 'thought'; id: string; text: string }
  | {
      kind: 'tool'
      id: string
      title: string
      toolKind: ToolKind | null
      status: ToolCallStatus
      content: ToolCallContent[]
      // 只有命令带：退出码为 0 且没超时、没取消。旧记录没有这个字段
      succeeded?: boolean
      // 只有完成卡带：没配检查命令，改动未经自动验证。旧记录没有这个字段，那句话还在总结正文里
      unverified?: boolean
      // 收到开始的时刻，运行中的行据此显示已用时间。重放历史记录时不带，免得没跑完的旧调用从打开时开始计时
      startedAt?: number
    }
  | { kind: 'notice'; id: string; severity: string; title: string; description: string | null }

export interface Turn {
  id: string
  kind: TurnKind
  prompt: string
  // 这一轮带上的 Skill
  skills: string[]
  // 提问带的图片
  images: PromptImage[]
  items: TranscriptItem[]
  stopReason: StopReason | null
  error: string | null
  startedAt: number | null
  endedAt: number | null
}

export interface Usage {
  used: number
  size: number
  breakdown: UsageBreakdown | null
}

export function newTurn(id: string, prompt: string, kind: TurnKind = 'prompt', skills: string[] = [], images: PromptImage[] = []): Turn {
  return { id, kind, prompt, skills, images, items: [{ kind: 'user', id: `${id}-user`, text: prompt }], stopReason: null, error: null, startedAt: Date.now(), endedAt: null }
}

// 打开历史任务：按存下来的更新重放出这一轮的记录
export function turnFromStored(turn: StoredTurn): Turn {
  const items = turn.updates
    .reduce(applyUpdate, [{ kind: 'user', id: `${turn.id}-user`, text: turn.prompt }] as TranscriptItem[])
    .map((item) => (item.kind === 'tool' ? { ...item, startedAt: undefined } : item))
  return {
    id: turn.id,
    kind: turn.kind ?? 'prompt',
    prompt: turn.prompt,
    skills: turn.skills ?? [],
    images: turn.images ?? [],
    items,
    // 应用退出时没跑完的一轮记为已停止
    stopReason: turn.stopReason ?? 'cancelled',
    error: null,
    startedAt: Date.parse(turn.startedAt) || null,
    endedAt: turn.endedAt ? Date.parse(turn.endedAt) || null : null,
  }
}

export function taskProgressOf(update: SessionUpdate): TaskProgressView | null {
  const meta: unknown = update._meta
  if (typeof meta !== 'object' || meta === null || !('diffra' in meta)) return null
  const diffra = meta.diffra
  if (typeof diffra !== 'object' || diffra === null || !(TASK_PROGRESS_META_KEY in diffra)) return null
  const progress = diffra[TASK_PROGRESS_META_KEY]
  if (typeof progress !== 'object' || progress === null || !('status' in progress) || !('reason' in progress) || !('requirements' in progress)) return null
  const { status, reason, requirements } = progress
  if (status !== 'running' && status !== 'waiting' && status !== 'blocked' && status !== 'cancelled' && status !== 'completed') return null
  if (reason !== null && typeof reason !== 'string') return null
  if (!Array.isArray(requirements)) return null
  const validated: TaskProgressView['requirements'] = []
  for (const item of requirements) {
    if (typeof item !== 'object' || item === null || typeof item.id !== 'string' || typeof item.title !== 'string' || (item.receiptId !== null && typeof item.receiptId !== 'string')) return null
    validated.push({ id: item.id, title: item.title, receiptId: item.receiptId })
  }
  return { status, reason, requirements: validated }
}

function diffraFlagOf(update: SessionUpdate, key: 'commandSucceeded' | 'unverified'): boolean | undefined {
  const meta: unknown = update._meta
  if (typeof meta !== 'object' || meta === null || !('diffra' in meta)) return undefined
  const diffra = meta.diffra
  if (typeof diffra !== 'object' || diffra === null) return undefined
  const value: unknown = (diffra as Record<string, unknown>)[key]
  return typeof value === 'boolean' ? value : undefined
}

export function usageOf(update: SessionUpdate): Usage | null {
  if (update.sessionUpdate !== 'usage_update') return null
  const meta = update._meta as { diffra?: UsageBreakdown } | null | undefined
  return { used: update.used, size: update.size, breakdown: meta?.diffra ?? null }
}

export function lastUsage(turns: StoredTurn[]): Usage | null {
  for (const turn of [...turns].reverse()) {
    for (const update of [...turn.updates].reverse()) {
      const usage = usageOf(update)
      if (usage) return usage
    }
  }
  return null
}

// 把 core 推来的一条会话更新合进这一轮的记录：连续的文字片段拼在一起，工具调用按 id 更新
export function applyUpdate(items: TranscriptItem[], update: SessionUpdate): TranscriptItem[] {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      const kind = update.sessionUpdate === 'agent_message_chunk' ? 'agent' : 'thought'
      const text = update.content.type === 'text' ? update.content.text : ''
      const last = items.at(-1)
      if (last && last.kind === kind) return [...items.slice(0, -1), { ...last, text: last.text + text }]
      return [...items, { kind, id: crypto.randomUUID(), text }]
    }
    case 'tool_call': {
      const item: TranscriptItem = {
        kind: 'tool',
        id: update.toolCallId,
        title: update.title,
        toolKind: update.kind ?? null,
        status: update.status ?? 'pending',
        content: update.content ?? [],
        succeeded: diffraFlagOf(update, 'commandSucceeded'),
        unverified: diffraFlagOf(update, 'unverified'),
      }
      return upsertTool(items, update.toolCallId, (existing) => ({ ...item, startedAt: existing?.startedAt ?? Date.now() }))
    }
    case 'tool_call_update':
      return upsertTool(items, update.toolCallId, (existing) => ({
        kind: 'tool',
        id: update.toolCallId,
        title: update.title ?? existing?.title ?? update.toolCallId,
        toolKind: update.kind ?? existing?.toolKind ?? null,
        status: update.status ?? existing?.status ?? 'pending',
        content: update.content ?? existing?.content ?? [],
        succeeded: diffraFlagOf(update, 'commandSucceeded') ?? existing?.succeeded,
        unverified: diffraFlagOf(update, 'unverified') ?? existing?.unverified,
        startedAt: existing?.startedAt ?? Date.now(),
      }))
    case 'notice':
      return [
        ...items,
        {
          kind: 'notice',
          id: crypto.randomUUID(),
          severity: update.severity,
          title: update.title,
          description: update.description ?? null,
        },
      ]
    default:
      return items
  }
}

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

function upsertTool(items: TranscriptItem[], id: string, build: (existing: ToolItem | null) => ToolItem): TranscriptItem[] {
  const index = items.findIndex((item) => item.kind === 'tool' && item.id === id)
  if (index < 0) return [...items, build(null)]
  const existing = items[index]
  return items.map((item, position) => (position === index ? build(existing?.kind === 'tool' ? existing : null) : item))
}
