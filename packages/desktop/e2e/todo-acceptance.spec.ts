import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

test('待办派出的任务完成后，对话里出验收卡片，验收后待办同步完成', async () => {
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-todo-acceptance-'))
  const model = await startScriptedModel([{ text: '这件事做完了' }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)

    await window.getByTestId('sidebar').getByRole('button', { name: '待办', exact: true }).click()
    const input = window.getByLabel('新待办')
    await input.fill('验收测试待办')
    await input.press('Enter')
    const row = window.getByTestId('todo-row').filter({ hasText: '验收测试待办' })
    await row.hover()
    await row.getByRole('button', { name: '发送给任务' }).click()
    const dialog = window.getByTestId('send-todos')
    await dialog.getByRole('button', { name: '发送', exact: true }).click()
    await waitTaskDone(window)

    // 任务做完后，对话底部出现这个待办的验收卡片
    const card = window.getByTestId('todo-acceptance')
    await expect(card).toBeVisible()
    await expect(card).toContainText('待办待验收')
    await expect(card).toContainText('验收测试待办')
    await expect(window.getByTestId('sidebar-todo-count')).toHaveText('1')

    await card.getByRole('button', { name: '验收并完成' }).click()
    await expect(card).toHaveCount(0)
    await expect(window.getByTestId('sidebar-todo-count')).toHaveCount(0)

    // 待办页里它从待办列表消失，在已完成的列表里标成已验收
    await window.getByTestId('sidebar').getByRole('button', { name: '待办', exact: true }).click()
    await expect(window.getByTestId('todo-row')).toHaveCount(0)
    await window.getByRole('button', { name: /已完成 1/ }).click()
    const done = window.getByTestId('todo-row').filter({ hasText: '验收测试待办' })
    await expect(done).toBeVisible()
    await expect(done.getByTestId('todo-accepted')).toHaveText('已验收')
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
