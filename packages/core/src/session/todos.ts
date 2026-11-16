import type { PermissionOption } from '@agentclientprotocol/sdk'
import { tool, type ToolResultPart, type ToolSet } from 'ai'
import { z } from 'zod'
import { PERMISSION_OPTIONS, type TodoRequest, type TodoView, type TodoWrite } from '../protocol.js'
import { errorResult, type StepToolCall, textResult, type TurnIO } from './loop.js'
import type { Session } from './session.js'
import { toolDefinitionChars } from './tools.js'

// 用户待办的工具层（v2）：和界面里的待办是同一份数据。读写都经客户端的主进程，不直接碰 todos.json。
// 读不用确认；写按权限模式确认，删除默认软归档，永久删除再问一次。
export const TODO_READ_TOOL = 'todo_read'
export const TODO_WRITE_TOOL = 'todo_write'

const priority = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
const repeat = z.object({ every: z.enum(['day', 'weekday', 'week', 'month']), interval: z.number().int().min(1).max(365).optional() })

const readInput = z.object({
  query: z.string().max(500).optional().describe('Keyword in the title or body'),
  project: z.string().max(2000).nullable().optional().describe('Project path; null means no-project tasks. Omit for all projects'),
  tags: z.array(z.string().min(1).max(30)).max(12).optional().describe('Only todos that have all these tags (nested tags match their children)'),
  priority: priority.optional().describe('0 = P0 (most urgent) through 3 = P3'),
  done: z.boolean().optional(),
  archived: z.boolean().optional().describe('true lists archived todos; default false'),
  due_from: z.iso.datetime().optional().describe('Only scheduled todos at or after this ISO time'),
  due_to: z.iso.datetime().optional().describe('Only scheduled todos at or before this ISO time'),
  limit: z.number().int().min(1).max(200).optional().describe('Maximum results (default 50)'),
})

const addItem = z.object({
  text: z.string().trim().min(1).max(4000).describe('Title'),
  body: z.string().max(4000).optional().describe('Optional notes'),
  priority: priority.nullable().optional(),
  project: z.string().max(2000).nullable().optional().describe('Absolute project path; null for no project; default is this task’s project'),
  tags: z.array(z.string().min(1).max(30)).max(12).optional(),
  remind_at: z.iso.datetime().optional().describe('Reminder time in ISO 8601'),
  repeat: repeat.optional().describe('Repeat the reminder; requires remind_at'),
})

const patch = z.object({
  text: z.string().trim().min(1).max(4000).optional(),
  body: z.string().max(4000).optional(),
  priority: priority.nullable().optional(),
  project: z.string().max(2000).nullable().optional(),
  tags: z.array(z.string().max(30)).max(12).optional(),
  remind_at: z.iso.datetime().nullable().optional().describe('null clears the reminder'),
  repeat: repeat.nullable().optional().describe('null clears the repeat rule'),
  done: z.boolean().optional(),
  archived: z.boolean().optional().describe('true archives, false restores'),
  position: z.enum(['top', 'bottom']).optional().describe('Move the selected todos to the top or bottom of the list'),
})

const writeInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), items: z.array(addItem).min(1).max(50) }),
  z.object({ action: z.literal('update'), ids: z.array(z.string().min(1).max(64)).min(1).max(200), fields: patch }),
  z.object({ action: z.literal('delete'), ids: z.array(z.string().min(1).max(64)).min(1).max(200), mode: z.enum(['archive', 'delete']).optional().describe('archive (default, recoverable) or delete (permanent)') }),
  z.object({ action: z.literal('complete'), ids: z.array(z.string().min(1).max(64)).min(1).max(200), done: z.boolean() }),
])

