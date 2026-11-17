import type { ModelMessage } from 'ai'
import { z } from 'zod'
import { COLLABORATION_ROLES, type CollaborationState, type CollaborationTask, type CollaborationView } from '../collaboration-types.js'

const LEAD = 'lead'
const MAX_ACTIVE_TASKS = 256
const MAX_SUBJECT_LENGTH = 200
const MAX_DESCRIPTION_LENGTH = 20_000
const MAX_SCOPES = 50
const MAX_SCOPE_LENGTH = 1024
const MAX_ID_LENGTH = 128

const idSchema = z.string().trim().min(1).max(MAX_ID_LENGTH)
const subjectSchema = z.string().trim().min(1).max(MAX_SUBJECT_LENGTH)
const descriptionSchema = z.string().max(MAX_DESCRIPTION_LENGTH)
const revisionSchema = z.number().int().positive()
const countSchema = z.number().int().nonnegative()
const dependenciesSchema = z.array(idSchema).max(MAX_ACTIVE_TASKS)

function scopeKey(scope: string): string {
  return process.platform === 'win32' ? scope.toLowerCase() : scope
}

function normalizeScope(input: string): string | null {
  const path = input.trim().replace(/\\/g, '/')
  if (!path || path.startsWith('/') || /[\x00-\x1f\x7f:*?"<>|]/.test(path)) return null
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else {
      if (/[. ]$/.test(part)) return null
      parts.push(part)
    }
  }
  if (parts.length === 0) return null
  return parts.join('/')
}

const scopeSchema = z.string().max(MAX_SCOPE_LENGTH).transform((input, context) => {
  const normalized = normalizeScope(input)
  if (normalized !== null) return normalized
  context.addIssue({ code: 'custom', message: '写入范围必须是项目内的相对文件或目录，不能包含上级路径、通配符或无效字符' })
  return z.NEVER
})
const scopesSchema = z.array(scopeSchema).max(MAX_SCOPES).transform((scopes) => {
  const seen = new Set<string>()
  return scopes.filter((scope) => {
    const key = scopeKey(scope)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
})

const taskSchema = z.object({
  id: idSchema,
  revision: revisionSchema,
  subject: subjectSchema,
  description: descriptionSchema,
  status: z.enum(['pending', 'in_progress', 'completed', 'deleted']),
  owner: idSchema.nullable(),
  blockedBy: dependenciesSchema,
  writeScopes: scopesSchema,
}) satisfies z.ZodType<CollaborationTask>

// AI SDK 负责消息内容结构；这里只校验外层，保留工具调用、providerOptions 等原始内容。
const modelMessageSchema = z.custom<ModelMessage>((value) =>
  typeof value === 'object' && value !== null && 'role' in value &&
  typeof value.role === 'string' && ['system', 'user', 'assistant', 'tool'].includes(value.role) && 'content' in value &&
  (typeof value.content === 'string' || Array.isArray(value.content)),
)

export const collaborationStateSchema = z.object({
  version: z.literal(1),
  requiresAcceptance: z.boolean().optional(),
  workers: z.array(z.object({
    id: idSchema,
    name: z.string(),
    color: z.string(),
    task: z.string(),
    role: z.enum(COLLABORATION_ROLES),
    typeName: z.string().nullable(),
    readOnly: z.boolean(),
    context: z.enum(['fresh', 'fork']),
    files: z.array(z.string()),
    nodes: z.array(z.string()),
    cardId: z.string(),
    turnId: z.string(),
    status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']),
    activation: countSchema,
    messages: z.array(modelMessageSchema),
    compaction: z.object({ upTo: z.number().int().nonnegative(), summary: z.string() }).nullable().optional(),
    summary: z.string().nullable(),
    issues: z.string().nullable(),
    verdict: z.enum(['passed', 'changes_required', 'blocked']).nullable(),
    checks: z.array(z.object({ command: z.string(), succeeded: z.boolean(), workdir: z.string().optional() })),
    startedAt: z.number().nonnegative().nullable(),
    endedAt: z.number().nonnegative().nullable(),
    tokens: countSchema,
    edited: z.array(z.string()),
    worktree: z.object({
      repoRoot: z.string(),
      dir: z.string(),
      cwd: z.string(),
      links: z.array(z.string()),
      baseTree: z.string(),
      integratedTree: z.string().nullable(),
      currentTree: z.string().optional(),
    }).nullable(),
    resultRevision: countSchema,
    notifiedRevision: countSchema,
  })),
  messages: z.array(z.object({
    id: idSchema,
    sender: idSchema,
    recipient: idSchema,
    content: z.string(),
    createdAt: z.iso.datetime(),
    status: z.enum(['pending', 'delivered']),
  })),
  tasks: z.array(taskSchema),
  nextTaskNumber: revisionSchema,
  acceptance: z.object({
    status: z.enum(['pending', 'reviewing', 'testing', 'passed', 'blocked']),
    fingerprint: z.string().nullable(),
    reviewerId: idSchema.nullable(),
    testerId: idSchema.nullable(),
    reason: z.string().nullable(),
  }),
}).superRefine((state, context) => {
  const problem = stateProblem(state)
  if (problem) context.addIssue({ code: 'custom', message: problem })
}) satisfies z.ZodType<CollaborationState>

const createInputSchema = z.strictObject({
  subject: subjectSchema,
  description: descriptionSchema,
  blockedBy: dependenciesSchema.optional(),
  writeScopes: scopesSchema.optional(),
})

const updateBase = { taskId: idSchema, expectedRevision: revisionSchema }
const updateInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...updateBase, action: z.literal('claim') }),
  z.strictObject({ ...updateBase, action: z.literal('release') }),
  z.strictObject({
    ...updateBase,
    action: z.literal('edit'),
    subject: subjectSchema.optional(),
    description: descriptionSchema.optional(),
    writeScopes: scopesSchema.optional(),
  }).refine((input) => input.subject !== undefined || input.description !== undefined || input.writeScopes !== undefined, { message: '编辑至少需要一个字段' }),
  z.strictObject({ ...updateBase, action: z.literal('set_dependencies'), blockedBy: dependenciesSchema }),
  z.strictObject({ ...updateBase, action: z.literal('complete') }),
  z.strictObject({ ...updateBase, action: z.literal('reopen') }),
  z.strictObject({ ...updateBase, action: z.literal('reassign'), owner: idSchema }),
  z.strictObject({ ...updateBase, action: z.literal('delete') }),
])

