import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { addFile, startScriptedModel } from './scripted-model'

// 第 534–536 步：回答里的网址默认在内置浏览器打开、右键能换系统浏览器；项目里的文件显示成文件引用，
// 改过的点了看审阅，没改过的在右侧文件预览里定位到那一行；右键有查看、打开、复制、在资源管理器中显示
test('回答里的链接和文件：链接走内置浏览器、右键换系统浏览器；文件引用高亮，点了看改动或预览到那一行，右键能复制', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-answer-links-'))
  mkdirSync(join(project, 'src'))
  writeFileSync(join(project, 'README.md'), '# 待办\n\n一个小的待办网页。\n')
  writeFileSync(join(project, 'src', 'store.js'), Array.from({ length: 60 }, (_, index) => `export const value${index + 1} = ${index + 1}`).join('\n') + '\n')
  const site = createServer((_request, response) => response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<title>文档</title><h1>本地文档页</h1>'))
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
  const siteUrl = `http://localhost:${(site.address() as AddressInfo).port}/`
  const model = await startScriptedModel([
    { toolCalls: [addFile('src/api.js', 'export const api = 1\n')] },
    {
      text: [
        `- 新增的接口在 \`src/api.js\`，原来的数据在 \`src/store.js:42\`，说明见 [README](README.md#L3)`,
        `- 文档页在 [本地文档](${siteUrl})`,
        '- `nope.ts` 不存在，`Promise.all` 和 `npm test` 也不是文件',
      ].join('\n'),
    },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '加个接口')
    await waitTaskDone(window)
    const answer = window.getByTestId('agent-message').last()
    const refs = answer.getByTestId('file-reference')
    await expect(refs).toHaveCount(3)
    await expect(refs.nth(0)).toContainText('src/api.js')
    await expect(refs.nth(1)).toContainText('src/store.js:42')
    await expect(refs.nth(2)).toContainText('README')
    // 不在项目里的、不像文件的照常是行内代码
    await expect(answer.locator('code').filter({ hasText: 'nope.ts' })).toHaveCount(1)

    // 改过的文件：右侧审阅定位到它
    await refs.nth(0).click()
    await expect(window.getByTestId('review-panel')).toBeVisible()
    await expect(window.locator('[data-testid="review-file"][data-path="src/api.js"]')).toBeInViewport()
    // 没改过的文件：右侧文件预览定位并高亮那一行
    await refs.nth(1).click()
    const row = window.getByTestId('file-panel').locator('[data-line="42"]')
    await expect(row).toContainText('export const value42 = 42')
    await expect(row).toHaveClass(/bg-accent/)
    await expect(row).toBeInViewport()
    // Markdown 链接写的 README.md#L3 也按文件打开到第 3 行
    await refs.nth(2).click()
    await expect(window.getByTestId('file-panel').locator('[data-line="3"]')).toHaveClass(/bg-accent/)

    // 文件右键：五项；复制路径、复制文件内容进剪贴板
    await refs.nth(1).click({ button: 'right' })
    const menu = window.getByRole('menu')
    for (const name of ['在右侧栏查看', '用默认应用打开', '复制路径', '复制文件内容', '在资源管理器中显示']) await expect(menu.getByRole('menuitem', { name })).toBeVisible()
    await menu.getByRole('menuitem', { name: '复制路径' }).click()
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(join(project, 'src', 'store.js'))
    await refs.nth(1).click({ button: 'right' })
    await window.getByRole('menu').getByRole('menuitem', { name: '复制文件内容' }).click()
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('export const value60 = 60')

    // 链接：右键三项，复制链接；左键在内置浏览器里打开
    const link = answer.getByRole('link', { name: '本地文档' })
    await link.click({ button: 'right' })
    for (const name of ['在内置浏览器打开', '用系统浏览器打开', '复制链接']) await expect(window.getByRole('menu').getByRole('menuitem', { name })).toBeVisible()
    await window.getByRole('menu').getByRole('menuitem', { name: '复制链接' }).click()
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(siteUrl)
    await link.click()
    await expect(window.getByTestId('browser-panel')).toBeVisible()
  } finally {
    await app.close()
    await model.close()
    site.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
