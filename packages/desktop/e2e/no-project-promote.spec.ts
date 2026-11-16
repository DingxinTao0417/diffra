import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { addFile, startScriptedModel } from './scripted-model'

// 无项目任务转成正式项目（v2 · M11）：原地转换，文件夹不动；之后按项目对待
test('无项目任务转成正式项目：确认后侧栏归到它自己的项目分组，任务菜单有项目设置，文件夹位置不变，重启后还是项目', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const model = await startScriptedModel([{ toolCalls: [addFile('README.md', '# 小工具\n')] }, { text: '建好了' }])
  let app = await launchApp(userDataDir)
  try {
    let window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await startTask(window, '写个小工具')
    await waitTaskDone(window)
    const root = join(userDataDir, 'workspace')
    const [folder] = readdirSync(root)
    expect(readFileSync(join(root, folder!, 'README.md'), 'utf8')).toContain('小工具')
    const groups = window.getByTestId('sidebar-project')
    await expect(groups).toHaveCount(1)
    await expect(groups).toContainText('无项目')

    // 任务菜单：无项目任务没有「项目设置」，有「转成正式项目…」
    const menu = window.locator('header').getByRole('button', { name: '任务菜单' })
    await menu.click()
    await expect(window.getByRole('menuitem', { name: '项目设置' })).toHaveCount(0)
    await window.getByRole('menuitem', { name: '转成正式项目…' }).click()
    const dialog = window.getByTestId('promote-task')
    await expect(dialog).toContainText(folder!)
    await dialog.getByRole('button', { name: '转成正式项目' }).click()
    await expect(window.getByText('已转成正式项目，文件夹位置没变')).toBeVisible()

    // 侧栏归到以文件夹命名的项目分组；菜单里有项目设置；文件夹没动
    await expect(groups.filter({ hasText: '无项目' })).toHaveCount(0)
    await expect(groups.filter({ hasText: folder! })).toHaveCount(1)
    await menu.click()
    await expect(window.getByRole('menuitem', { name: '项目设置' })).toBeVisible()
    await expect(window.getByRole('menuitem', { name: '转成正式项目…' })).toHaveCount(0)
    await window.keyboard.press('Escape')
    expect(readdirSync(root)).toEqual([folder])

    // 重启后还是项目
    await app.close()
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await expect(window.getByTestId('sidebar-project').filter({ hasText: folder! })).toHaveCount(1, { timeout: 15_000 })
    await expect(window.getByTestId('sidebar-project').filter({ hasText: '无项目' })).toHaveCount(0)
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
