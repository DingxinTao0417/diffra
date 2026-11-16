import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, expect, type Page, test } from '@playwright/test'
import { answerOpenDialog, chooseProject, startTask, waitTaskDone } from './flows'
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

// 下面几个用例共用：本地网页、打开设置里的「浏览器与电脑操控」、删配置目录（等 Chrome 的子进程放手）
async function localSite() {
  const site = createServer((_request, response) => response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE))
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
  return { site, url: `http://127.0.0.1:${(site.address() as AddressInfo).port}/` }
}

async function openBrowserSettings(window: Page) {
  await window.getByTestId('sidebar').getByRole('button', { name: '设置', exact: true }).click()
  await window.getByRole('navigation', { name: '设置分区' }).getByRole('button', { name: '浏览器与电脑操控' }).click()
}

async function removeWhenReleased(dir: string) {
  await expect
    .poll(
      () => {
        try {
          rmSync(dir, { recursive: true, force: true })
          return true
        } catch {
          return false
        }
      },
      { timeout: 20_000 },
    )
    .toBe(true)
}

const readModel = (url: string) => [{ toolCalls: [{ name: 'browser_navigate', input: { url } }] }, { toolCalls: [{ name: 'browser_get_text', input: {} }] }, { text: '读到了' }]
const sawPage = (model: { bodies(): string[] }) => model.bodies().some((body) => lastToolResult((JSON.parse(body) as { messages: ScriptMessages }).messages)?.includes('DIRECT-CHROME-OK'))
const settingsFile = (userDataDir: string) => JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')) as { browser: Record<string, unknown> }

test('浏览器：直接启动的 Chrome 没找到时，这个任务改用内置浏览器，面板和模型都知道原因；设置里能关掉面板上的开发者工具', async () => {
  test.setTimeout(120_000)
  const userDataDir = makeUserDataDir()
  const workspace = mkdtempSync(join(tmpdir(), 'diffra-e2e-direct-fallback-'))
  const project = join(workspace, 'project')
  execFileSync('git', ['init', '-q', project])
  writeFileSync(join(project, 'README.md'), '项目')
  const { site, url } = await localSite()
  const model = await startScriptedModel(readModel(url))
  // 指到一个不存在的程序：当作这台电脑没装 Chrome
  const app = await launchApp(userDataDir, { DIFFRA_SYSTEM_CHROME: join(workspace, 'no-chrome.exe') })
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await openBrowserSettings(window)
    await window.getByRole('radio', { name: '我的 Chrome' }).click()
    await window.getByRole('radio', { name: '直接启动' }).click()
    await expect(window.getByTestId('direct-chrome-status')).toContainText('没找到 Chrome')
    await window.getByRole('button', { name: '返回' }).click()

    await chooseProject(app, window, project)
    await startTask(window, '打开本地页面看看写了什么')
    await waitTaskDone(window, 60_000)
    // 内置浏览器读到了页面；模型知道换了浏览器、为什么
    expect(sawPage(model)).toBe(true)
    expect(model.bodies().some((body) => body.includes('uses Diffra') && body.includes('built-in browser instead'))).toBe(true)
    const panel = window.getByTestId('browser-panel')
    await expect(window.getByTestId('browser-fallback')).toContainText('没找到 Chrome、Edge 或 Chromium')
    await expect(panel.getByRole('button', { name: '智能体用的浏览器：内置浏览器' })).toBeVisible()
    await expect(panel.getByRole('button', { name: '开发者工具' })).toBeVisible()
    await window.screenshot({ path: 'test-results/browser-direct-fallback.png' })

    // 关掉开发者工具：面板上不再有这个按钮
    await openBrowserSettings(window)
    await window.getByRole('switch', { name: '浏览器面板上的开发者工具' }).click()
    await expect.poll(() => settingsFile(userDataDir).browser.devTools).toBe(false)
    await window.getByRole('button', { name: '返回' }).click()
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('button', { name: '开发者工具' })).toHaveCount(0)
  } finally {
    await app.close()
    await model.close()
    site.close()
    rmSync(workspace, { recursive: true, force: true })
    await removeWhenReleased(userDataDir)
  }
})

