import { z } from 'zod'
import { TASK_PROGRESS_META_KEY } from '../protocol.js'
import { ToolError } from '../tools/types.js'

export { TASK_PROGRESS_META_KEY as TASK_STATE_META_KEY } from '../protocol.js'
export const RELEASE_REQUIREMENT_IDS = ['commit', 'push', 'ci', 'publish'] as const
export const MAX_TASK_REQUIREMENTS = 20
export const MAX_TASK_RECEIPTS = 100
const MAX_EVIDENCE_CHARS = 20_000

export const taskStatusSchema = z.enum(['running', 'waiting', 'blocked', 'cancelled', 'completed'])
const requirementSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(300),
  // 必须在实际执行成功的命令及输出里分别匹配，不能只凭模型填“完成”。
  commandIncludes: z.string().min(1).max(500),
  outputIncludes: z.string().min(1).max(1000),
  receiptId: z.string().nullable().default(null),
})
const receiptSchema = z.object({
  id: z.string(), command: z.string(), output: z.string(), at: z.string(),
})
export const taskStateSchema = z.object({
  status: taskStatusSchema,
  contractRequired: z.boolean().default(false),
  needsVerification: z.boolean().default(false),
  releaseVersion: z.string().nullable().default(null),
  reason: z.string().nullable(),
  requirements: z.array(requirementSchema).max(MAX_TASK_REQUIREMENTS),
  receipts: z.array(receiptSchema).max(MAX_TASK_RECEIPTS),
})
export type TaskState = z.infer<typeof taskStateSchema>
// session/load 响应里的 TaskProgressView，客户端按它校验
export const taskProgressViewSchema = z.object({
  status: taskStatusSchema,
  reason: z.string().nullable(),
  requirements: z.array(z.object({ id: z.string(), title: z.string(), receiptId: z.string().nullable() })),
  needsVerification: z.boolean().optional(),
})
export type TaskRequirement = TaskState['requirements'][number]

export const taskUpdateSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('define'),
    requirements: z.array(requirementSchema.omit({ receiptId: true })).min(1).max(MAX_TASK_REQUIREMENTS),
  }),
  z.object({ action: z.literal('satisfy'), id: z.string(), receiptId: z.string() }),
  z.object({ action: z.literal('status') }),
])
export const pauseTaskSchema = z.object({
  status: z.enum(['waiting', 'blocked']), reason: z.string().trim().min(1).max(2000),
})

export function newTaskState(): TaskState {
  return { status: 'running', contractRequired: false, needsVerification: false, releaseVersion: null, reason: null, requirements: [], receipts: [] }
}

export function releaseEvidenceProblem(state: TaskState): string | null {
  if (!state.contractRequired) return null
  const evidenceFor = (id: string) => state.receipts.find((receipt) => receipt.id === state.requirements.find((item) => item.id === id)?.receiptId)
  const commit = evidenceFor('commit')
  const sha = commit?.output.match(/\b[a-f0-9]{40}\b/i)?.[0]
  if (!sha) return 'Commit evidence must contain the actual full 40-character SHA.'
  if (!evidenceFor('push')?.output.includes(sha)) return 'Remote branch evidence must contain the same commit SHA.'
  const ci = evidenceFor('ci')
  if (!ci?.output.includes(sha) || !/"conclusion"\s*:\s*"success"/.test(ci.output) || !/"status"\s*:\s*"completed"/.test(ci.output)) {
    return 'CI evidence must include headSha, status completed and conclusion success from gh run view --json.'
  }
  const published = evidenceFor('publish')
  if (!published || !/publish:release|scripts\/publish-release\.ts/.test(published.command) || !/已发布 \d+\.\d+\.\d+/.test(published.output)) {
    return 'Publication evidence must come from the successful publish:release script, which validates online latest.yml and installer size/hash before reporting 已发布.'
  }
  if (state.releaseVersion && !published.output.includes(`已发布 ${state.releaseVersion}`)) return 'Published version does not match the requested release version.'
  return null
}

