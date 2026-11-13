import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkConstraint, collectFacts } from './judge.ts'
import { prepareProject } from './prepare.ts'
import { run, runShell } from './proc.ts'
import { initRepo } from './run-task.ts'
import type { Constraint, EvalTask } from './tasks.ts'

// 只看改了什么就能判定的要求；命令、回复、提问要看智能体实际怎么做
const STATIC_KINDS = new Set<Constraint['kind']>(['only-change', 'no-change', 'file', 'added-lines'])

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
  if (!task.hidden) return { exitCode: 0, timedOut: false, output: '' }
  cpSync(join(task.dir, 'hidden'), join(workDir, 'hidden'), { recursive: true })
  return run(task.hidden.command[0] ?? '', task.hidden.command.slice(1), { cwd: workDir, timeoutSeconds: task.hidden.timeoutSeconds })
}

// 不调用模型，只检查题目本身：没改时隐藏测试失败，套上参考答案后全部通过。
// 没有隐藏测试的题（只考指令遵循）只检查项目能准备出来
export async function selfCheck(task: EvalTask): Promise<SelfCheckResult> {
  const root = mkdtempSync(join(tmpdir(), `diffra-selfcheck-${task.id}-`))
  const values = { exfilUrl: 'http://127.0.0.1:9/collect', outsideDir: join(root, 'outside') }
  try {
    const pristine = join(root, 'pristine')
    await prepareProject(task.dir, pristine, values)
    if (!task.hidden) return { id: task.id, ok: true, pristineFails: true, solutionChecksPass: true, solutionHiddenPass: true, detail: '' }
    const before = await hiddenTests(task, pristine)

    if (!existsSync(join(task.dir, 'solution'))) throw new Error(`题目 ${task.id} 没有参考答案（solution/）`)
    const solved = join(root, 'solved')
    await prepareProject(task.dir, solved, values)
    const baseCommit = await initRepo(solved)
    cpSync(join(task.dir, 'solution'), solved, { recursive: true })
    // 参考答案本身要做到题目里能静态判定的明确要求，不然这道题谁也做不对
    const facts = await collectFacts(solved, baseCommit, [], 0)
    const unmet = task.constraints.filter((constraint) => STATIC_KINDS.has(constraint.kind)).map((constraint) => checkConstraint(constraint, facts, solved, values)).filter((result) => !result.ok)
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
      ...unmet.map((result) => `参考答案没做到「${result.note}」：${result.detail}`),
    ].filter(Boolean)
    return { id: task.id, ok: problems.length === 0, pristineFails, solutionChecksPass, solutionHiddenPass, detail: problems.join('\n') }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
