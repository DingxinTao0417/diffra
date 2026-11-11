import { runProcess, truncateLines } from '../process.js'
import { similarCommands } from './suggest.js'
import { ToolError, type ToolContext, type ToolOutput } from './types.js'

const DEFAULT_TIMEOUT_SECONDS = 120
const MAX_TIMEOUT_SECONDS = 600
// 检查比较前后两次的错误要看全部输出：按给模型看的规模截短，中间被省略的错误会被算成修好了
const FULL_MAX_LINES = 20_000
const FULL_MAX_CHARS = 2 * 1024 * 1024

// 命令统一在 Git Bash 里执行；关掉分页器和颜色，避免卡在交互界面或输出控制字符
export function commandEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat', NO_COLOR: '1', TERM: 'dumb' }
}

export async function runShell(
  context: Pick<ToolContext, 'cwd' | 'bashPath' | 'signal'>,
  command: string,
  timeoutSeconds: number,
): Promise<{ exitCode: number | null; output: string; timedOut: boolean; aborted: boolean; summary: string; fullSummary: string }> {
  if (!context.bashPath) {
    throw new ToolError('No bash found. Install Git for Windows to run commands.')
  }
  const result = await runProcess(context.bashPath, ['-c', command], {
    cwd: context.cwd,
    timeoutMs: timeoutSeconds * 1000,
    signal: context.signal,
    env: commandEnv(),
  })
  const output = truncateLines(result.output.trim())
  const full = truncateLines(result.output.trim(), FULL_MAX_LINES, FULL_MAX_CHARS)
  const status = result.timedOut
    ? `Timed out after ${timeoutSeconds}s and was killed.`
    : result.aborted
      ? 'Cancelled by the user.'
      : `Exit code: ${result.exitCode}`
  return { ...result, output, summary: `${status}\n${output || '(no output)'}`, fullSummary: `${status}\n${full || '(no output)'}` }
}

export async function runCommandTool(
  context: ToolContext,
  input: { command: string; timeout_seconds?: number },
): Promise<ToolOutput> {
  const timeout = Math.min(Math.max(1, input.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS), MAX_TIMEOUT_SECONDS)
  const permission = await context.requestCommandPermission(input.command)
  if (!permission.allowed) throw new ToolError(permission.reason)
  const result = await runShell(context, input.command, timeout)
  const hint = result.exitCode === 127 ? await missingCommandHint(context, result.output) : ''
  return { text: result.summary + hint, title: `执行 ${input.command}`, terminalOutput: result.summary, commandSucceeded: result.exitCode === 0 && !result.timedOut && !result.aborted }
}

// 退出码 127 是命令不存在：给几个 bash 里能找到、名字接近的命令；都不像就提示去项目里找它平时怎么跑
async function missingCommandHint(context: ToolContext, output: string): Promise<string> {
  const name = /([^\s:]+): command not found/.exec(output)?.[1]
  if (!name || !context.bashPath) return ''
  const similar = await similarCommands(context, context.bashPath, commandEnv(), name)
  return similar.length > 0
    ? `\n\`${name}\` was not found. Similar commands that exist: ${similar.join(', ')}.`
    : `\n\`${name}\` is not installed or not on PATH in Git Bash. Check how the project runs it (package.json scripts, a Makefile, a virtualenv) instead of guessing.`
}
