import { runProcess, truncateLines } from '../process.js'
import { ToolError, type ToolContext, type ToolOutput } from './types.js'

const DEFAULT_TIMEOUT_SECONDS = 120
const MAX_TIMEOUT_SECONDS = 600

// 命令统一在 Git Bash 里执行；关掉分页器和颜色，避免卡在交互界面或输出控制字符
export function commandEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat', NO_COLOR: '1', TERM: 'dumb' }
}

export async function runShell(
  context: Pick<ToolContext, 'cwd' | 'bashPath' | 'signal'>,
  command: string,
  timeoutSeconds: number,
): Promise<{ exitCode: number | null; output: string; timedOut: boolean; aborted: boolean; summary: string }> {
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
  const status = result.timedOut
    ? `Timed out after ${timeoutSeconds}s and was killed.`
    : result.aborted
      ? 'Cancelled by the user.'
      : `Exit code: ${result.exitCode}`
  return { ...result, output, summary: `${status}\n${output || '(no output)'}` }
}

export async function runCommandTool(
  context: ToolContext,
  input: { command: string; timeout_seconds?: number },
): Promise<ToolOutput> {
  const timeout = Math.min(Math.max(1, input.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS), MAX_TIMEOUT_SECONDS)
  const permission = await context.requestCommandPermission(input.command)
  if (!permission.allowed) throw new ToolError(permission.reason)
  const result = await runShell(context, input.command, timeout)
  return { text: result.summary, title: `执行 ${input.command}`, terminalOutput: result.summary }
}
