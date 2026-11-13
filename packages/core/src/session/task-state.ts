import { z } from 'zod'
import { TASK_PROGRESS_META_KEY } from '../protocol.js'

export { TASK_PROGRESS_META_KEY as TASK_STATE_META_KEY } from '../protocol.js'

// 任务状态（第 504 步起，参照 Codex）：没有完成条件、证据和发版契约，只剩状态、原因和「有没验证的改动」。
// 一轮结束前改过项目文件就自动过完成门禁（loop.ts 的 runEndGate），不靠模型调 finish、task_progress。
// waiting 只剩「提交前先做深度扫描」用；blocked 是这一轮停下时还有没过门禁的改动。
// 旧会话文件里的 requirements、receipts、contractRequired、releaseVersion 读进来时丢掉（zod 默认去掉多余字段）
export const taskStatusSchema = z.enum(['running', 'waiting', 'blocked', 'cancelled', 'completed'])
export const taskStateSchema = z.object({
  status: taskStatusSchema,
  needsVerification: z.boolean().default(false),
  reason: z.string().nullable(),
})
export type TaskState = z.infer<typeof taskStateSchema>

// session/load 响应和会话更新里的 TaskProgressView，客户端按它校验。requirements 照旧带上（总是空数组）：
// 旧版本的桌面端和远程设备按这个形状校验，少了字段整条状态就不认了
export const taskProgressViewSchema = z.object({
  status: taskStatusSchema,
  reason: z.string().nullable(),
  requirements: z.array(z.object({ id: z.string(), title: z.string(), receiptId: z.string().nullable() })),
  needsVerification: z.boolean().optional(),
})

export function newTaskState(): TaskState {
  return { status: 'running', needsVerification: false, reason: null }
}

// 记进轮次里的任务状态更新（_meta.diffra.taskState）带的待验证；不是任务状态更新时为 null。旧记录没有这个字段，算 false
const recordedTaskStateSchema = z.object({
  diffra: z.object({ [TASK_PROGRESS_META_KEY]: z.object({ needsVerification: z.boolean().optional() }) }),
})

export function recordedTaskState(meta: unknown): { needsVerification: boolean } | null {
  const parsed = recordedTaskStateSchema.safeParse(meta)
  if (!parsed.success) return null
  return { needsVerification: parsed.data.diffra[TASK_PROGRESS_META_KEY].needsVerification ?? false }
}
