import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, test } from '@playwright/test'
import { answerOpenDialog, startTask, taskInput, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

test('没有项目时说「创建项目」：出现选择文件夹卡片；取消选择不建空项目；选定后项目加载到当前对话和侧栏', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-create-project-'))
  const model = await startScriptedModel([{ text: '在项目里做完了' }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await expect(window.getByTestId('project-path')).toContainText('无项目')
    await expect(window.getByTestId('sidebar-project')).toHaveCount(0)

    await taskInput(window).fill('帮我创建一个项目')
    await window.getByRole('button', { name: '发送', exact: true }).click()
    const card = window.getByTestId('project-create-card')
    await expect(card).toBeVisible()
    await expect(card).toContainText('选择项目文件夹')
    // 这句只是创建项目的意图，没有变成任务
    await expect(window.getByTestId('task-title')).toHaveCount(0)
    await expect(window.getByTestId('sidebar-project')).toHaveCount(0)

    // 系统选择框里点取消：不建项目，卡片和草稿都还在，给出可继续的提示
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = (async () => ({ canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog
    })
    await card.getByRole('button', { name: '选择项目文件夹…' }).click()
    await expect(window.getByRole('status').filter({ hasText: '没有选择文件夹' })).toBeVisible()
    await expect(card).toBeVisible()
    await expect(window.getByTestId('sidebar-project')).toHaveCount(0)
    await expect(taskInput(window)).toHaveValue('帮我创建一个项目')

    // 卡片上的取消：不创建项目，对话和草稿保持原样
    await card.getByRole('button', { name: '取消', exact: true }).click()
    await expect(card).toHaveCount(0)
    await expect(window.getByRole('status').filter({ hasText: '已取消创建项目' })).toBeVisible()
    await expect(window.getByTestId('project-path')).toContainText('无项目')
    await expect(taskInput(window)).toHaveValue('帮我创建一个项目')

    // 再触发一次并选定文件夹：项目加载到当前对话、出现在侧栏，能直接继续发任务
    await window.getByRole('button', { name: '发送', exact: true }).click()
    await expect(card).toBeVisible()
    await answerOpenDialog(app, project)
    await card.getByRole('button', { name: '选择项目文件夹…' }).click()
    await expect(window.getByTestId('project-path')).toContainText(basename(project))
    await expect(window.getByTestId('sidebar-project-row').filter({ hasText: basename(project) })).toHaveCount(1)
    await startTask(window, '在刚创建的项目里做事')
    await waitTaskDone(window)
    await expect(window.getByTestId('sidebar-task')).toContainText('在刚创建的项目里做事')
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
