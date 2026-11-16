import type { PermissionOption, ToolCallUpdate } from '@agentclientprotocol/sdk'
import type { ToolResultPart } from 'ai'
import { describe, expect, test } from 'vitest'
import { PERMISSION_OPTIONS, type TodoActionResult, type TodoRequest, type TodoView } from '../src/protocol.js'
import { runToolCall } from '../src/session/loop.js'
import { makeSession, recordingIO, scriptedModel, useTempProject } from './loop-helpers.js'

// 待办工具层（v2）：读写都走客户端的待办桥；写按权限模式确认，永久删除再问一次
useTempProject()

const todo = (overrides: Partial<TodoView> = {}): TodoView => ({
  id: 'todo-1',
  text: '修复登录',
  project: '/work/diffra',
  tags: ['修复'],
  createdAt: '2026-11-16T00:00:00.000Z',
  done: false,
  ...overrides,
})

function fakeTodos() {
  const requests: TodoRequest[] = []
  return {
    requests,
    todos: {
      act: async (request: TodoRequest): Promise<TodoActionResult> => {
        requests.push(request)
        if (request.action === 'read') return { ok: true, todos: [todo()], summary: '找到 1 条待办' }
        if (request.write.action === 'delete') return { ok: true, todos: [todo({ archivedAt: request.write.mode === 'delete' ? undefined : '2026-11-16T01:00:00.000Z' })], summary: '删除了 1 条待办' }
        return { ok: true, todos: [todo()], summary: '写好了 1 条待办' }
      },
    },
  }
}

function askingIO(choices: Array<string | null>) {
  const asked: string[] = []
  const io = recordingIO()
  io.requestPermission = async (toolCall: ToolCallUpdate, _options: PermissionOption[]) => {
    asked.push(toolCall.title ?? '')
    return choices.shift() ?? null
  }
  return { io, asked }
}

const text = (part: ToolResultPart | undefined) => (part?.output.type === 'text' || part?.output.type === 'error-text' ? part.output.value : '')

describe('待办工具', () => {
  test('主智能体的工具清单里有 todo_read / todo_write', async () => {
    const session = await makeSession(scriptedModel([]))
    expect(Object.keys(session.toolSet())).toEqual(expect.arrayContaining(['todo_read', 'todo_write']))
  })

  test('查询不用确认，过滤条件原样交给客户端', async () => {
    const session = await makeSession(scriptedModel([]))
    const fake = fakeTodos()
    const { io, asked } = askingIO([])
    const result = await runToolCall(
      session,
      { toolCallId: 't1', toolName: 'todo_read', input: { query: '登录', tags: ['修复'], priority: 1, archived: false, limit: 20 }, invalid: null },
      new AbortController().signal,
      { ...io, todos: fake.todos },
    )
    expect(asked).toEqual([])
    expect(fake.requests[0]).toEqual({ action: 'read', query: { query: '登录', tags: ['修复'], priority: 1, archived: false, limit: 20 } })
    expect(text(result.result)).toContain('todo-1')
    expect(text(result.result)).toContain('找到 1 条待办')
  })

  test('新建：按项目默认值补 project，问一次，再交给客户端', async () => {
    const session = await makeSession(scriptedModel([]))
    const fake = fakeTodos()
    const { io, asked } = askingIO([PERMISSION_OPTIONS.allowOnce])
    const result = await runToolCall(
      session,
      { toolCallId: 't2', toolName: 'todo_write', input: { action: 'add', items: [{ text: '加一条 P1 待办', priority: 1, tags: ['新功能'] }] }, invalid: null },
      new AbortController().signal,
      { ...io, todos: fake.todos },
    )
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('新建 1 条待办')
    const request = fake.requests[0]
    expect(request?.action).toBe('write')
    if (request?.action !== 'write' || request.write.action !== 'add') throw new Error('expected add')
    expect(request.write.items[0]).toMatchObject({ text: '加一条 P1 待办', project: session.cwd, priority: 1, tags: ['新功能'] })
    expect(text(result.result)).toContain('写好了 1 条待办')
  })

  test('批量修改：ids 和字段一起传；拒绝时客户端不执行', async () => {
    const session = await makeSession(scriptedModel([]))
    const fake = fakeTodos()
    const { io } = askingIO([PERMISSION_OPTIONS.reject])
    const result = await runToolCall(
      session,
      { toolCallId: 't3', toolName: 'todo_write', input: { action: 'update', ids: ['a', 'b'], fields: { priority: 2, tags: ['修复'], position: 'top' } }, invalid: null },
      new AbortController().signal,
      { ...io, todos: fake.todos },
    )
    expect(fake.requests).toEqual([])
    expect(text(result.result)).toContain('rejected')
  })

  test('完全放行时不问第一次，永久删除仍然再问一次', async () => {
    const session = await makeSession(scriptedModel([]))
    session.permissionMode = 'full'
    const fake = fakeTodos()
    const { io, asked } = askingIO([PERMISSION_OPTIONS.allowOnce])
    await runToolCall(
      session,
      { toolCallId: 't4', toolName: 'todo_write', input: { action: 'delete', ids: ['todo-1'], mode: 'delete' }, invalid: null },
      new AbortController().signal,
      { ...io, todos: fake.todos },
    )
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('永久删除 1 条待办')
    expect(fake.requests[0]).toEqual({ action: 'write', write: { action: 'delete', ids: ['todo-1'], mode: 'delete' } })
  })

  test('参数不对时不问客户端，直接把错误交给模型', async () => {
    const session = await makeSession(scriptedModel([]))
    const fake = fakeTodos()
    const { io, asked } = askingIO([])
    const result = await runToolCall(
      session,
      { toolCallId: 't5', toolName: 'todo_write', input: { action: 'add', items: [] }, invalid: null },
      new AbortController().signal,
      { ...io, todos: fake.todos },
    )
    expect(asked).toEqual([])
    expect(fake.requests).toEqual([])
    expect(text(result.result)).toContain('Invalid arguments')
  })
})
