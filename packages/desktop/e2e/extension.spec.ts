import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type BrowserContext, chromium, expect, type Page, test } from '@playwright/test'
import { chooseProject, startTask, taskInput, waitTaskDone, waitTaskStatus } from './flows'
import { desktopDir, launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { EXTENSION_IDS } from '../src/shared/browser-bridge'
import { lastToolResult, type ScriptMessages, startScriptedModel } from './scripted-model'

const EXTENSION_DIR = join(desktopDir, 'out', 'browser-extension')
const POPUP_URL = `chrome-extension://${EXTENSION_IDS.development}/popup.html`
const TEST_HOST = 'dev.diffra.browser_test'

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>扩展测试页</title></head><body>
<label for="name">名字</label><input id="name">
<button onclick="document.getElementById('out').textContent = '你好，' + document.getElementById('name').value">打招呼</button>
<p id="out"></p>
</body></html>`

// 用户自己开的页面，后面在扩展里交给任务
const SHARED_PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>交给你的页面</title></head><body><p>这是用户自己开的页面</p></body></html>'

// 整页一个颜色，看面板画面是哪个标签页
const COLORS = { red: '#e00000', blue: '#0000e0', green: '#00b000' } as const
type Color = keyof typeof COLORS
const colorPage = (color: Color) => `<!doctype html><html><head><meta charset="utf-8"><title>${color} 页</title></head><body style="margin:0;height:100vh;background:${COLORS[color]}"><p>${color}</p></body></html>`

async function startSite() {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    const color = request.url?.match(/^\/color\/(red|blue|green)$/)?.[1] as Color | undefined
    response.end(color ? colorPage(color) : request.url === '/shared' ? SHARED_PAGE : PAGE)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` }
}

const refOf = (label: string) => (messages: ScriptMessages) => {
  const match = lastToolResult(messages).match(new RegExp(`${label}[^\\n]*?\\[ref=(e\\d+)\\]`))
  if (!match) throw new Error(`没找到 ${label} 的 ref`)
  return match[1]
}

// 装着 Diffra 浏览器扩展的 Chromium（Playwright 的 Chrome for Testing，正式版 Chrome 不让命令行加载扩展）
async function launchBrowser(profile: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    // Playwright 默认让后台标签页照样渲染；用户的 Chrome 不会，去掉才测得出后台标签页没画面
    ignoreDefaultArgs: ['--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'],
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  })
}

async function bridgeConnections(window: Page): Promise<number> {
  return window.evaluate<number>('window.diffra.getBrowserBridgeStatus().then((status) => status.connections.length)')
}

// 面板投屏画面中间那个点是什么颜色
async function mirrorColor(window: Page): Promise<Color | 'none'> {
  const rgb = await window.evaluate<number[] | null>(`new Promise((resolve) => {
    const mirror = document.querySelector('[data-testid="browser-mirror"]')
    if (!mirror) return resolve(null)
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const context = canvas.getContext('2d')
      context.drawImage(image, 0, 0)
      resolve([...context.getImageData(Math.floor(image.width / 2), Math.floor(image.height / 2), 1, 1).data].slice(0, 3))
    }
    image.onerror = () => resolve(null)
    image.src = mirror.src
  })`)
  if (!rgb) return 'none'
  const [r = 0, g = 0, b = 0] = rgb
  if (r > 150 && g < 80 && b < 80) return 'red'
  if (b > 150 && r < 80 && g < 80) return 'blue'
  if (g > 120 && r < 80 && b < 80) return 'green'
  return 'none'
}

function removeTestHost(): void {
  // 测试用的宿主登记指向已经删掉的临时目录，删掉
  for (const root of ['HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts', 'HKCU\\Software\\Chromium\\NativeMessagingHosts']) {
    spawnSync('reg.exe', ['delete', `${root}\\dev.diffra.browser_test`, '/f'], { windowsHide: true })
  }
}

