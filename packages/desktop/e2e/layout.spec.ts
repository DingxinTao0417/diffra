import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Locator, type Page, test } from '@playwright/test'
import { BACK_KEY, chooseProject, startDesignTask, startTask, taskInput, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

async function drag(window: Page, handle: Locator, dx: number, dy = 0): Promise<void> {
  const box = (await handle.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await window.mouse.move(x, y)
  await window.mouse.down()
  await window.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 })
  await window.mouse.move(x + dx, y + dy, { steps: 4 })
  await window.mouse.up()
}

const width = async (locator: Locator) => Math.round((await locator.boundingBox())!.width)
const height = async (locator: Locator) => Math.round((await locator.boundingBox())!.height)

test('分栏拖动：侧栏、任务监控、审阅和浏览器共用的宽度、设计任务的对话列、终端高度都能拖；有上下限，方向键能调，双击恢复默认；重启后还在；浏览器网页跟着面板走', async () => {
  test.setTimeout(180_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-layout-'))
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>布局</title><h1>布局测试页</h1>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const site = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  const model = await startScriptedModel([{ text: '好' }, { text: '好' }])
  let app = await launchApp(userDataDir)
  try {
    let window = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1500, 900))
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '看看布局')
    await waitTaskDone(window)
    const rem = await window.evaluate<number>('parseFloat(getComputedStyle(document.documentElement).fontSize)')
    const panelHandle = window.getByRole('separator', { name: '拖动调整面板宽度' })

    // 侧栏：往右拖 80，设置页的分区导航跟着一样宽；双击恢复
    const sidebar = window.getByTestId('sidebar')
    const sidebarDefault = await width(sidebar)
    await drag(window, window.getByRole('separator', { name: '拖动调整侧栏宽度' }), 80)
    await expect.poll(() => width(sidebar)).toBe(sidebarDefault + 80)
    await window.getByTestId('sidebar').getByRole('button', { name: '设置', exact: true }).click()
    await expect.poll(() => width(window.getByRole('navigation', { name: '设置分区' }))).toBe(sidebarDefault + 80)
    await window.keyboard.press(BACK_KEY)
    await expect(window.getByTestId('task-title')).toBeVisible()
    // 往左拖到底停在下限（Mac 上侧栏顶部要放得下红绿灯和顶栏按钮，至少 216px）
    await drag(window, window.getByRole('separator', { name: '拖动调整侧栏宽度' }), -600)
    await expect.poll(() => width(sidebar)).toBe(process.platform === 'darwin' ? Math.max(Math.round(13 * rem), 216) : Math.round(13 * rem))
    await window.getByRole('separator', { name: '拖动调整侧栏宽度' }).dblclick()
    await expect.poll(() => width(sidebar)).toBe(sidebarDefault)
    await drag(window, window.getByRole('separator', { name: '拖动调整侧栏宽度' }), 40)
    await expect.poll(() => width(sidebar)).toBe(sidebarDefault + 40)

    // 任务监控：往左拖 100 变宽；方向键每次 16
    const monitor = window.getByTestId('monitor-panel')
    const monitorDefault = await width(monitor)
    await drag(window, panelHandle, -100)
    await expect.poll(() => width(monitor)).toBe(monitorDefault + 100)
    await panelHandle.focus()
    await window.keyboard.press('ArrowLeft')
    await expect.poll(() => width(monitor)).toBe(monitorDefault + 116)
    await window.keyboard.press('ArrowRight')
    await expect.poll(() => width(monitor)).toBe(monitorDefault + 100)

    // 审阅和浏览器共用一个宽度，和任务监控分开记
    await window.getByRole('button', { name: '审阅改动', exact: true }).click()
    const review = window.getByTestId('review-panel')
    const wideDefault = await width(review)
    await drag(window, panelHandle, 120)
    await expect.poll(() => width(review)).toBe(wideDefault - 120)
    await window.getByRole('button', { name: '浏览器', exact: true }).click()
    const browser = window.getByTestId('browser-panel')
    await expect.poll(() => width(browser)).toBe(wideDefault - 120)
    // 往左拖到底：对话列至少留 24rem
    await drag(window, panelHandle, -2000)
    const column = window.locator('section').filter({ has: taskInput(window) })
    await expect.poll(() => width(column)).toBe(Math.round(24 * rem))
    await drag(window, panelHandle, 300)

    // 网页是盖在面板上的原生视图，宽度跟着面板走
    await window.getByLabel('网址').fill(site)
    await window.getByLabel('网址').press('Enter')
    const viewWidth = () =>
      app.evaluate(({ BrowserWindow }) => {
        const view = BrowserWindow.getAllWindows()[0]?.contentView.children.at(-1)
        return view && 'webContents' in view ? view.getBounds().width : null
      })
    await expect.poll(viewWidth).toBe(await width(browser.getByTestId('browser-viewport')))
    const before = await width(browser)
    await drag(window, panelHandle, -60)
    await expect.poll(() => width(browser)).toBe(before + 60)
    await expect.poll(viewWidth).toBe(await width(browser.getByTestId('browser-viewport')))
    const wideWidth = await width(browser)

    // 终端：往上拖 100 变高
    await window.getByRole('button', { name: '终端 Ctrl+`' }).click()
    const terminal = window.getByTestId('terminal-panel')
    const terminalDefault = await height(terminal)
    await drag(window, window.getByRole('separator', { name: '拖动调整终端高度' }), 0, -100)
    await expect.poll(() => height(terminal)).toBe(terminalDefault + 100)
    // 收起再打开还是这个高度
    await window.getByRole('button', { name: '终端 Ctrl+`' }).click()
    await window.getByRole('button', { name: '终端 Ctrl+`' }).click()
    await expect.poll(() => height(terminal)).toBe(terminalDefault + 100)
    await window.getByRole('button', { name: '终端 Ctrl+`' }).click()

    // 设计任务：对话列和画布之间能拖
    await startDesignTask(window, '画个按钮')
    await expect(window.getByTestId('design-panel')).toBeVisible()
    await waitTaskDone(window, 30_000)
    const designColumn = window.locator('section').filter({ has: taskInput(window) })
    const designDefault = await width(designColumn)
    await drag(window, window.getByRole('separator', { name: '拖动调整对话列宽度' }), 90)
    await expect.poll(() => width(designColumn)).toBe(designDefault + 90)
    await window.screenshot({ path: 'test-results/layout.png' })

    // 存进设置文件；重启后都还在
    await expect
      .poll(() => (JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')) as { layout: Record<string, number | null> }).layout)
      .toEqual({ sidebarWidth: sidebarDefault + 40, widePanelWidth: wideWidth, monitorWidth: monitorDefault + 100, designChatWidth: designDefault + 90, terminalHeight: terminalDefault + 100 })
    await app.close()
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1500, 900))
    await expect.poll(() => width(window.getByTestId('sidebar'))).toBe(sidebarDefault + 40)
    await window.getByTestId('sidebar-task').filter({ hasText: '看看布局' }).click()
    await window.getByRole('button', { name: '浏览器', exact: true }).click()
    await expect.poll(() => width(window.getByTestId('browser-panel'))).toBe(wideWidth)
    // 双击恢复默认
    await window.getByRole('separator', { name: '拖动调整面板宽度' }).dblclick()
    await expect.poll(() => width(window.getByTestId('browser-panel'))).toBe(wideDefault)
  } finally {
    await app.close()
    await model.close()
    server.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