export function pendingRequirements(state: TaskState): TaskRequirement[] {
  return state.requirements.filter((requirement) => !requirement.receiptId)
}

export function updateTask(state: TaskState, raw: unknown): TaskState {
  const input = taskUpdateSchema.parse(raw)
  if (input.action === 'status') return state
  if (input.action === 'define') {
    if (state.requirements.length > 0) throw new ToolError('Completion requirements already exist. They cannot be removed or weakened; continue satisfying them.')
    if (new Set(input.requirements.map((item) => item.id)).size !== input.requirements.length) throw new ToolError('Requirement ids must be unique.')
    if (state.contractRequired && !RELEASE_REQUIREMENT_IDS.every((id) => input.requirements.some((item) => item.id === id))) {
      throw new ToolError('Release contract must include commit, push, ci, publish requirements with concrete commands and expected version/SHA/output.')
    }
    if (state.contractRequired) {
      const expectedCommands: Record<string, RegExp> = { commit: /^git (?:rev-parse|log|show)\b/, push: /^git ls-remote\b/, ci: /^gh (?:run view|release view)\b/, publish: /^(?:curl|wget|node|pnpm)\b/ }
      for (const requirement of input.requirements) {
        const expected = expectedCommands[requirement.id]
        if (expected && !expected.test(requirement.commandIncludes)) throw new ToolError(`Release requirement ${requirement.id} must use a real Git/CI/update-source query, not a synthetic success message.`)
      }
    }
    return { ...state, status: 'running', reason: null, requirements: input.requirements.map((item) => ({ ...item, receiptId: null })) }
  }
  const requirement = state.requirements.find((item) => item.id === input.id)
  if (!requirement) throw new ToolError('Unknown completion requirement.')
  const receipt = state.receipts.find((item) => item.id === input.receiptId)
  if (!receipt || !receipt.command.includes(requirement.commandIncludes) || !receipt.output.includes(requirement.outputIncludes)) {
    throw new ToolError('Evidence must reference a successful run_command receipt matching BOTH the required command and expected output. Model assertions are not evidence.')
  }
  return { ...state, requirements: state.requirements.map((item) => item.id === input.id ? { ...item, receiptId: receipt.id } : item) }
}

export function recordTaskReceipt(state: TaskState, id: string, command: string, output: string): TaskState {
  const pinned = new Set(state.requirements.map((item) => item.receiptId))
  const receipts = [...state.receipts.filter((item) => item.id !== id), { id, command, output: output.slice(0, MAX_EVIDENCE_CHARS), at: new Date().toISOString() }]
  while (receipts.length > MAX_TASK_RECEIPTS) {
    const removable = receipts.findIndex((item) => !pinned.has(item.id))
    if (removable < 0) break
    receipts.splice(removable, 1)
  }
  return { ...state, receipts }
}

// 发布任务即使模型忘记建立清单，也不能把测试通过当成发布成功。
export function requiresReleaseContract(text: string): boolean {
  return /发布|上线|\brelease\b|\bdeploy\b/i.test(text) && /提交|推送|打包|版本|\bpush\b|\bpackage\b|\bv?\d+\.\d+\.\d+\b/i.test(text)
}

// 记进轮次里的任务状态更新（_meta.diffra.taskState）带的待验证；不是任务状态更新时为 null。旧记录没有这个字段，算 false
const recordedTaskStateSchema = z.object({ diffra: z.object({ [TASK_PROGRESS_META_KEY]: z.object({ needsVerification: z.boolean().optional() }) }) })

export function recordedNeedsVerification(meta: unknown): boolean | null {
  const parsed = recordedTaskStateSchema.safeParse(meta)
  return parsed.success ? (parsed.data.diffra[TASK_PROGRESS_META_KEY].needsVerification ?? false) : null
}
