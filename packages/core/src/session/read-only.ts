import type { LanguageModel, ModelMessage, ToolChoice, ToolResultPart, ToolSet } from 'ai'
import { isReadOnlyCommand } from '../permissions.js'
import type { ModelCallUsage } from '../usage/log.js'
import { CONTEXT_STOP_RATIO, errorResult, MAIN_AGENT_KEY, reportInvalidCall, runToolCall, streamModelStep, type TurnIO } from './loop.js'
import type { Session } from './session.js'
import { TOOLS } from './tools.js'

// 只读循环和探索工人的工具（第 508 步起没有 read_file、search 这些专用工具）：exec_command 只许跑只读命令
export const READ_ONLY_TOOLS = { exec_command: TOOLS.exec_command, write_stdin: TOOLS.write_stdin }
export const READ_ONLY_TOOL_NAMES = new Set(Object.keys(READ_ONLY_TOOLS))
export const READ_ONLY_COMMAND_ERROR =
  'You can only run read-only commands here (for example rg, rg --files, sed -n, cat, head, ls, git log, git diff, git show), without redirects or command substitution.'

// 只读的智能体调 exec_command 时先看命令是不是只读的；不是就返回说明，不执行
export function readOnlyCommandProblem(toolName: string, input: unknown): string | null {
  if (toolName !== 'exec_command') return null
  const command = typeof input === 'object' && input !== null && 'cmd' in input && typeof input.cmd === 'string' ? input.cmd : ''
  return isReadOnlyCommand(command) ? null : READ_ONLY_COMMAND_ERROR
}

// 只读的一轮：深度扫描和出计划共用。模型只能用 readTools 里的工具，最后调一次 finalTool 交结果
export interface ReadOnlyLoop {
  model: LanguageModel
  system: string
  messages: ModelMessage[]
  tools: ToolSet
  readTools: Set<string>
  finalTool: string
  maxSteps: number
  window: number
  usage: Omit<ModelCallUsage, 'usage'>
  // 模型只回了文字、没调工具时催它的话
  nudge: string
  // 模型调了不允许的工具时返回给它的说明
  readOnlyError: string
  // 收到交结果的调用；返回后这一轮结束
  onFinal(toolCallId: string, input: unknown): Promise<void>
}

export async function runReadOnlyLoop(session: Session, loop: ReadOnlyLoop, signal: AbortSignal, io: TurnIO): Promise<'done' | 'cancelled' | 'max-steps'> {
  let nearLimit = false
  for (let step = 0; step < loop.maxSteps; step++) {
    // 最后一步或上下文快满时，要求模型直接交结果
    const toolChoice: ToolChoice<ToolSet> = step === loop.maxSteps - 1 || nearLimit ? { type: 'tool', toolName: loop.finalTool } : 'auto'
    const { toolCalls, inputTokens, answered, responseMessages } = await streamModelStep(
      { model: loop.model, system: loop.system, messages: loop.messages, tools: loop.tools, toolChoice, usage: loop.usage },
      signal,
      io,
      { key: MAIN_AGENT_KEY, handles: session.stepRetries },
    )
    loop.messages.push(...responseMessages)
    nearLimit = inputTokens > loop.window * CONTEXT_STOP_RATIO
    if (signal.aborted) return 'cancelled'
    if (toolCalls.length === 0) {
      loop.messages.push({ role: 'user', content: loop.nudge })
      continue
    }
    const results: ToolResultPart[] = []
    for (const call of toolCalls) {
      if (answered.has(call.toolCallId)) {
        await reportInvalidCall(call, io)
        continue
      }
      if (call.toolName === loop.finalTool) {
        await loop.onFinal(call.toolCallId, call.input)
        return 'done'
      }
      if (!loop.readTools.has(call.toolName)) {
        results.push(errorResult(call, loop.readOnlyError))
        continue
      }
      const problem = readOnlyCommandProblem(call.toolName, call.input)
      if (problem) {
        results.push(errorResult(call, problem))
        continue
      }
      results.push((await runToolCall(session, call, signal, io)).result)
    }
    if (results.length > 0) loop.messages.push({ role: 'tool', content: results })
  }
  return 'max-steps'
}
