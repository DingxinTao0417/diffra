import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run, runShell } from './proc.ts'
import type { EvalTask } from './tasks.ts'

export interface SelfCheckResult {
  id: string
  ok: boolean
  // 原样的项目：隐藏测试必须失败（题目确实要求改动）
  pristineFails: boolean
  // 套上参考答案：可见的检查命令和隐藏测试都要通过
  solutionChecksPass: boolean
  solutionHiddenPass: boolean
  detail: string
}

async function hiddenTests(task: EvalTask, workDir: string) {
  cpSync(join(task.dir, 'hidden'), join(workDir, 'hidden'), { recursive: true })
  return run(task.hidden.command[0] ?? '', task.hidden.command.slice(1), { cwd: workDir, timeoutSeconds: task.hidden.timeoutSeconds })
}

// 不调用模型，只检查题目本身：没改时隐藏测试失败，套上参考答案后全部通过
export async function selfCheck(task: EvalTask): Promise<SelfCheckResult> {
  const root = mkdtempSync(join(tmpdir(), `diffra-selfcheck-${task.id}-`))
  try {
    const pristine = join(root, 'pristine')
    cpSync(join(task.dir, 'repo'), pristine, { recursive: true })
    const before = await hiddenTests(task, pristine)

    const solved = join(root, 'solved')
    cpSync(join(task.dir, 'repo'), solved, { recursive: true })
    if (!existsSync(join(task.dir, 'solution'))) throw new Error(`题目 ${task.id} 没有参考答案（solution/）`)
    cpSync(join(task.dir, 'solution'), solved, { recursive: true })
    const command = task.checks.beforeFinish ?? task.checks.afterEdit
    const checks = command ? await runShell(command, solved, 300) : { exitCode: 0, timedOut: false, output: '' }
    const after = await hiddenTests(task, solved)

    const pristineFails = before.exitCode !== 0
    const solutionChecksPass = checks.exitCode === 0 && !checks.timedOut
    const solutionHiddenPass = after.exitCode === 0 && !after.timedOut
    const problems = [
      pristineFails ? null : '原样的项目隐藏测试就通过了',
      solutionChecksPass ? null : `参考答案没通过检查命令：\n${checks.output.slice(-1500)}`,
      solutionHiddenPass ? null : `参考答案没通过隐藏测试：\n${after.output.slice(-1500)}`,
    ].filter(Boolean)
    return { id: task.id, ok: problems.length === 0, pristineFails, solutionChecksPass, solutionHiddenPass, detail: problems.join('\n') }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
