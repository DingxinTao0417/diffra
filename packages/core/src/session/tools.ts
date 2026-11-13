import type { ToolKind } from '@agentclientprotocol/sdk'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { APPLY_PATCH_DESCRIPTION, applyPatchTool } from '../tools/apply-patch.js'
import { execCommandTool, writeStdinTool } from '../tools/exec.js'
import { ToolError, type ToolContext, type ToolOutput } from '../tools/types.js'
import { viewImageTool } from '../tools/view-image.js'

// 基础工具照 Codex（第 506–510 步）：命令只有 exec_command（读文件、搜索也用它跑 rg、sed），改文件只有 apply_patch。
// 以前的 read_file、list_files、search、outline、edit_file、run_command、wait_command，和 finish、verify_changes、task_progress、pause_task 都去掉了

// 弱模型常把数字写成字符串（"30"）。只认明确的写法，别的照样报参数错误；发给模型的 JSON Schema 仍是 number
const looseNumber = (value: unknown) => (typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value) ? Number(value) : value)
const intField = () => z.preprocess(looseNumber, z.number().int())
const looseBoolean = (value: unknown) => (value === 'true' ? true : value === 'false' ? false : value)

const execCommandInput = z.object({
  cmd: z.string().describe('Shell command to run (bash).'),
  workdir: z.string().optional().describe('Directory to run in, relative to the project directory. Defaults to the project directory.'),
  yield_time_ms: intField().optional().describe('How long to wait for output before returning, in milliseconds (default 10000, 250 to 30000). A command still running after that keeps running in the background.'),
  max_output_tokens: intField().optional().describe('Maximum output tokens to return (default 10000).'),
  justification: z.string().optional().describe('Only for commands that need the user\'s approval: one sentence the user will see, saying why you need to run it.'),
  stdin: z.preprocess(looseBoolean, z.boolean()).optional().describe('Keep the program\'s input open so you can type into it later with write_stdin (for programs that ask questions or read input). Off by default: with input open, commands such as rg without a path wait for input.'),
})
const writeStdinInput = z.object({
  session_id: intField().describe('Session ID returned by exec_command for a process that is still running.'),
  chars: z.string().optional().describe('Leave empty to wait for more output. To stop the process, send the Ctrl-C control character "\\u0003". Other text is typed into the program (include "\\n" to press Enter; "\\u0004" closes its input); this only works for a command started with stdin: true.'),
  yield_time_ms: intField().optional().describe('How long to wait for output, in milliseconds (default 5000 when polling, up to 300000).'),
  max_output_tokens: intField().optional().describe('Maximum output tokens to return (default 10000).'),
})
const applyPatchInput = z.object({ input: z.string().describe('The entire patch, from "*** Begin Patch" to "*** End Patch".') })
const viewImageInput = z.object({ path: z.string().describe('Path of a local image file (png, jpg, gif, webp).') })

export const TOOLS = {
  exec_command: tool({
    description:
      'Run a command in a bash shell in the project directory and return its output. Use it for everything that runs a program: reading files (sed -n, cat, head), ' +
      'searching (rg, rg --files), building, testing, git. If the command is still running when yield_time_ms is up, you get a session ID and it keeps running in the background; ' +
      'use write_stdin to read more of its output or stop it. Commands that may change things can need the user\'s approval.',
    inputSchema: execCommandInput,
  }),
  write_stdin: tool({
    description: 'Read more output from a command started by exec_command that is still running, type into it (if it was started with stdin: true), or stop it with "\\u0003". Returns the new output since the last call.',
    inputSchema: writeStdinInput,
  }),
  apply_patch: tool({ description: APPLY_PATCH_DESCRIPTION, inputSchema: applyPatchInput }),
}

// 只给能看图的模型
export const VIEW_IMAGE_TOOL = {
  view_image: tool({ description: 'Attach a local image file (screenshot, design, diagram) so you can see it.', inputSchema: viewImageInput }),
}

export type ToolName = keyof typeof TOOLS | keyof typeof VIEW_IMAGE_TOOL

export const TOOL_KINDS: Record<ToolName, ToolKind> = {
  exec_command: 'execute',
  write_stdin: 'execute',
  apply_patch: 'edit',
  view_image: 'read',
}

export function isToolName(name: string): name is ToolName {
  return name in TOOL_KINDS
}

// 工具刚开始时的标题，用模型给的原始参数先带上目标；跑完后换成工具自己返回的标题
export function startTitle(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return name
  const field = (key: string): string | null => {
    const value: unknown = (input as Record<string, unknown>)[key]
    return typeof value === 'string' && value !== '' ? value : null
  }
  switch (name) {
    case 'exec_command':
      return field('cmd') ? `执行 ${field('cmd')}` : name
    case 'write_stdin': {
      const chars = field('chars')
      return chars === null ? '查看命令输出' : /^(\u0003|\\u0003|\\x03|\^C)$/.test(chars) ? '结束命令' : '向命令输入'
    }
    case 'apply_patch':
      return '修改文件'
    case 'view_image':
      return field('path') ? `查看图片 ${field('path')}` : name
    default:
      return name
  }
}

// AI SDK 已经按 inputSchema 校验过参数，这里再 parse 一次拿到准确的类型
export function executeTool(name: ToolName, input: unknown, context: ToolContext): Promise<ToolOutput> {
  switch (name) {
    case 'exec_command':
      return execCommandTool(context, parseInput(execCommandInput, input))
    case 'write_stdin':
      return writeStdinTool(context, parseInput(writeStdinInput, input))
    case 'apply_patch':
      return applyPatchTool(context, parseInput(applyPatchInput, input))
    case 'view_image':
      return viewImageTool(context, parseInput(viewImageInput, input))
  }
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  throw new ToolError(`Invalid arguments: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
}

// 工具定义发给模型时的大致篇幅，用来估算上下文分项
export function toolDefinitionChars(tools: ToolSet): number {
  return Object.entries(tools).reduce(
    (sum, [name, definition]) =>
      sum + name.length + (definition.description?.length ?? 0) + JSON.stringify(z.toJSONSchema(definition.inputSchema as z.ZodType)).length,
    0,
  )
}

export const TOOL_DEFINITION_CHARS = toolDefinitionChars(TOOLS)
