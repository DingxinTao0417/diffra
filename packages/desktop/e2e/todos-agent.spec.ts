import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { lastToolResult, startScriptedModel } from './scripted-model'

const todoId = (messages: Parameters<typeof lastToolResult>[0]) => /- ([0-9a-f-]{36}) ·/.exec(lastToolResult(messages))?.[1] ?? 'missing'

test('智能体待办工具：新建、批量改优先级/标签、归档、查询已归档都走同一份 todos.json', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-todos-agent-'))
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'todo_write', input: { action: 'add', items: [{ text: '加一条 P1 待办', priority: 1, tags: ['新功能'] }] } }] },
    { toolCalls: [{ name: 'todo_write', input: (messages: Parameters<typeof lastToolResult>[0]) => ({ action: 'update', ids: [todoId(messages)], fields: { priority: 2, tags: ['新功能', '修复'], position: 'top' } }) }] },
    { toolCalls: [{ name: 'todo_write', input: (messages: Parameters<typeof lastToolResult>[0]) => ({ action: 'delete', ids: [todoId(messages)] }) }] },
    { toolCalls: [{ name: 'todo_read', input: { archived: true, tags: ['新功能'] } }] },
    { text: '待办处理好了' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '待办测试', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '帮我加一条 P1 待办')
    const permission = window.getByTestId('permission-card')
    await expect(permission).toContainText('待办：新建 1 条待办')
    await permission.getByRole('button', { name: '允许一次', exact: true }).click()
    await expect(permission).toContainText('待办：修改 1 条待办')
    await permission.getByRole('button', { name: '允许一次', exact: true }).click()
    await expect(permission).toContainText('待办：归档 1 条待办')
    await permission.getByRole('button', { name: '允许一次', exact: true }).click()
    await waitTaskDone(window, 40_000)
    await expect(window.getByText('待办处理好了')).toBeVisible()
    const saved = JSON.parse(readFileSync(join(userDataDir, 'todos.json'), 'utf8')) as { todos: Array<{ text: string; priority?: number; tags: string[]; archivedAt?: string | null }> }
    expect(saved.todos).toHaveLength(1)
    expect(saved.todos[0]).toMatchObject({ text: '加一条 P1 待办', priority: 2, tags: ['新功能', '修复'] })
    expect(saved.todos[0].archivedAt).toBeTruthy()
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('永久删除要再确认一次，取消后待办还在', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-todos-agent-delete-'))
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'todo_write', input: { action: 'add', items: [{ text: '不要删我' }] } }] },
    { toolCalls: [{ name: 'todo_write', input: (messages: Parameters<typeof lastToolResult>[0]) => ({ action: 'delete', ids: [todoId(messages)], mode: 'delete' }) }] },
    { text: '保留好了' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '待办测试', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '加一条再永久删除')
    const permission = window.getByTestId('permission-card')
    await expect(permission).toContainText('待办：新建 1 条待办')
    await permission.getByRole('button', { name: '允许一次', exact: true }).click()
    await expect(permission).toContainText('待办：永久删除 1 条待办')
    await permission.getByRole('button', { name: '允许一次', exact: true }).click()
    await expect(permission).toContainText('永久删除 1 条待办？')
    await permission.getByRole('button', { name: '取消', exact: true }).click()
    await waitTaskDone(window, 40_000)
    const saved = JSON.parse(readFileSync(join(userDataDir, 'todos.json'), 'utf8')) as { todos: Array<{ text: string }> }
    expect(saved.todos.map((todo) => todo.text)).toEqual(['不要删我'])
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
