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