export const TODO_TOOLS = {
  [TODO_READ_TOOL]: tool({
    description:
      'Read the user\'s todos (the same list as the todo page): stable ids, title, notes, project, tags, priority, done/archived state and reminder. Filter by keyword, project, tags, priority, done state or reminder time, and get counts. Use the ids with todo_write.',
    inputSchema: readInput,
  }),
  [TODO_WRITE_TOOL]: tool({
    description: [
      'Create, update, archive/delete or complete the user\'s todos (the same data as the todo page). Batch operations take an array of ids or items.',
      'add: one or more items, each with title, optional body, priority, project, tags, reminder time and repeat rule.',
      'update: change title/body/priority/project/tags/reminder/repeat/done/archived state; position moves the selected items to the top or bottom.',
      'delete: archive by default (recoverable with archived:false); mode:"delete" permanently deletes and asks the user once more.',
      'complete: set done true or false for one or more ids. Writes are confirmed according to the current permission mode.',
    ].join('\n'),
    inputSchema: writeInput,
  }),
} satisfies ToolSet

export const TODO_TOOL_CHARS = toolDefinitionChars(TODO_TOOLS)

export function isTodoTool(name: string): name is keyof typeof TODO_TOOLS {
  return name in TODO_TOOLS
}

const WRITE_PERMISSION_CHOICES: PermissionOption[] = [
  { optionId: PERMISSION_OPTIONS.allowOnce, name: '允许一次', kind: 'allow_once' },
  { optionId: PERMISSION_OPTIONS.reject, name: '拒绝', kind: 'reject_once' },
]
const DELETE_PERMISSION_CHOICES: PermissionOption[] = [
  { optionId: PERMISSION_OPTIONS.allowOnce, name: '永久删除', kind: 'allow_once' },
  { optionId: PERMISSION_OPTIONS.reject, name: '取消', kind: 'reject_once' },
]

function writeTitle(write: TodoWrite): string {
  switch (write.action) {
    case 'add':
      return `新建 ${write.items.length} 条待办`
    case 'update':
      return `修改 ${write.ids.length} 条待办`
    case 'delete':
      return write.mode === 'delete' ? `永久删除 ${write.ids.length} 条待办` : `归档 ${write.ids.length} 条待办`
    case 'complete':
      return `${write.done ? '完成' : '取消完成'} ${write.ids.length} 条待办`
  }
}

