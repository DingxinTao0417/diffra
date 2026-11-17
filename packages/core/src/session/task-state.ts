import { z } from 'zod'

export { TASK_PROGRESS_META_KEY as TASK_STATE_META_KEY } from '../protocol.js'

// 任务状态（第 504 步起，参照 Codex）：没有完成条件、证据和发版契约，只剩状态和原因。
// waiting 只剩「提交前先做深度扫描」用；blocked 是这一轮没走完就停了。
// 旧会话文件里的 requirements、receipts、contractRequired、releaseVersion、needsVerification 读进来时丢掉（zod 默认去掉多余字段）
export const taskStatusSchema = z.enum(['running', 'waiting', 'blocked', 'cancelled', 'completed'])
export const taskStateSchema = z.object({
  status: taskStatusSchema,
  reason: z.string().nullable(),
})
export type TaskState = z.infer<typeof taskStateSchema>

// session/load 响应和会话更新里的 TaskProgressView，客户端按它校验。requirements 照旧带上（总是空数组）：
// 旧版本的桌面端和远程设备按这个形状校验，少了字段整条状态就不认了
export const taskProgressViewSchema = z.object({
  status: taskStatusSchema,
  reason: z.string().nullable(),
  requirements: z.array(z.object({ id: z.string(), title: z.string(), receiptId: z.string().nullable() })),
})

export function newTaskState(): TaskState {
  return { status: 'running', reason: null }
}