test('浏览器：直接启动时能自己选浏览器程序，选了就用它；能改回自动找', async () => {
  test.setTimeout(150_000)
  const userDataDir = makeUserDataDir()
  const workspace = mkdtempSync(join(tmpdir(), 'diffra-e2e-direct-custom-'))
  const project = join(workspace, 'project')
  execFileSync('git', ['init', '-q', project])
  writeFileSync(join(project, 'README.md'), '项目')
  const { site, url } = await localSite()
  const model = await startScriptedModel(readModel(url))
  const custom = chromium.executablePath()
  // 不给测试用的「系统 Chrome」：没选程序时会去找本机装的，选了就只用选的（Playwright 的 Chromium，无头）
  const app = await launchApp(userDataDir, { DIFFRA_SYSTEM_CHROME_ARGS: '--headless=new' })
  let port = 0
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await openBrowserSettings(window)
    await window.getByRole('radio', { name: '我的 Chrome' }).click()
    await window.getByRole('radio', { name: '直接启动' }).click()
    await answerOpenDialog(app, custom)
    await window.getByRole('button', { name: '选择程序…' }).click()
    await expect(window.getByTestId('direct-chrome-hint')).toContainText(`用你选的程序（Chrome）：${custom}`)
    await expect.poll(() => settingsFile(userDataDir).browser.chromePath).toBe(custom)
    await window.screenshot({ path: 'test-results/browser-direct-custom.png' })
    await window.getByRole('button', { name: '返回' }).click()

    await chooseProject(app, window, project)
    await startTask(window, '打开本地页面看看写了什么')
    await waitTaskDone(window, 60_000)
    expect(sawPage(model)).toBe(true)
    port = activePort(userDataDir)
    expect((await targets(port)).some((target) => target.type === 'page' && target.url === url)).toBe(true)

    await openBrowserSettings(window)
    await expect(window.getByTestId('direct-chrome-status')).toContainText('运行中')
    await window.getByRole('button', { name: '改回自动找' }).click()
    await expect.poll(() => settingsFile(userDataDir).browser.chromePath).toBeNull()
    await expect(window.getByTestId('direct-chrome-hint')).toContainText('自动找到的')
  } finally {
    await app.close()
    if (port) await expect.poll(() => fetch(`http://127.0.0.1:${port}/json/version`).then(() => 'open', () => 'closed'), { timeout: 15_000 }).toBe('closed')
    await model.close()
    site.close()
    rmSync(workspace, { recursive: true, force: true })
    await removeWhenReleased(userDataDir)
  }
})

// 本机装的 Chrome、Edge，和应用里找的顺序一样
function installedChrome(): string | null {
  const candidates: string[] = []
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter((root): root is string => Boolean(root))
    for (const root of roots) candidates.push(join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    for (const root of roots) candidates.push(join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
  }
  return candidates.find((path) => existsSync(path)) ?? null
}

test('浏览器：用本机装的 Chrome（没有就用 Edge）直接启动，Diffra 单独的配置、无头；打开、读网页，开发者工具打开检查器；关掉 Diffra 时跟着关', async () => {
  const installed = installedChrome()
  test.skip(!installed, '本机没装 Chrome 或 Edge')
  test.setTimeout(150_000)
  const userDataDir = makeUserDataDir()
  const workspace = mkdtempSync(join(tmpdir(), 'diffra-e2e-direct-real-'))
  const project = join(workspace, 'project')
  execFileSync('git', ['init', '-q', project])
  writeFileSync(join(project, 'README.md'), '项目')
  const { site, url } = await localSite()
  const model = await startScriptedModel(readModel(url))
  // 配置目录在测试数据目录里，不碰用户平时的配置；无头，不弹窗口
  const app = await launchApp(userDataDir, { DIFFRA_SYSTEM_CHROME_ARGS: '--headless=new' })
  let port = 0
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await openBrowserSettings(window)
    await window.getByRole('radio', { name: '我的 Chrome' }).click()
    await window.getByRole('radio', { name: '直接启动' }).click()
    await expect(window.getByTestId('direct-chrome-hint')).toContainText(installed!)
    await window.getByRole('button', { name: '返回' }).click()

    await chooseProject(app, window, project)
    await startTask(window, '打开本地页面看看写了什么')
    await waitTaskDone(window, 60_000)
    expect(sawPage(model)).toBe(true)
    port = activePort(userDataDir)
    const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { Browser: string }
    expect(version.Browser).toMatch(/Chrome|Edg/)
    expect((await targets(port)).some((target) => target.type === 'page' && target.url === url)).toBe(true)
    const panel = window.getByTestId('browser-panel')
    await expect(window.getByTestId('browser-mirror')).toHaveAttribute('src', /^data:image\/jpeg;base64,/, { timeout: 15_000 })
    await panel.getByRole('button', { name: '开发者工具' }).click()
    await expect.poll(async () => (await targets(port)).some((target) => target.url.includes('/devtools/inspector.html'))).toBe(true)
    await window.screenshot({ path: 'test-results/browser-direct-real.png' })
    console.log(`本机浏览器：${installed} · ${version.Browser}`)
  } finally {
    await app.close()
    if (port) await expect.poll(() => fetch(`http://127.0.0.1:${port}/json/version`).then(() => 'open', () => 'closed'), { timeout: 15_000 }).toBe('closed')
    await model.close()
    site.close()
    rmSync(workspace, { recursive: true, force: true })
    await removeWhenReleased(userDataDir)
  }
})