function toRequest(name: keyof typeof TODO_TOOLS, raw: unknown): TodoRequest {
  const parsed = (name === TODO_READ_TOOL ? readInput : writeInput).safeParse(raw)
  if (!parsed.success) throw new Error(`Invalid arguments: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
  if (name === TODO_READ_TOOL) {
    const input = parsed.data as z.infer<typeof readInput>
    return {
      action: 'read',
      query: {
        ...(input.query !== undefined ? { query: input.query } : {}),
        ...(input.project !== undefined ? { project: input.project } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.done !== undefined ? { done: input.done } : {}),
        ...(input.archived !== undefined ? { archived: input.archived } : {}),
        ...(input.due_from !== undefined ? { dueFrom: input.due_from } : {}),
        ...(input.due_to !== undefined ? { dueTo: input.due_to } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      },
    }
  }
  const input = parsed.data as z.infer<typeof writeInput>
  if (input.action === 'add') {
    return {
      action: 'write',
      write: {
        action: 'add',
        items: input.items.map((item) => ({
          text: item.text,
          ...(item.body !== undefined ? { body: item.body } : {}),
          ...(item.priority !== undefined ? { priority: item.priority } : {}),
          ...(item.project !== undefined ? { project: item.project } : {}),
          ...(item.tags !== undefined ? { tags: item.tags } : {}),
          ...(item.remind_at !== undefined ? { remindAt: item.remind_at } : {}),
          ...(item.repeat !== undefined ? { repeat: item.repeat } : {}),
        })),
      },
    }
  }
  if (input.action === 'update') {
    return {
      action: 'write',
      write: {
        action: 'update',
        ids: input.ids,
        fields: {
          ...(input.fields.text !== undefined ? { text: input.fields.text } : {}),
          ...(input.fields.body !== undefined ? { body: input.fields.body } : {}),
          ...(input.fields.priority !== undefined ? { priority: input.fields.priority } : {}),
          ...(input.fields.project !== undefined ? { project: input.fields.project } : {}),
          ...(input.fields.tags !== undefined ? { tags: input.fields.tags } : {}),
          ...(input.fields.remind_at !== undefined ? { remindAt: input.fields.remind_at } : {}),
          ...(input.fields.repeat !== undefined ? { repeat: input.fields.repeat } : {}),
          ...(input.fields.done !== undefined ? { done: input.fields.done } : {}),
          ...(input.fields.archived !== undefined ? { archived: input.fields.archived } : {}),
          ...(input.fields.position !== undefined ? { position: input.fields.position } : {}),
        },
      },
    }
  }
  return { action: 'write', write: input }
}

function formatTodo(todo: TodoView): string {
  const fields = [
    todo.done ? 'done' : 'open',
    ...(todo.archivedAt ? ['archived'] : []),
    ...(todo.priority !== undefined && todo.priority !== null ? [`P${todo.priority}`] : []),
    todo.project ? `project: ${todo.project}` : 'no project',
    ...(todo.tags.length > 0 ? [`tags: ${todo.tags.join(', ')}`] : []),
    ...(todo.schedule ? [`remind: ${todo.schedule.at}${todo.schedule.repeat ? ` (${todo.schedule.repeat.every} × ${todo.schedule.repeat.interval})` : ''}`] : []),
  ]
  return `- ${todo.id} · ${todo.text} · ${fields.join(' · ')}`
}

export async function runTodoToolCall(
  session: Session,
  call: StepToolCall & { toolName: keyof typeof TODO_TOOLS },
  signal: AbortSignal,
  io: TurnIO,
): Promise<{ result: ToolResultPart; edited: boolean }> {
  const name = call.toolName
  const fail = async (message: string) => {
    await io.update({ sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: message } }] })
    return { result: errorResult(call, message), edited: false }
  }
  let request: TodoRequest
  try {
    request = toRequest(name, call.input)
  } catch (error) {
    await io.update({ sessionUpdate: 'tool_call', toolCallId: call.toolCallId, title: name, kind: 'other', status: 'in_progress', rawInput: call.input })
    return fail(error instanceof Error ? error.message : String(error))
  }
  if (request.action === 'write' && request.write.action === 'add') {
    const project = session.noProject ? null : session.cwd
    request = {
      action: 'write',
      write: { ...request.write, items: request.write.items.map((item) => (item.project === undefined ? { ...item, project } : item)) },
    }
  }
  const title = request.action === 'read' ? '读取待办' : writeTitle(request.write)
  await io.update({ sessionUpdate: 'tool_call', toolCallId: call.toolCallId, title, kind: request.action === 'read' ? 'read' : 'other', status: 'in_progress', rawInput: call.input })
  const bridge = io.todos
  if (!bridge) return fail('The todo list is not available in this client.')
  if (signal.aborted) return fail('Cancelled by the user.')
  if (request.action === 'write') {
    if (session.permissionMode !== 'full') {
      const choice = await io.requestPermission(
        { toolCallId: call.toolCallId, title: `待办：${writeTitle(request.write)}`, kind: 'other', status: 'pending', rawInput: call.input },
        WRITE_PERMISSION_CHOICES,
      )
      if (choice !== PERMISSION_OPTIONS.allowOnce) return fail('The user rejected this todo change. Do not retry it; ask the user what to change.')
    }
    if (request.write.action === 'delete' && request.write.mode === 'delete') {
      const confirm = await io.requestPermission(
        {
          toolCallId: call.toolCallId,
          title: `永久删除 ${request.write.ids.length} 条待办？删除后不能用「恢复」找回`,
          kind: 'other',
          status: 'pending',
          rawInput: call.input,
        },
        DELETE_PERMISSION_CHOICES,
      )
      if (confirm !== PERMISSION_OPTIONS.allowOnce) return fail('The user cancelled the permanent delete.')
    }
  }
  try {
    const result = await bridge.act(request)
    if (!result.ok) return fail(result.error)
    const lines = result.todos.map(formatTodo)
    const text = [result.summary, ...lines].filter(Boolean).join('\n')
    await io.update({ sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text } }] })
    return { result: textResult(call, text), edited: false }
  } catch (error) {
    if (signal.aborted) return fail('Cancelled by the user.')
    return fail(`Todo operation failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
