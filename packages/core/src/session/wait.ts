import { tool, type ToolResultPart } from 'ai'
import { z } from 'zod'
import { truncateLines } from '../process.js'
import { runShell } from '../tools/command.js'
import { ToolError } from '../tools/types.js'
import { type AgentScope, errorResult, publishTaskState, type StepToolCall, textResult, toolContext, type TurnIO } from './loop.js'
import type { Session } from './session.js'
import { recordTaskReceipt } from './task-state.js'
import { toolDefinitionChars } from './tools.js'

export const WAIT_COMMAND_TOOL = 'wait_command'

const MIN_INTERVAL_SECONDS = 10
const DEFAULT_INTERVAL_SECONDS = 30
const DEFAULT_MAX_MINUTES = 60
const MAX_MAX_MINUTES = 180
// 每次检查的命令最多跑这么久，卡住的检查不会拖住整个等待
const CHECK_TIMEOUT_SECONDS = 120
// 卡片上显示最后一次输出的末尾几行
const TAIL_LINES = 15

const waitInput = z.object({
  command: z.string().trim().min(1).describe('A quick command that reports the current state, e.g. `gh run view 123 --json status,conclusion`'),
  success: z.string().min(1).optional().describe('Done when the output contains this text. Without it, done when the command exits with code 0'),
  failure: z.string().min(1).optional().describe('Stop early as failed when the output contains this text, e.g. "failure"'),
  interval_seconds: z.number().int().min(MIN_INTERVAL_SECONDS).max(600).optional().describe(`Seconds between checks (default ${DEFAULT_INTERVAL_SECONDS})`),
  max_minutes: z.number().int().min(1).max(MAX_MAX_MINUTES).optional().describe(`Give up after this many minutes (default ${DEFAULT_MAX_MINUTES})`),
})

type WaitInput = z.infer<typeof waitInput>

// 等一件外面的事做完（CI、部署、别人的检查）：core 按间隔反复跑一条检查命令，期间不调模型，
// 等到成功、失败或超时才把最后一次输出交给模型。比反复调 run_command 省 token，也不会被当成卡死
export const waitCommandTool = tool({
  description: [
    'Wait for something outside this conversation to finish (a CI run, a deploy, a review check) by running a check command repeatedly until its output says it is done.',
    'Use this instead of calling run_command again and again, or a blocking watch command that can outlast the 10-minute command limit. No model calls happen while waiting.',
    'Pick a command that returns quickly and prints the current state. Give `success` (text that means done) and, if possible, `failure` (text that means it failed).',
  ].join('\n'),
  inputSchema: waitInput,
})

function tail(text: string): string {
  return text.split('\n').slice(-TAIL_LINES).join('\n')
}

function formatElapsed(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

type Outcome = 'success' | 'failure' | 'timeout' | 'cancelled'

export async function runWaitCommand(session: Session, call: StepToolCall, signal: AbortSignal, io: TurnIO, scope?: AgentScope): Promise<{ result: ToolResultPart; edited: boolean }> {
  const parsed = waitInput.safeParse(call.input)
  if (!parsed.success) {
    const message = `Invalid arguments: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`
    await io.update({ sessionUpdate: 'tool_call', toolCallId: call.toolCallId, title: '等待', kind: 'execute', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: message } }] })
    return { result: errorResult(call, message), edited: false }
  }
  const input: WaitInput = parsed.data
  const interval = (input.interval_seconds ?? DEFAULT_INTERVAL_SECONDS) * 1000
  const deadline = Date.now() + (input.max_minutes ?? DEFAULT_MAX_MINUTES) * 60_000
  const started = Date.now()
  const title = `等待 ${input.command}`
  await io.update({ sessionUpdate: 'tool_call', toolCallId: call.toolCallId, title, kind: 'execute', status: 'in_progress', rawInput: call.input })
  const context = toolContext(session, call, signal, io, scope)
  const permission = await context.requestCommandPermission(input.command)
  if (!permission.allowed) {
    await io.update({ sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: permission.reason } }] })
    return { result: errorResult(call, permission.reason), edited: false }
  }
  // 等待期间检查命令可能改了文件（比如拉代码），之前的验证作废
  session.verifiedSnapshot = null
  let attempts = 0
  let last = { summary: '', output: '', exitCode: null as number | null }
  let outcome: Outcome
  try {
    for (;;) {
      attempts++
      const run = await runShell(context, input.command, CHECK_TIMEOUT_SECONDS)
      last = { summary: run.summary, output: run.output, exitCode: run.exitCode }
      if (signal.aborted) {
        outcome = 'cancelled'
        break
      }
      if (input.failure && run.output.includes(input.failure)) {
        outcome = 'failure'
        break
      }
      if (input.success ? run.output.includes(input.success) : run.exitCode === 0 && !run.timedOut) {
        outcome = 'success'
        break
      }
      if (Date.now() + interval > deadline) {
        outcome = 'timeout'
        break
      }
      await io.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: call.toolCallId,
        content: [{ type: 'content', content: { type: 'text', text: `第 ${attempts} 次检查还没好 · 已等 ${formatElapsed(Date.now() - started)} · ${Math.round(interval / 1000)} 秒后再查\n${tail(run.output) || '(没有输出)'}` } }],
      })
      await sleep(interval, signal)
      if (signal.aborted) {
        outcome = 'cancelled'
        break
      }
    }
  } catch (error) {
    const message = error instanceof ToolError || error instanceof Error ? error.message : String(error)
    await io.update({ sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: message } }] })
    return { result: errorResult(call, message), edited: false }
  }
  const elapsed = formatElapsed(Date.now() - started)
  const headline = {
    success: `等到了：第 ${attempts} 次检查成功，共等 ${elapsed}`,
    failure: `检查结果是失败：第 ${attempts} 次检查的输出里有「${input.failure ?? ''}」，共等 ${elapsed}`,
    timeout: `等了 ${elapsed} 还没好，超过了 ${input.max_minutes ?? DEFAULT_MAX_MINUTES} 分钟的上限`,
    cancelled: `停止了等待，共等 ${elapsed}`,
  }[outcome]
  const modelText = `${{ success: 'Done', failure: 'Failed', timeout: 'Timed out', cancelled: 'Cancelled by the user' }[outcome]} after ${attempts} check(s) over ${elapsed}.\nLast check:\n${truncateLines(last.summary)}`
  let resultText = modelText
  // 等到了：最后那次输出和 run_command 成功的输出一样记成证据，完成条件（比如「CI 成功」）照样能核对
  if (outcome === 'success') {
    session.taskState = recordTaskReceipt(session.taskState, call.toolCallId, input.command, last.summary)
    resultText += `\nEvidence receipt id: ${call.toolCallId}`
    await publishTaskState(session, io)
  }
  await io.update({
    sessionUpdate: 'tool_call_update',
    toolCallId: call.toolCallId,
    status: outcome === 'success' ? 'completed' : 'failed',
    content: [{ type: 'content', content: { type: 'text', text: `${headline}\n${tail(last.output) || '(没有输出)'}` } }],
    _meta: { diffra: { commandSucceeded: outcome === 'success' } },
  })
  return { result: outcome === 'success' ? textResult(call, resultText) : errorResult(call, resultText), edited: false }
}

export const WAIT_TOOL_CHARS = toolDefinitionChars({ [WAIT_COMMAND_TOOL]: waitCommandTool })
