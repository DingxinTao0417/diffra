import { runProcess, truncateLines } from '../process.js'
import type { SessionHooks } from '../protocol.js'
import { commandEnv } from '../tools/command.js'
import type { Session } from './session.js'

// 项目钩子（第 447 步，参照 qwen-code 的 hooks，只做三个时机）：用户在项目设置里填的命令，Diffra 在固定的时机替他跑。
// 存在应用设置里、不在仓库里，和检查命令一样是用户自己信任的命令，不再逐次确认。
// 钩子自己出错不拦事情（只有 beforeCommand 退出码 2 表示「拦下这条命令」），免得一个坏掉的钩子让任务没法做
const HOOK_TIMEOUT_MS = 60_000
const BLOCK_EXIT_CODE = 2

export interface HookResult {
  // 钩子没配、或跑完退出码 0
  ok: boolean
  // 只对 beforeCommand 有意义：退出码 2
  blocked: boolean
  output: string
}

export async function runHook(session: Session, event: keyof SessionHooks, env: Record<string, string>, signal?: AbortSignal): Promise<HookResult> {
  const command = session.config.hooks?.[event]
  const bashPath = session.environment.bashPath
  if (!command || !bashPath) return { ok: true, blocked: false, output: '' }
  try {
    const result = await runProcess(bashPath, ['-c', command], {
      cwd: session.cwd,
      timeoutMs: HOOK_TIMEOUT_MS,
      signal,
      env: { ...commandEnv(), DIFFRA_EVENT: event, DIFFRA_SESSION_ID: session.id, ...env },
    })
    const output = truncateLines(result.output.trim(), 20, 2000)
    if (result.timedOut) return { ok: false, blocked: false, output: `timed out after ${HOOK_TIMEOUT_MS / 1000}s` }
    return { ok: result.exitCode === 0, blocked: result.exitCode === BLOCK_EXIT_CODE, output }
  } catch (error) {
    console.error(`[hooks] ${event} 钩子没跑起来`, error)
    return { ok: false, blocked: false, output: error instanceof Error ? error.message : String(error) }
  }
}
