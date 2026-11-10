import { AGENT_META_KEY, type AgentCardMeta, type AgentTag, type Diagnosis, DIAGNOSIS_META_KEY, MODEL_SILENCE_META_KEY, type ModelErrorKind, PARENT_TOOL_CALL_META_KEY, TASK_PROGRESS_META_KEY, type TaskProgressView, TURN_OUTCOME_META_KEY, type TurnOutcome, type TurnStop } from '@diffra/core/types'
import type { CheckResult, FinishVerification, PromptImage, SessionUpdate, StopReason, StoredTurn, ToolCallContent, ToolCallStatus, ToolKind, TurnKind, UsageBreakdown } from '@diffra/core/types'

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
      // 检查命令、静态检查、轻量扫描、规范审查卡带：检查结论。旧记录没有
      result?: CheckResult
      // 完成卡和 verify_changes 卡带：这次完成的验证方式。旧记录没有
      verification?: FinishVerification
      // 收到开始的时刻，运行中的行据此显示已用时间。重放历史记录时不带，免得没跑完的旧调用从打开时开始计时
      startedAt?: number
      // 子智能体的卡片（主智能体的那次 delegate 调用）：名字、颜色、任务和认领的文件
      agentCard?: AgentCardMeta
      // 子智能体自己的工具调用：收进 parentId 那张卡片里，agent 是哪个工人
      parentId?: string
      agent?: AgentTag
      // 定位轮交回的「定位结果」卡
      diagnosis?: Diagnosis
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
  // core 在一轮结束时给的结论；plan、deep-scan、compact 轮和旧记录没有
  outcome?: TurnOutcome
  // 撤销到这一轮或更早的轮次之前的时刻。只说明之后撤销过，不代表这一轮的改动现在不在
  restoredAt?: number | null
  // 模型从什么时候起没有输出，按智能体分开记（key 是子智能体 id，主智能体是 main）。
  // 又有输出就去掉；被停止时 core 不撤，留着说明停下时模型已经多久没输出
  silence: Record<string, { agent: string | null; since: number }>
}

export interface Usage {
  used: number
  size: number
  breakdown: UsageBreakdown | null
  // 最近一次模型调用返回的缓存用量；旧记录和供应商没返回时为 null
  cacheRead: number | null
  cacheWrite: number | null
  // 那次调用的输入 token 数；压缩后 used 变小，缓存命中率仍按它算
  cacheInput: number
}

export function newTurn(id: string, prompt: string, kind: TurnKind = 'prompt', skills: string[] = [], images: PromptImage[] = []): Turn {
  return { id, kind, prompt, skills, images, items: [{ kind: 'user', id: `${id}-user`, text: prompt }], stopReason: null, error: null, startedAt: Date.now(), endedAt: null, silence: {} }
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
    restoredAt: turn.restoredAt ? Date.parse(turn.restoredAt) || null : null,
    outcome: turn.updates.map(turnOutcomeOf).filter((item) => item !== null).at(-1),
    silence: turn.updates.reduce((silence, update) => {
      const change = modelSilenceOf(update)
      return change ? applySilence(silence, change) : silence
    }, {} as Turn['silence']),
  }
}

// 某个智能体又有输出了就去掉它那一条，开始没输出就记下从什么时候起
export function applySilence(silence: Turn['silence'], { key, agent, since }: { key: string; agent: string | null; since: number | null }): Turn['silence'] {
  const { [key]: _previous, ...rest } = silence
  return since === null ? rest : { ...rest, [key]: { agent, since } }
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
  const needsVerification = 'needsVerification' in progress ? progress.needsVerification : undefined
  if (needsVerification !== undefined && typeof needsVerification !== 'boolean') return null
  return { status, reason, requirements: validated, needsVerification }
}

const FINISH_OUTCOMES = ['verified', 'unverified', 'no-edits'] as const satisfies readonly NonNullable<TurnOutcome['finish']>[]
const TURN_STOPS = ['paused', 'cancelled', 'no-finish', 'gate-exhausted', 'check-exhausted', 'stuck', 'model-error', 'step-limit', 'context-limit', 'goal-exhausted'] as const satisfies readonly TurnStop[]
const MODEL_ERROR_KINDS = ['auth', 'not-found', 'unsupported', 'rate-limit', 'server', 'timeout', 'network', 'unknown'] as const satisfies readonly ModelErrorKind[]
const CHECK_RESULTS = ['passed', 'warned', 'partial', 'error', 'failed'] as const satisfies readonly CheckResult[]
const FINISH_VERIFICATIONS = ['verified', 'reused', 'unverified', 'no-edits', 'failed'] as const satisfies readonly FinishVerification[]

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return (values as readonly unknown[]).includes(value)
}

