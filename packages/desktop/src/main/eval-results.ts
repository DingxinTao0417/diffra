import { readFile, stat } from 'node:fs/promises'
import type { EvalOutcome } from '@diffra/core/types'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { z } from 'zod'
import { IPC_CHANNELS } from '../shared/ipc'

// 在桌面端里看评测结果（v2 · M11）：用户选 packages/eval 跑出来的 results.json，这里读出每道题每遍的结果，
// 统计在界面里用 core 的 stats.ts 算。只读，不改文件；文件太大（超过 50 MB）不读
const MAX_BYTES = 50 * 1024 * 1024

const taskSchema = z.object({
  id: z.string(),
  category: z.string(),
  model: z.string(),
  passed: z.boolean(),
  difficulty: z.enum(['easy', 'medium', 'hard']).nullable().optional(),
  durationMs: z.number(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number(), cost: z.string().nullable().optional() }),
})
const resultsSchema = z.object({ startedAt: z.string().optional(), models: z.array(z.string()).optional(), tasks: z.array(taskSchema) })

export async function readEvalResults(path: string): Promise<{ path: string; startedAt: string | null; outcomes: EvalOutcome[] }> {
  const info = await stat(path)
  if (info.size > MAX_BYTES) throw new Error('文件太大了，不像是评测结果')
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw new Error('不是有效的 JSON')
  }
  const parsed = resultsSchema.safeParse(raw)
  if (!parsed.success) throw new Error('不是评测的 results.json（没有 tasks，或者格式不对）')
  return {
    path,
    startedAt: parsed.data.startedAt ?? null,
    outcomes: parsed.data.tasks.map((task) => ({
      id: task.id,
      category: task.category,
      model: task.model,
      passed: task.passed,
      difficulty: task.difficulty ?? null,
      tokens: task.usage.inputTokens + task.usage.outputTokens,
      cost: task.usage.cost ?? null,
      durationMs: task.durationMs,
    })),
  }
}

export function registerEvalResultsIpc(): void {
  // 弹出选择框选一份 results.json；取消返回 null
  ipcMain.handle(IPC_CHANNELS.evalResultsOpen, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = { title: '打开评测结果', filters: [{ name: '评测结果', extensions: ['json'] }], properties: ['openFile' as const] }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    const path = result.canceled ? undefined : result.filePaths[0]
    return path ? readEvalResults(path) : null
  })
}