export function newCollaborationState(): CollaborationState {
  return {
    version: 1,
    workers: [],
    messages: [],
    tasks: [],
    nextTaskNumber: 1,
    acceptance: { status: 'pending', fingerprint: null, reviewerId: null, testerId: null, reason: null },
  }
}

function dependenciesReady(state: CollaborationState, task: CollaborationTask): boolean {
  return task.blockedBy.every((id) => state.tasks.some((other) => other.id === id && other.status === 'completed'))
}

function scopesOverlap(first: string, second: string): boolean {
  const left = scopeKey(first)
  const right = scopeKey(second)
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

export function taskViews(state: CollaborationState): CollaborationView['tasks'] {
  return state.tasks.filter((task) => task.status !== 'deleted').map((task) => ({
    ...task,
    blockedBy: [...task.blockedBy],
    writeScopes: [...task.writeScopes],
    ready: task.status === 'pending' && dependenciesReady(state, task),
    writeScopeWarnings: state.tasks.filter((other) =>
      other.id !== task.id && other.status === 'in_progress' &&
      task.writeScopes.some((scope) => other.writeScopes.some((candidate) => scopesOverlap(scope, candidate))),
    ).map((other) => `写入范围与进行中的任务 ${other.id}（${other.subject}）重叠，请先协调。`),
  }))
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  throw new Error(`共享任务参数无效：${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；')}`)
}

function requireMember(state: CollaborationState, caller: string): void {
  if (caller !== LEAD && !state.workers.some((worker) => worker.id === caller)) throw new Error(`团队成员不存在：${caller}`)
}

function dependencyProblem(tasks: CollaborationTask[]): string | null {
  const live = new Map(tasks.filter((task) => task.status !== 'deleted').map((task) => [task.id, task]))
  for (const task of live.values()) {
    if (new Set(task.blockedBy).size !== task.blockedBy.length) return `任务 ${task.id} 的依赖重复`
    for (const id of task.blockedBy) {
      if (id === task.id) return `任务 ${task.id} 不能依赖自身`
      if (!live.has(id)) return `依赖任务不存在或已删除：${id}`
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const hasCycle = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    for (const dependency of live.get(id)?.blockedBy ?? []) if (hasCycle(dependency)) return true
    visiting.delete(id)
    visited.add(id)
    return false
  }
  return [...live.keys()].some(hasCycle) ? '任务依赖不能形成环' : null
}

function stateProblem(state: CollaborationState): string | null {
  const workerIds = new Set(state.workers.map((worker) => worker.id))
  if (workerIds.has(LEAD) || workerIds.size !== state.workers.length) return '工人 id 重复或使用了保留名称 lead'
  if (new Set(state.tasks.map((task) => task.id)).size !== state.tasks.length) return '任务 id 重复'
  if (new Set(state.messages.map((message) => message.id)).size !== state.messages.length) return '团队消息 id 重复'
  if (state.tasks.filter((task) => task.status !== 'deleted').length > MAX_ACTIVE_TASKS) return `未删除的任务不能超过 ${MAX_ACTIVE_TASKS} 个`
  for (const task of state.tasks) {
    if (task.owner !== null && task.owner !== LEAD && !workerIds.has(task.owner)) return `任务负责人不存在：${task.owner}`
    if (task.status === 'in_progress' && task.owner === null) return '进行中的任务必须有负责人'
    const number = /^task-([1-9]\d*)$/.exec(task.id)?.[1]
    if (number && Number(number) >= state.nextTaskNumber) return '任务计数器必须大于所有已有任务编号'
  }
  return dependencyProblem(state.tasks)
}

export function createTeamTask(state: CollaborationState, caller: string, input: unknown): CollaborationTask {
  const parsed = parseInput(createInputSchema, input)
  requireMember(state, caller)
  if (state.tasks.filter((task) => task.status !== 'deleted').length >= MAX_ACTIVE_TASKS) throw new Error(`未删除的任务不能超过 ${MAX_ACTIVE_TASKS} 个`)
  if (!Number.isSafeInteger(state.nextTaskNumber) || state.nextTaskNumber < 1 || state.nextTaskNumber >= Number.MAX_SAFE_INTEGER) throw new Error('任务编号已超出安全范围')
  const id = `task-${state.nextTaskNumber}`
  if (state.tasks.some((task) => task.id === id)) throw new Error(`任务编号已存在：${id}`)
  const task: CollaborationTask = {
    id,
    revision: 1,
    subject: parsed.subject,
    description: parsed.description,
    status: 'pending',
    owner: null,
    blockedBy: parsed.blockedBy ?? [],
    writeScopes: parsed.writeScopes ?? [],
  }
  const problem = dependencyProblem([...state.tasks, task])
  if (problem) throw new Error(problem)
  state.tasks.push(task)
  state.nextTaskNumber += 1
  return task
}

export function updateTeamTask(state: CollaborationState, caller: string, input: unknown): CollaborationTask {
  const parsed = parseInput(updateInputSchema, input)
  requireMember(state, caller)
  const task = state.tasks.find((candidate) => candidate.id === parsed.taskId)
  if (!task || task.status === 'deleted') throw new Error(`任务不存在或已删除：${parsed.taskId}`)
  if (task.revision !== parsed.expectedRevision) throw new Error(`任务修订号冲突：期望 ${parsed.expectedRevision}，当前 ${task.revision}，请刷新后重试`)
  if (task.revision >= Number.MAX_SAFE_INTEGER) throw new Error('任务修订号已超出安全范围')
  if (caller !== LEAD && task.owner !== caller && !(parsed.action === 'claim' && task.owner === null)) throw new Error('只能修改自己负责的任务')
  const next = { ...task }
  switch (parsed.action) {
    case 'claim':
      if (task.status !== 'pending' || (task.owner !== null && task.owner !== caller)) throw new Error('只能认领未归属或分配给自己的待办任务')
      if (!dependenciesReady(state, task)) throw new Error('依赖尚未完成，任务未就绪')
      next.owner = caller
      next.status = 'in_progress'
      break
    case 'release':
      if (task.owner === null || task.status === 'completed') throw new Error('只能释放已归属且未完成的任务')
      next.owner = null
      next.status = 'pending'
      break
    case 'edit':
      if (parsed.subject !== undefined) next.subject = parsed.subject
      if (parsed.description !== undefined) next.description = parsed.description
      if (parsed.writeScopes !== undefined) next.writeScopes = parsed.writeScopes
      break
    case 'set_dependencies':
      next.blockedBy = parsed.blockedBy
      break
    case 'complete':
      if (task.status !== 'in_progress') throw new Error('只有进行中的任务可以完成')
      if (!dependenciesReady(state, task)) throw new Error('依赖尚未完成，不能完成任务')
      next.status = 'completed'
      break
    case 'reopen':
      if (task.status !== 'completed') throw new Error('只有已完成的任务可以重新打开')
      next.status = 'pending'
      break
    case 'reassign':
      if (caller !== LEAD) throw new Error('只有主智能体可以重新分配任务')
      requireMember(state, parsed.owner)
      next.owner = parsed.owner
      if (task.status !== 'completed') next.status = 'pending'
      break
    case 'delete':
      next.status = 'deleted'
      break
  }
  const problem = dependencyProblem(state.tasks.map((candidate) => candidate.id === task.id ? next : candidate))
  if (problem) throw new Error(problem)
  next.revision += 1
  Object.assign(task, next)
  return task
}

export function recoverCollaborationState(state: CollaborationState): boolean {
  let changed = false
  for (const worker of state.workers) {
    if (worker.status !== 'running' && worker.status !== 'queued') continue
    worker.status = 'interrupted'
    changed = true
  }
  return changed
}