export function turnOutcomeOf(update: SessionUpdate): TurnOutcome | null {
  const meta: unknown = update._meta
  if (typeof meta !== 'object' || meta === null || !('diffra' in meta)) return null
  const diffra = meta.diffra
  if (typeof diffra !== 'object' || diffra === null || !(TURN_OUTCOME_META_KEY in diffra)) return null
  const outcome = diffra[TURN_OUTCOME_META_KEY]
  if (typeof outcome !== 'object' || outcome === null || !('finish' in outcome) || !('stop' in outcome)) return null
  const { finish, stop } = outcome
  if (finish !== null && !oneOf(FINISH_OUTCOMES, finish)) return null
  if (stop !== null && !oneOf(TURN_STOPS, stop)) return null
  const errorKind = 'errorKind' in outcome && oneOf(MODEL_ERROR_KINDS, outcome.errorKind) ? outcome.errorKind : undefined
  return errorKind ? { finish, stop, errorKind } : { finish, stop }
}

// 模型没有输出的提示：key 是子智能体 id，主智能体是 main；since 为 null 是又有输出了
export function modelSilenceOf(update: SessionUpdate): { key: string; agent: string | null; since: number | null } | null {
  if (update.sessionUpdate !== 'session_info_update') return null
  const diffra = diffraMetaOf(update)
  if (!diffra || !(MODEL_SILENCE_META_KEY in diffra)) return null
  const value = diffra[MODEL_SILENCE_META_KEY]
  const since = typeof value === 'string' ? Date.parse(value) : null
  if (value !== null && (since === null || Number.isNaN(since))) return null
  const agent = agentTagFrom(diffra[AGENT_META_KEY])
  return { key: agent?.id ?? 'main', agent: agent?.name ?? null, since }
}

function diffraFlagOf(update: SessionUpdate, key: 'commandSucceeded' | 'unverified'): boolean | undefined {
  const meta: unknown = update._meta
  if (typeof meta !== 'object' || meta === null || !('diffra' in meta)) return undefined
  const diffra = meta.diffra
  if (typeof diffra !== 'object' || diffra === null) return undefined
  const value: unknown = (diffra as Record<string, unknown>)[key]
  return typeof value === 'boolean' ? value : undefined
}

function diffraChoiceOf<T extends string>(update: SessionUpdate, key: 'result' | 'verification', values: readonly T[]): T | undefined {
  const meta: unknown = update._meta
  if (typeof meta !== 'object' || meta === null || !('diffra' in meta)) return undefined
  const diffra = meta.diffra
  if (typeof diffra !== 'object' || diffra === null) return undefined
  const value: unknown = (diffra as Record<string, unknown>)[key]
  return oneOf(values, value) ? value : undefined
}

function diffraMetaOf(update: SessionUpdate): Record<string, unknown> | null {
  const meta: unknown = update._meta
  if (typeof meta !== 'object' || meta === null || !('diffra' in meta)) return null
  const diffra = meta.diffra
  return typeof diffra === 'object' && diffra !== null ? (diffra as Record<string, unknown>) : null
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function agentTagFrom(value: unknown): AgentTag | null {
  if (typeof value !== 'object' || value === null) return null
  const { id, name, color } = value as Record<string, unknown>
  return typeof id === 'string' && typeof name === 'string' && typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color) ? { id, name, color } : null
}

// 权限请求等带的 _meta：是哪个子智能体发起的；主智能体自己的没有
export function agentOfMeta(meta: unknown): AgentTag | null {
  if (typeof meta !== 'object' || meta === null || !('diffra' in meta)) return null
  const diffra = meta.diffra
  return typeof diffra === 'object' && diffra !== null ? agentTagFrom((diffra as Record<string, unknown>)[AGENT_META_KEY]) : null
}

