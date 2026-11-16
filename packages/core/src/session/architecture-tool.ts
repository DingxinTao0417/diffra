import { tool, type ToolResultPart, type ToolSet } from 'ai'
import { z } from 'zod'
import { QUERY_ACTIONS, type QueryAction, runArchitectureQuery } from '../architecture/query.js'
import { errorResult, type StepToolCall, textResult, type TurnIO } from './loop.js'
import type { Session } from './session.js'
import { toolDefinitionChars } from './tools.js'

// 任务里的智能体查架构图（v2 · M9）：项目在「架构」页分析过才给这个工具；只读，用最近一次分析的结果
export const ARCHITECTURE_TOOL = 'architecture'

const architectureInput = z.object({
  action: z.enum(QUERY_ACTIONS),
  path: z.string().max(1000).optional().describe('File or directory, relative to the project root ("" or omitted = whole project)'),
  to: z.string().max(1000).optional().describe('path action: the file or directory to reach'),
  symbol: z.string().max(200).optional().describe('find: a name or part of it; calls/callers: the function, or Class.method'),
})

const ARCHITECTURE_TOOLS = {
  [ARCHITECTURE_TOOL]: tool({
    description:
      "Query this project's architecture analysis (from Diffra's Architecture page; read-only, may be stale if code changed since it ran). Actions: " +
      'overview (packages, directories and how they depend on each other, cycles, target architecture status); ' +
      'dependencies / dependents (project files or directories a path imports / that import it, with lines); ' +
      'symbols (functions, classes, methods of a file or the exported ones of a directory); find (where a symbol is defined); ' +
      'path (shortest import chain from path to to); violations (target architecture rules broken, with file:line); ' +
      'calls / callers (static function call graph for path + symbol; dynamic dispatch and callbacks are not tracked); ' +
      'runtime (the last runtime trace, if the user ran one: hottest functions, calls only seen at runtime, files that did not run). ' +
      'Use it to understand structure and the impact of a change before reading many files; verify details in the code.',
    inputSchema: architectureInput,
  }),
}

export const ARCHITECTURE_TOOL_CHARS = toolDefinitionChars(ARCHITECTURE_TOOLS)

export function architectureTools(session: Session): ToolSet {
  return session.architecture?.hasAnalysis(session.cwd) ? ARCHITECTURE_TOOLS : {}
}

const ACTION_TITLES: Record<QueryAction, string> = {
  overview: '概览',
  dependencies: '依赖',
  dependents: '被依赖',
  symbols: '符号',
  find: '查找',
  path: '依赖路径',
  violations: '目标架构违规',
  calls: '调用了谁',
  callers: '被谁调用',
  runtime: '运行时',
}

export async function runArchitectureTool(session: Session, call: StepToolCall, io: TurnIO): Promise<{ result: ToolResultPart; edited: boolean }> {
  const parsed = architectureInput.safeParse(call.input)
  const fail = async (title: string, message: string) => {
    await io.update({ sessionUpdate: 'tool_call', toolCallId: call.toolCallId, title, kind: 'search', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: message } }] })
    return { result: errorResult(call, message), edited: false }
  }
  if (!parsed.success) return fail('查架构', `Invalid arguments: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
  const input = parsed.data
  const subject = [input.path, input.symbol, input.to].filter(Boolean).join(' ')
  const title = `查架构：${ACTION_TITLES[input.action]}${subject ? ` ${subject}` : ''}`
  await io.update({ sessionUpdate: 'tool_call', toolCallId: call.toolCallId, title, kind: 'search', status: 'in_progress', rawInput: input })
  const data = await session.architecture?.queryData(session.cwd).catch((error: unknown) => {
    console.error('[architecture] 读分析结果失败', error)
    return null
  })
  if (!data) return fail(title, 'This project has not been analyzed on the Architecture page (or the result could not be read). Explore the code with the file tools instead.')
  const text = runArchitectureQuery(data.analysis, data.target, input, data.runtime)
  await io.update({ sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text } }] })
  return { result: textResult(call, text), edited: false }
}
