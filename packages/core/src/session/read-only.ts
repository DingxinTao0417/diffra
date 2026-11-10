import type { LanguageModel, ModelMessage, ToolChoice, ToolResultPart, ToolSet } from 'ai'
import type { ModelCallUsage } from '../usage/log.js'
import { CONTEXT_STOP_RATIO, errorResult, MAIN_AGENT_KEY, reportInvalidCall, runToolCall, streamModelStep, type TurnIO } from './loop.js'
import type { Session } from './session.js'

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
      results.push((await runToolCall(session, call, signal, io)).result)
    }
    if (results.length > 0) loop.messages.push({ role: 'tool', content: results })
  }
  return 'max-steps'
}
