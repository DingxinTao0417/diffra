import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, taskInput, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

test('底部终端：在项目目录开 shell、多个标签、收起再打开、进程退出', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-terminal-'))
  const model = await startScriptedModel([{ text: '好' }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '开个终端')
    await waitTaskDone(window)

    await window.getByRole('button', { name: '终端 Ctrl+`' }).click()
    const host = window.getByTestId('terminal-host')
    const tabs = window.getByTestId('terminal-tab')
    await expect(tabs).toHaveCount(1)
    await expect(tabs).toContainText(basename(project))
    await host.click()
    await window.keyboard.type("Write-Output ('term' + '-ok-' + (6*7)); (Get-Location).Path")
    await window.keyboard.press('Enter')
    await expect(host).toContainText('term-ok-42', { timeout: 20_000 })
    await expect(host).toContainText(basename(project))

    // 焦点在终端里时 Ctrl+K 留给 shell，不弹搜索
    await window.keyboard.press('Control+k')
    await window.waitForTimeout(300)
    await expect(window.getByRole('textbox', { name: '搜索任务' })).toHaveCount(0)

    await window.getByRole('button', { name: '新建终端' }).click()
    await expect(tabs).toHaveCount(2)
    await tabs.nth(1).getByRole('button', { name: '关闭终端' }).click()
    await expect(tabs).toHaveCount(1)

    // Ctrl+` 收起再打开，之前的输出还在
    await host.click()
    await window.keyboard.press('Control+`')
    await expect(window.getByTestId('terminal-panel')).toHaveCount(0)
    await window.keyboard.press('Control+`')
    await expect(host).toContainText('term-ok-42')
    await window.screenshot({ path: 'test-results/terminal.png' })

    await host.click()
    await window.keyboard.type('exit')
    await window.keyboard.press('Enter')
    await expect(tabs).toContainText('已退出', { timeout: 15_000 })

    // 焦点不在终端时 Ctrl+K 照常弹搜索
    await taskInput(window).click()
    await window.keyboard.press('Control+k')
    await expect(window.getByRole('textbox', { name: '搜索任务' })).toBeVisible()
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})
