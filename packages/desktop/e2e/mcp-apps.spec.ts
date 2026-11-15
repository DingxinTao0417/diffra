import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, openExtensions, startTask, taskInput, waitTaskDone } from './flows'
import { desktopDir, launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

// core 单测也用的带界面的测试服务器：ui_card（结果里内嵌 ui:// HTML）、ui_weather（工具定义 _meta 指向 ui:// 资源，MCP Apps 的写法）
const MCP_UI_SERVER = resolve(desktopDir, '../core/test/fixtures/mcp-ui-server.mjs')

// 第 683 步：MCP 工具带的界面在对话里画成卡片
test('MCP 工具带的界面：内嵌的 HTML 和 _meta 指的资源都画成卡片；MCP Apps 握手后收到参数和结果；能把一句话填进输入框；替它调工具被拒；HTML 不给模型', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-mcp-apps-'))
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'mcp__ui__ui_card', input: {} }] },
    { toolCalls: [{ name: 'mcp__ui__ui_weather', input: { city: '杭州' } }] },
    { text: '都显示好了' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await openExtensions(window, '已安装')
    await window.getByRole('button', { name: '手动添加' }).click()
    const dialog = window.getByRole('dialog')
    await dialog.getByLabel('名称').fill('ui')
    await dialog.getByLabel('命令').fill(process.execPath)
    await dialog.getByLabel('参数').fill(MCP_UI_SERVER)
    await dialog.getByRole('button', { name: '保存' }).click()
    await expect(dialog).toBeHidden()
    await expect(window.getByTestId('mcp-server-card').getByTestId('mcp-status')).toHaveText('已连接', { timeout: 30_000 })

    await window.getByTestId('sidebar').getByRole('button', { name: '新任务' }).click()
    await chooseProject(app, window, project)
    await startTask(window, '显示一下')
    await waitTaskDone(window)

    const apps = window.getByTestId('mcp-app')
    await expect(apps).toHaveCount(2)
    await expect(apps.nth(0)).toContainText('来自 MCP 服务器 ui')
    await expect(apps.nth(0).locator('iframe').contentFrame().locator('#card')).toHaveText('MCP 卡片的界面')

    const weather = apps.nth(1).locator('iframe').contentFrame()
    await expect(weather.locator('#weather')).toHaveText('杭州 21度')
    await expect(weather.locator('body')).toHaveAttribute('data-host', 'Diffra')
    await expect(weather.locator('body')).toHaveAttribute('data-input', JSON.stringify({ city: '杭州' }))
    await expect(weather.locator('body')).toHaveAttribute('data-tools-call', 'refused')
    await apps.nth(1).screenshot({ path: 'test-results/mcp-app.png' })
    await weather.getByRole('button', { name: '问问明天' }).click()
    await expect(taskInput(window)).toHaveValue(/^MCP 工具「ui_weather」的界面里说：\n> 明天会下雨吗？/)

    // 界面的 HTML 不给模型
    expect(model.bodies()[1]).toContain('[界面 ui://diffra-test/card，显示给用户了]')
    expect(model.bodies()[1]).not.toContain('MCP 卡片的界面')
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