test('用户自己的浏览器：设置成 Chrome 后，智能体经扩展在浏览器里开「Diffra · 任务名」分组的标签页，读页面、输入、点击；面板上看得到画面；用户在扩展里把自己的标签页交给任务；在扩展里停下任务', async () => {
  test.setTimeout(120_000)
  const userDataDir = makeUserDataDir()
  const profile = mkdtempSync(join(tmpdir(), 'diffra-e2e-chromium-'))
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-extension-'))
  // 设置里选好让智能体用 Chrome
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, providers: [], roles: { coder: null, planner: null, reviewer: null, fallback: null }, browser: { agent: 'chrome', allowSites: [], blockSites: [] } }))
  const site = await startSite()
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'browser_navigate', input: { url: site.url } }] },
    { toolCalls: [{ name: 'browser_snapshot', input: {} }] },
    { toolCalls: [{ name: 'browser_type', input: (messages: ScriptMessages) => ({ ref: refOf('textbox "名字"')(messages), text: '小明' }) }] },
    { toolCalls: [{ name: 'browser_snapshot', input: {} }] },
    { toolCalls: [{ name: 'browser_click', input: (messages: ScriptMessages) => ({ ref: refOf('button "打招呼"')(messages) }) }] },
    { toolCalls: [{ name: 'browser_get_text', input: {} }] },
    { toolCalls: [{ name: 'browser_tabs', input: { action: 'list' } }] },
    { text: '在 Chrome 里做完了' },
    // 第二轮：用户在扩展里交过来一个标签页，它成了当前标签页
    { toolCalls: [{ name: 'browser_tabs', input: { action: 'list' } }] },
    { toolCalls: [{ name: 'browser_get_text', input: {} }] },
    { text: '看到你给的页面了' },
    // 第三轮：慢慢想的时候用户在扩展里点了停止
    { text: '想好了', delayMs: 30_000 },
  ])
  const app = await launchApp(userDataDir, { DIFFRA_BROWSER_HOST_TARGETS: 'chrome,chromium', DIFFRA_BROWSER_HOST: 'test' })
  let browser: BrowserContext | null = null
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    browser = await launchBrowser(profile)
    await expect.poll(() => bridgeConnections(window), { timeout: 20_000 }).toBe(1)

    await chooseProject(app, window, project)
    await startTask(window, '在我的浏览器里打招呼')
    await waitTaskDone(window, 60_000)

    const results = model.bodies().map((body) => lastToolResult((JSON.parse(body) as { messages: ScriptMessages }).messages) ?? '')
    writeFileSync('test-results/extension-results.json', JSON.stringify(results, null, 2))
    expect(results.find((result) => result.startsWith('已打开'))).toContain('扩展测试页')
    expect(results.find((result) => result.includes('你好，小明'))).toBeTruthy()
    expect(results.find((result) => result.includes('在用户 Chrome 里的标签页'))).toContain('1. [当前] 扩展测试页')

    // 浏览器里：页面上真的打了招呼，标签页在「Diffra · 任务名」分组里
    const page = browser.pages().find((item) => item.url() === site.url)!
    await expect(page.locator('#out')).toHaveText('你好，小明')
    const worker = browser.serviceWorkers()[0] ?? (await browser.waitForEvent('serviceworker'))
    const groups = await worker.evaluate<string[]>('chrome.tabGroups.query({}).then((items) => items.map((item) => item.title))')
    expect(groups).toEqual(['Diffra · 在我的浏览器里打招呼'])

    // 面板显示着时投屏：看得到画面
    await expect(window.getByTestId('browser-panel')).toBeVisible()
    await expect(window.getByTestId('browser-mirror')).toHaveAttribute('src', /^data:image\/jpeg;base64,/, { timeout: 15_000 })
    await window.screenshot({ path: 'test-results/extension-panel.png' })

    // 扩展弹窗：连着 Diffra，能看到任务
    const popup = await browser.newPage()
    await popup.goto(POPUP_URL)
    await expect(popup.locator('body')).toContainText('已连接 Diffra（测试）')
    await popup.screenshot({ path: 'test-results/extension-popup.png' })
    // 机器上可能还开着开发版 Diffra，扩展会连上不止一个宿主；只认测试宿主
    const sessionId = await popup.evaluate<string>(`chrome.runtime.sendMessage({ kind: 'state', tabId: null }).then((state) => state.links.find((link) => link.host === '${TEST_HOST}' && link.connected).tasks[0].sessionId)`)

    // 用户自己开一个页面，在扩展里交给这个任务：进了任务的分组，智能体在它上面读
    const shared = await browser.newPage()
    await shared.goto(`${site.url}shared`)
    const sharedTab = await worker.evaluate<number>(`chrome.tabs.query({ url: '${site.url}shared' }).then((tabs) => tabs[0].id)`)
    expect(await popup.evaluate<{ ok: boolean }>(`chrome.runtime.sendMessage({ kind: 'share', host: '${TEST_HOST}', tabId: ${sharedTab}, sessionId: '${sessionId}' })`)).toEqual({ ok: true })
    await taskInput(window).fill('用我交给你的页面')
    await window.getByRole('button', { name: '发送', exact: true }).click()
    await waitTaskDone(window, 30_000)
    const second = model.bodies().map((body) => lastToolResult((JSON.parse(body) as { messages: ScriptMessages }).messages) ?? '')
    expect(second.findLast((result) => result.includes('在用户 Chrome 里的标签页'))).toContain('2. [当前] 交给你的页面')
    expect(second.at(-1)).toContain('这是用户自己开的页面')
    expect(await worker.evaluate<number>(`chrome.tabs.get(${sharedTab}).then((tab) => tab.groupId)`)).toBeGreaterThan(-1)

    // 在扩展里停下正在跑的任务
    await taskInput(window).fill('慢慢想')
    await window.getByRole('button', { name: '发送', exact: true }).click()
    await expect(window.getByTestId('task-status')).toContainText('运行中', { timeout: 10_000 })
    await popup.evaluate(`chrome.runtime.sendMessage({ kind: 'stop', host: '${TEST_HOST}', sessionId: '${sessionId}' })`)
    await waitTaskStatus(window, 'stopped', 15_000)
  } finally {
    await browser?.close()
    await app.close()
    removeTestHost()
    await model.close()
    site.server.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(profile, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('用户自己的浏览器：智能体开的第二个标签页、别的窗口交过来的标签页，面板上都是它的画面；交过来的标签页留在原来的窗口', async () => {
  test.setTimeout(120_000)
  const userDataDir = makeUserDataDir()
  const profile = mkdtempSync(join(tmpdir(), 'diffra-e2e-chromium-'))
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-extension-'))
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, providers: [], roles: { coder: null, planner: null, reviewer: null, fallback: null }, browser: { agent: 'chrome', allowSites: [], blockSites: [] } }))
  const site = await startSite()
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'browser_navigate', input: { url: `${site.url}color/red` } }] },
    { toolCalls: [{ name: 'browser_tabs', input: { action: 'new', url: `${site.url}color/blue` } }] },
    { toolCalls: [{ name: 'browser_get_text', input: {} }] },
    { text: '开了两个标签页' },
    // 第二轮：用户从另一个窗口交过来一个标签页
    { toolCalls: [{ name: 'browser_get_text', input: {} }] },
    { text: '看到你给的页面了' },
  ])
  const app = await launchApp(userDataDir, { DIFFRA_BROWSER_HOST_TARGETS: 'chrome,chromium', DIFFRA_BROWSER_HOST: 'test' })
  let browser: BrowserContext | null = null
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    browser = await launchBrowser(profile)
    await expect.poll(() => bridgeConnections(window), { timeout: 20_000 }).toBe(1)

    await chooseProject(app, window, project)
    await startTask(window, '开两个标签页')
    await waitTaskDone(window, 60_000)
    expect(lastToolResult((JSON.parse(model.bodies().at(-1)!) as { messages: ScriptMessages }).messages)).toContain('blue')
    // 智能体现在用的是第二个标签页：画面是它的
    await expect(window.getByTestId('browser-panel')).toBeVisible()
    await expect.poll(() => mirrorColor(window), { timeout: 15_000 }).toBe('blue')

    // 用户在另一个窗口里开一个页面，交给这个任务
    const worker = browser.serviceWorkers()[0] ?? (await browser.waitForEvent('serviceworker'))
    const popup = await browser.newPage()
    await popup.goto(POPUP_URL)
    const sessionId = await popup.evaluate<string>(`chrome.runtime.sendMessage({ kind: 'state', tabId: null }).then((state) => state.links.find((link) => link.host === '${TEST_HOST}' && link.connected).tasks[0].sessionId)`)
    const shared = await worker.evaluate<{ tabId: number; windowId: number }>(`chrome.windows.create({ url: '${site.url}color/green', focused: true }).then((created) => ({ tabId: created.tabs[0].id, windowId: created.id }))`)
    await expect.poll(() => worker.evaluate<string>(`chrome.tabs.get(${shared.tabId}).then((tab) => tab.status)`)).toBe('complete')
    expect(await popup.evaluate<{ ok: boolean }>(`chrome.runtime.sendMessage({ kind: 'share', host: '${TEST_HOST}', tabId: ${shared.tabId}, sessionId: '${sessionId}' })`)).toEqual({ ok: true })
    await taskInput(window).fill('用我交给你的页面')
    await window.getByRole('button', { name: '发送', exact: true }).click()
    await waitTaskDone(window, 30_000)
    expect(lastToolResult((JSON.parse(model.bodies().at(-1)!) as { messages: ScriptMessages }).messages)).toContain('green')

    // 画面是它的；还在原来的窗口里，进了这个任务在那个窗口的分组
    await expect.poll(() => mirrorColor(window), { timeout: 15_000 }).toBe('green')
    const tab = await worker.evaluate<{ windowId: number; groupId: number }>(`chrome.tabs.get(${shared.tabId}).then((tab) => ({ windowId: tab.windowId, groupId: tab.groupId }))`)
    expect(tab.windowId).toBe(shared.windowId)
    expect(tab.groupId).toBeGreaterThan(-1)
    const titles = await worker.evaluate<string[]>('chrome.tabGroups.query({}).then((items) => items.map((item) => item.title))')
    expect(titles).toEqual(['Diffra · 开两个标签页', 'Diffra · 开两个标签页'])
    await window.screenshot({ path: 'test-results/extension-shared-window.png' })
  } finally {
    await browser?.close()
    await app.close()
    removeTestHost()
    await model.close()
    site.server.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(profile, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('用户自己的浏览器：默认是内置浏览器时，智能体按指令换到 Chrome（先问），在 Chrome 里开页面；再换回内置浏览器，Chrome 里的标签页交还给用户', async () => {
  test.setTimeout(120_000)
  const userDataDir = makeUserDataDir()
  const profile = mkdtempSync(join(tmpdir(), 'diffra-e2e-chromium-'))
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-extension-'))
  const site = await startSite()
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'browser_switch', input: { browser: 'chrome' } }] },
    { toolCalls: [{ name: 'browser_navigate', input: { url: site.url } }] },
    { toolCalls: [{ name: 'browser_get_text', input: {} }] },
    { toolCalls: [{ name: 'browser_switch', input: { browser: 'builtin' } }] },
    { toolCalls: [{ name: 'browser_tabs', input: { action: 'list' } }] },
    { text: '换回来了' },
  ])
  const app = await launchApp(userDataDir, { DIFFRA_BROWSER_HOST_TARGETS: 'chrome,chromium', DIFFRA_BROWSER_HOST: 'test' })
  let browser: BrowserContext | null = null
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    browser = await launchBrowser(profile)
    await expect.poll(() => bridgeConnections(window), { timeout: 20_000 }).toBe(1)

    await chooseProject(app, window, project)
    await startTask(window, '用我的 Chrome 打开测试页，看完换回内置浏览器')
    const permission = window.getByTestId('permission-card')
    await expect(permission).toContainText('让智能体改用你的 Chrome（会用你在那里的登录状态）', { timeout: 30_000 })
    await permission.getByRole('button', { name: '允许一次' }).click()
    // 换过去之后面板跟着变成 Chrome
    await expect(window.getByTestId('browser-panel').getByRole('button', { name: '智能体用的浏览器：Chrome' })).toBeVisible({ timeout: 15_000 })
    await waitTaskDone(window, 60_000)

    const results = model.bodies().map((body) => lastToolResult((JSON.parse(body) as { messages: ScriptMessages }).messages) ?? '')
    expect(results[1]).toContain("Switched this task to the user's Chrome")
    expect(results[3]).toContain('扩展测试页')
    expect(results[4]).toContain("Switched this task to Diffra's built-in browser")
    // 换回内置浏览器：列的是内置浏览器的标签页（空白页），不是 Chrome 里的
    expect(results[5]).toContain('1. [当前] （空白页）')
    await expect(window.getByTestId('browser-panel').getByRole('button', { name: '智能体用的浏览器：内置浏览器' })).toBeVisible()
    // Chrome 里开过的页面还在，但已经交还给用户：不在分组里
    const page = browser.pages().find((item) => item.url() === site.url)
    expect(page).toBeTruthy()
    const worker = browser.serviceWorkers()[0] ?? (await browser.waitForEvent('serviceworker'))
    await expect.poll(() => worker.evaluate<number>('chrome.tabGroups.query({}).then((items) => items.length)')).toBe(0)
  } finally {
    await browser?.close()
    await app.close()
    removeTestHost()
    await model.close()
    site.server.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(profile, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