// 定位结果：core 交的结构化内容，字段不全时当普通卡片显示
function diagnosisOf(update: SessionUpdate): { diagnosis?: Diagnosis } {
  const value = diffraMetaOf(update)?.[DIAGNOSIS_META_KEY] as Partial<Diagnosis> | undefined
  if (!value || typeof value.cause !== 'string' || typeof value.prompt !== 'string' || !value.target || !Array.isArray(value.evidence) || !Array.isArray(value.questions)) return {}
  return { diagnosis: { done: [], remaining: [], fallback: false, ...value } as Diagnosis }
}

// 卡片带完整的子智能体信息，工人自己的工具调用带所属卡片和工人
function agentFieldsOf(update: SessionUpdate): { agentCard?: AgentCardMeta; parentId?: string; agent?: AgentTag } {
  const diffra = diffraMetaOf(update)
  if (!diffra) return {}
  const tag = agentTagFrom(diffra[AGENT_META_KEY])
  const parentId = diffra[PARENT_TOOL_CALL_META_KEY]
  if (typeof parentId === 'string') return tag ? { parentId, agent: tag } : { parentId }
  const raw = diffra[AGENT_META_KEY] as Record<string, unknown> | undefined
  if (!tag || !raw || typeof raw.task !== 'string' || !isStrings(raw.files) || !isStrings(raw.nodes)) return {}
  return { agentCard: { ...tag, task: raw.task, files: raw.files, nodes: raw.nodes } }
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

export function usageOf(update: SessionUpdate): Usage | null {
  if (update.sessionUpdate !== 'usage_update') return null
  const meta = update._meta as
    | {
        cache?: { read?: unknown; write?: unknown; input?: unknown }
        diffra?: UsageBreakdown & {
          // 兼容还没发布过的嵌套和扁平写法
          cache?: { read?: unknown; write?: unknown; input?: unknown }
          cacheRead?: unknown
          cacheWrite?: unknown
          cacheInput?: unknown
        }
      }
    | null
    | undefined
  const raw = meta?.diffra
  const cache = meta?.cache ?? raw?.cache
  return {
    used: update.used,
    size: update.size,
    breakdown: raw ? { system: raw.system, rules: raw.rules, tools: raw.tools, messages: raw.messages } : null,
    cacheRead: tokenCount(cache?.read) ?? tokenCount(raw?.cacheRead),
    cacheWrite: tokenCount(cache?.write) ?? tokenCount(raw?.cacheWrite),
    cacheInput: tokenCount(cache?.input) ?? tokenCount(raw?.cacheInput) ?? update.used,
  }
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
        result: diffraChoiceOf(update, 'result', CHECK_RESULTS),
        verification: diffraChoiceOf(update, 'verification', FINISH_VERIFICATIONS),
        ...agentFieldsOf(update),
        ...diagnosisOf(update),
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
        result: diffraChoiceOf(update, 'result', CHECK_RESULTS) ?? existing?.result,
        verification: diffraChoiceOf(update, 'verification', FINISH_VERIFICATIONS) ?? existing?.verification,
        startedAt: existing?.startedAt ?? Date.now(),
        ...agentFieldsKept(existing, agentFieldsOf(update)),
        ...(existing?.diagnosis ? { diagnosis: existing.diagnosis } : {}),
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

// 更新里没带的子智能体信息沿用之前的；卡片的认领清单以最新一次为准
function agentFieldsKept(existing: ToolItem | null, next: ReturnType<typeof agentFieldsOf>): ReturnType<typeof agentFieldsOf> {
  const agentCard = next.agentCard ?? existing?.agentCard
  const parentId = next.parentId ?? existing?.parentId
  const agent = next.agent ?? existing?.agent
  return { ...(agentCard ? { agentCard } : {}), ...(parentId ? { parentId } : {}), ...(agent ? { agent } : {}) }
}

function upsertTool(items: TranscriptItem[], id: string, build: (existing: ToolItem | null) => ToolItem): TranscriptItem[] {
  const index = items.findIndex((item) => item.kind === 'tool' && item.id === id)
  if (index < 0) return [...items, build(null)]
  const existing = items[index]
  return items.map((item, position) => (position === index ? build(existing?.kind === 'tool' ? existing : null) : item))
}
