import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { lastToolResult, type ScriptMessages, startScriptedModel } from './scripted-model'

test('设置 → 浏览器：选默认浏览器、管直接打开和不让打开的网站（存进设置，交给 core）；禁止的网站不问直接拒绝，允许的不问；智能体按指令换到 Chrome 先问，扩展没连上就不换；面板上能给单个任务换浏览器，扩展没连上时说明并能改回内置', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-browser-settings-'))
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'browser_navigate', input: { url: 'https://blocked.example.com/page' } }] },
    { toolCalls: [{ name: 'browser_navigate', input: { url: 'https://allowed.invalid/' } }] },
    { toolCalls: [{ name: 'browser_switch', input: { browser: 'chrome' } }] },
    { text: '试过了' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })

    await window.getByTestId('sidebar').getByRole('button', { name: '设置', exact: true }).click()
    await window.getByRole('navigation', { name: '设置分区' }).getByRole('button', { name: '浏览器与电脑操控' }).click()
    await expect(window.getByRole('heading', { name: '浏览器与电脑操控', exact: true })).toBeVisible()
    // 没装扩展：两个浏览器都是未连接
    await expect(window.getByText('Chrome 扩展')).toBeVisible()
    await expect(window.getByText('未连接')).toHaveCount(2)
    // 网站名单：粘贴整个网址也只记主机名
    await window.getByLabel('添加到「不让打开」').fill('https://example.com/some/path')
    await window.getByLabel('添加到「不让打开」').press('Enter')
    await window.getByLabel('添加到「直接打开」').fill('allowed.invalid')
    await window.getByRole('button', { name: '添加' }).first().click()
    await expect(window.getByRole('list', { name: '不让打开' })).toContainText('example.com')
    await expect(window.getByRole('list', { name: '直接打开' })).toContainText('allowed.invalid')
    await window.getByRole('radio', { name: '我的 Edge' }).click()
    await expect(window.getByRole('radio', { name: '我的 Edge' })).toHaveAttribute('aria-checked', 'true')
    await expect
      .poll(() => (JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')) as { browser: unknown }).browser)
      .toEqual({ agent: 'edge', allowSites: ['allowed.invalid'], blockSites: ['example.com'] })
    await window.screenshot({ path: 'test-results/browser-settings.png' })
    await window.getByRole('radio', { name: '内置浏览器' }).click()
    await window.getByRole('button', { name: '返回' }).click()

    // 禁止的网站（含子域名）不问直接拒绝；允许的网站不问就去开（这个域名打不开，报错是浏览器的）
    await chooseProject(app, window, project)
    await startTask(window, '打开两个网站，再换到我的 Chrome')
    // 打开网站都没问；换到用户的 Chrome 要问
    const permission = window.getByTestId('permission-card')
    await expect(permission).toContainText('让智能体改用你的 Chrome（会用你在那里的登录状态）', { timeout: 30_000 })
    await permission.getByRole('button', { name: '允许一次' }).click()
    await waitTaskDone(window, 30_000)
    const results = model.bodies().map((body) => lastToolResult((JSON.parse(body) as { messages: ScriptMessages }).messages) ?? '')
    expect(results[1]).toContain('The user blocked blocked.example.com')
    expect(results[2]).toContain('打不开 https://allowed.invalid/')
    expect(results[3]).toContain('extension is not connected')

    // 面板上给这个任务换成 Chrome：扩展没连上，说明怎么装，能改回内置浏览器
    const panel = window.getByTestId('browser-panel')
    await expect(panel).toBeVisible()
    await panel.getByRole('button', { name: '智能体用的浏览器：内置浏览器' }).click()
    await window.getByRole('menuitemradio', { name: '我的 Chrome' }).click()
    await expect(panel).toContainText('Chrome 里的 Diffra 扩展没有连上')
    await panel.getByRole('button', { name: '改用内置浏览器' }).click()
    await expect(panel.getByRole('button', { name: '智能体用的浏览器：内置浏览器' })).toBeVisible()
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
