import type { ToolKind } from '@agentclientprotocol/sdk'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { pauseTaskSchema, taskUpdateSchema } from './task-state.js'
import { runCommandTool } from '../tools/command.js'
import { editFileTool, listFilesTool, readFileTool, searchTool } from '../tools/files.js'
import { outlineTool } from '../tools/outline.js'
import { ToolError, type ToolContext, type ToolOutput } from '../tools/types.js'

const pathField = z.string().describe('Path relative to the project directory, or an external absolute path (requires user approval)')

const readFileInput = z.object({
  path: pathField,
  offset: z.number().int().positive().optional().describe('1-based line number to start reading from'),
  limit: z.number().int().positive().optional().describe('Maximum number of lines to return (default 400)'),
})
const listFilesInput = z.object({ path: pathField.optional().describe('Directory to list (default: project root)') })
const outlineInput = z.object({ path: pathField.optional().describe('File or directory to outline (default: project root)') })
const searchInput = z.object({
  pattern: z.string().describe('Regular expression to search for (plain text when literal is true)'),
  path: pathField.optional().describe('File or directory to search in (default: project root)'),
  glob: z.string().optional().describe('Only search files matching this glob, e.g. "*.ts"'),
  literal: z.boolean().optional().describe('Treat pattern as plain text'),
})
const editFileInput = z.object({
  path: pathField,
  old_string: z.string().describe('Exact text to replace. Empty string creates a new file.'),
  new_string: z.string().describe('Replacement text'),
  replace_all: z.boolean().optional().describe('Replace every occurrence instead of exactly one'),
})
const runCommandInput = z.object({
  command: z.string().describe('Bash command to run in the project directory'),
  timeout_seconds: z.number().int().positive().optional().describe('Default 120, maximum 600'),
})
const finishInput = z.object({
  summary: z.string().describe('Short summary of what you did'),
  goal_met: z.boolean().optional().describe('Only in goal mode: true when the whole goal and its completion criteria are met and verified'),
})

export const TOOLS = {
  read_file: tool({
    description: 'Read a text file. Returns numbered lines. You must read a file before editing it.',
    inputSchema: readFileInput,
  }),
  list_files: tool({
    description: 'List files under a directory recursively, skipping git-ignored files. Use it to explore the project.',
    inputSchema: listFilesInput,
  }),
  search: tool({
    description: 'Search file contents with ripgrep. Returns matching lines with file paths and line numbers.',
    inputSchema: searchInput,
  }),
  outline: tool({
    description:
      'List the functions, classes, methods, interfaces and types defined in a file, or in every source file under a directory, ' +
      'with line numbers. Supports TypeScript, JavaScript, Vue and Python. Use it for an overview before reading files one by one.',
    inputSchema: outlineInput,
  }),
  edit_file: tool({
    description:
      'Replace text in a file, or create a new file by passing an empty old_string. old_string must match exactly one place ' +
      '(include a few surrounding lines to make it unique) unless replace_all is true.',
    inputSchema: editFileInput,
  }),
  run_command: tool({
    description:
      'Run a bash command in the project directory, e.g. tests or builds. Commands that may change things need the user\'s approval.',
    inputSchema: runCommandInput,
  }),
  verify_changes: tool({
    description: 'Run full project checks, security checks and rule review WITHOUT ending the task. Use before commit/push/build/publish. Continue working after success; validation is not task completion.',
    inputSchema: finishInput,
  }),
  task_progress: tool({
    description: 'Define immutable completion requirements before multi-stage work; satisfy them using receipt ids from successful run_command calls. Each requirement matches actual command AND output. Release contracts require ids commit, push, ci, publish with concrete SHA/version evidence. status returns saved progress and receipts.',
    inputSchema: taskUpdateSchema,
  }),
  pause_task: tool({
    description: 'Stop as waiting or blocked, NOT completed. Explain the missing permission, credentials, CI wait or other blocker. All unfinished requirements remain saved for resuming.',
    inputSchema: pauseTaskSchema,
  }),
  finish: tool({
    description:
      'TERMINAL: call ONLY when the entire user request is completed, including commit/push/CI/publication if requested. It ends the turn. For intermediate validation use verify_changes; for blockers use pause_task. Unsatisfied completion requirements reject finish.',
    inputSchema: finishInput,
  }),
}

export type ToolName = keyof typeof TOOLS

export const TOOL_KINDS: Record<ToolName, ToolKind> = {
  read_file: 'read',
  list_files: 'search',
  search: 'search',
  outline: 'read',
  edit_file: 'edit',
  run_command: 'execute',
  verify_changes: 'other',
  task_progress: 'other',
  pause_task: 'other',
  finish: 'other',
}

export function isToolName(name: string): name is ToolName {
  return name in TOOLS
}

// AI SDK 已经按 inputSchema 校验过参数，这里再 parse 一次拿到准确的类型
export function executeTool(name: Exclude<ToolName, 'finish'>, input: unknown, context: ToolContext): Promise<ToolOutput> {
  switch (name) {
    case 'verify_changes':
    case 'task_progress':
    case 'pause_task':
      throw new ToolError(`${name} must be handled by the session lifecycle.`)
    case 'read_file':
      return readFileTool(context, parseInput(readFileInput, input))
    case 'list_files':
      return listFilesTool(context, parseInput(listFilesInput, input))
    case 'search':
      return searchTool(context, parseInput(searchInput, input))
    case 'outline':
      return outlineTool(context, parseInput(outlineInput, input))
    case 'edit_file':
      return editFileTool(context, parseInput(editFileInput, input))
    case 'run_command':
      return runCommandTool(context, parseInput(runCommandInput, input))
  }
}

export function parseFinishInput(input: unknown): { summary: string; goal_met?: boolean } {
  return parseInput(finishInput, input)
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
