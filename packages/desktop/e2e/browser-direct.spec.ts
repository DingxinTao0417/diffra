import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, expect, test } from '@playwright/test'
import { chooseProject, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { lastToolResult, type ScriptMessages, startScriptedModel } from './scripted-model'

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>直连页</title></head><body><h1>DIRECT-CHROME-OK</h1></body></html>'

// 「系统 Chrome」换成 Playwright 的 Chromium（无头），数据目录里的 DevToolsActivePort 就是它开的调试端口
const activePort = (userDataDir: string) => Number(readFileSync(join(userDataDir, 'system-chrome', 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0])
const targets = async (port: number) => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; url: string }>

test('浏览器：Chrome 选「直接启动」时不用扩展，启动系统 Chrome（Diffra 单独的配置）；智能体在里面打开、读网页，面板上看投屏、开开发者工具；关掉 Diffra 时 Chrome 跟着关', async () => {
  test.setTimeout(150_000)
  const userDataDir = makeUserDataDir()
  const workspace = mkdtempSync(join(tmpdir(), 'diffra-e2e-direct-'))
  const project = join(workspace, 'project')
  execFileSync('git', ['init', '-q', project])
  writeFileSync(join(project, 'README.md'), '项目')
  const site = createServer((_request, response) => response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE))
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`
  const model = await startScriptedModel([{ toolCalls: [{ name: 'browser_navigate', input: { url } }] }, { toolCalls: [{ name: 'browser_get_text', input: {} }] }, { text: '读到了' }])
  const app = await launchApp(userDataDir, { DIFFRA_SYSTEM_CHROME: chromium.executablePath(), DIFFRA_SYSTEM_CHROME_ARGS: '--headless=new' })
  let port = 0
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await window.getByTestId('sidebar').getByRole('button', { name: '设置', exact: true }).click()
    await window.getByRole('navigation', { name: '设置分区' }).getByRole('button', { name: '浏览器与电脑操控' }).click()
    await window.getByRole('radio', { name: '我的 Chrome' }).click()
    await window.getByRole('radio', { name: '直接启动' }).click()
    const status = window.getByTestId('direct-chrome-status')
    await expect(status).toContainText('用到时启动')
    await expect.poll(() => (JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')) as { browser: unknown }).browser).toMatchObject({ agent: 'chrome', chromeDirect: true })
    await window.screenshot({ path: 'test-results/browser-direct-settings.png' })
    await window.getByRole('button', { name: '返回' }).click()

    await chooseProject(app, window, project)
    await startTask(window, '打开本地页面看看写了什么')
    await waitTaskDone(window, 60_000)
    expect(model.bodies().some((body) => lastToolResult((JSON.parse(body) as { messages: ScriptMessages }).messages)?.includes('DIRECT-CHROME-OK'))).toBe(true)
    port = activePort(userDataDir)
    expect((await targets(port)).some((target) => target.type === 'page' && target.url === url)).toBe(true)

    // 面板：系统 Chrome 的投屏；开发者工具在那个 Chrome 里打开检查器
    const panel = window.getByTestId('browser-panel')
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('button', { name: '智能体用的浏览器：Chrome' })).toBeVisible()
    await expect(window.getByTestId('browser-mirror')).toHaveAttribute('src', /^data:image\/jpeg;base64,/, { timeout: 15_000 })
    await panel.getByRole('button', { name: '开发者工具' }).click()
    await expect.poll(async () => (await targets(port)).some((target) => target.url.includes('/devtools/inspector.html'))).toBe(true)

    // 设置里显示在运行
    await window.getByTestId('sidebar').getByRole('button', { name: '设置', exact: true }).click()
    await window.getByRole('navigation', { name: '设置分区' }).getByRole('button', { name: '浏览器与电脑操控' }).click()
    await expect(status).toContainText('运行中')
  } finally {
    await app.close()
    // 关掉 Diffra 时 Chrome 也关了：调试端口连不上
    if (port) await expect.poll(() => fetch(`http://127.0.0.1:${port}/json/version`).then(() => 'open', () => 'closed'), { timeout: 15_000 }).toBe('closed')
    await model.close()
    site.close()
    rmSync(workspace, { recursive: true, force: true })
    // Chrome 的子进程（崩溃收集这些）比主进程晚退出一会儿，配置目录要等它们放手
    await expect
      .poll(
        () => {
          try {
            rmSync(userDataDir, { recursive: true, force: true })
            return true
          } catch {
            return false
          }
        },
        { timeout: 20_000 },
      )
      .toBe(true)
  }
})
