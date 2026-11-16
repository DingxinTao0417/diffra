import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { lastToolResult, startScriptedModel } from './scripted-model'

const createdId = (messages: Parameters<typeof lastToolResult>[0]) => /Created task (\S+)/.exec(lastToolResult(messages))?.[1] ?? 'missing'

test('任务互通：一个任务新建另一个任务、等它做完拿回结果；两边都能点过去', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-tasks-'))
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'task_create', input: { message: '给项目写一份 README', title: '写 README' } }] },
    // 新任务的对话从「来自任务」那条消息开始
    { match: '来自任务', text: 'README 写好了', delayMs: 1500 },
    { toolCalls: [{ name: 'task_wait', input: (messages: Parameters<typeof lastToolResult>[0]) => ({ task_id: createdId(messages) }) }] },
    { text: '另一个任务说 README 写好了' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '把文档交给另一个任务写')
    // 发出去之前按权限模式确认
    const permission = window.getByTestId('permission-card')
    await expect(permission).toContainText('新建任务「写 README」')
    await permission.getByRole('button', { name: '发送' }).click()
    await waitTaskDone(window, 40_000)
    await expect(window.getByText('另一个任务说 README 写好了')).toBeVisible()
    expect(model.requests()).toBe(4)
    // 发消息和等它做完两张卡指向同一个任务：只保留一个跳转入口
    await expect(window.getByTestId('task-link').filter({ hasText: '写 README' })).toHaveCount(1)

    // 工具卡片指向新任务，点过去能看到它是哪个任务发来的、它的回复
    const links = window.getByTestId('task-link')
    await expect(links.first()).toContainText('写 README')
    await links.first().click()
    await expect(window.getByText('README 写好了', { exact: true })).toBeVisible()
    const back = window.getByTestId('task-link').filter({ hasText: '来自任务' })
    await expect(back).toContainText('把文档交给另一个任务写')
    await back.click()
    await expect(window.getByText('另一个任务说 README 写好了')).toBeVisible()
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('任务互通（v2）：交出去不等，对方做完用 task_reply 回复一次，回复在发消息的任务里起一轮', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-tasks-reply-'))
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'task_create', input: { message: '给项目写一份 README，写好告诉我', title: '写 README' } }] },
    { text: 'README 交给另一个任务了，写好它会回复' },
    // 新任务等发消息的任务这一轮结束再回复（对方正在跑时不让回）
    { match: '来自任务', toolCalls: [{ name: 'task_reply', input: { message: 'README 写好了' } }], delayMs: 1500 },
    { match: '来自任务', text: '已经回复了' },
    { text: '另一个任务回复说 README 写好了' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '把文档交给另一个任务写')
    await window.getByTestId('permission-card').getByRole('button', { name: '发送' }).click()
    await waitTaskDone(window, 40_000)
    await expect(window.getByText('README 交给另一个任务了，写好它会回复')).toBeVisible()

    // 回复也按权限模式确认：确认卡在新任务里
    await window.getByTestId('task-link').filter({ hasText: '写 README' }).first().click()
    const permission = window.getByTestId('permission-card')
    await expect(permission).toContainText('回复任务「把文档交给另一个任务写」')
    await permission.getByRole('button', { name: '发送' }).click()
    await expect(window.getByText('已经回复了')).toBeVisible({ timeout: 20_000 })

    // 回到发消息的任务：多了一轮，开头标着回复来自哪个任务
    await window.getByTestId('task-link').filter({ hasText: '来自任务' }).first().click()
    await expect(window.getByText('另一个任务回复说 README 写好了')).toBeVisible({ timeout: 20_000 })
    await expect(window.getByTestId('task-link').filter({ hasText: '回复来自任务「写 README」' })).toBeVisible()
    await expect(window.getByTestId('turn')).toHaveCount(2)
    expect(model.requests()).toBe(5)
    expect(model.bodies().at(-1)).toContain('来自任务「写 README」的回复')
    await window.screenshot({ path: 'test-results/tasks-reply.png' })
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
