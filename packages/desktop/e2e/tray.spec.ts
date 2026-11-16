import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, test } from '@playwright/test'
import { chooseProject, settingsNav, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

// 托盘和开机自启（v2 · M7）。托盘菜单点不到，用主进程里给测试留的 diffraTray（只在测试数据目录里有）；
// 开机自启不往系统登记，写进 DIFFRA_LOGIN_ITEM_FILE
const tray = {
  labels: (app: ElectronApplication) => app.evaluate(() => (globalThis as { diffraTray?: { labels(): string[] } }).diffraTray?.labels() ?? []),
  click: (app: ElectronApplication, label: string) => app.evaluate((_electron, item) => (globalThis as { diffraTray?: { click(label: string): void } }).diffraTray?.click(item), label),
  tooltip: (app: ElectronApplication) => app.evaluate(() => (globalThis as { diffraTray?: { tooltip(): string } }).diffraTray?.tooltip() ?? ''),
}
const windowVisible = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)
const closeWindow = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())

test('托盘和开机自启：默认关窗口留在托盘里、开机自启关；关窗口留在托盘里、任务接着跑，托盘菜单显示几个任务在跑、能打开、新建任务、退出；开机自启登记带 --hidden，自启时藏在托盘里、换深浅色也不跳出来；关了托盘关窗口就退出', async () => {
  // 按 Windows 的托盘写的：Mac 上关窗口本来就只是藏起来，开关是「在菜单栏显示图标」，开机自启也不带 --hidden，要另写一份
  test.skip(process.platform === 'darwin', 'Mac 的菜单栏图标另写用例')
  test.setTimeout(180_000)
  const userDataDir = makeUserDataDir()
  const workspace = mkdtempSync(join(tmpdir(), 'diffra-e2e-tray-'))
  const project = join(workspace, 'project')
  execFileSync('git', ['init', '-q', project])
  writeFileSync(join(project, 'README.md'), '项目')
  const loginFile = join(workspace, 'login.json')
  const model = await startScriptedModel([{ text: '慢慢做完了', delayMs: 4000 }])
  const env = { DIFFRA_LOGIN_ITEM_FILE: loginFile }
  let app = await launchApp(userDataDir, env)
  try {
    let window = await app.firstWindow()
    await expect(window.getByText('要做什么？')).toBeVisible()
    expect(JSON.parse(readFileSync(loginFile, 'utf8'))).toEqual({ openAtLogin: false, args: [] })
    // 默认开着托盘：菜单有打开、新任务、几个任务在跑、退出
    await expect.poll(() => tray.labels(app)).toEqual(['打开 Diffra', '新任务', '没有任务在跑', '退出 Diffra'])
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await window.keyboard.press('ControlOrMeta+,')
    await settingsNav(window).getByRole('button', { name: '常规' }).click()
    await expect(window.getByRole('switch', { name: '关掉窗口时留在托盘里' })).toBeChecked()
    // 默认值不往设置文件里写
    expect((JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')) as { system?: unknown }).system).toBeUndefined()
    await window.screenshot({ path: 'test-results/tray-settings.png' })
    await window.getByRole('button', { name: '返回' }).click()

    // 有任务在跑时托盘上看得到；关窗口只是藏起来，任务照常跑完
    await chooseProject(app, window, project)
    await startTask(window, '慢慢做的任务')
    await expect.poll(() => tray.labels(app)).toContain('1 个任务在跑')
    expect(await tray.tooltip(app)).toBe('Diffra · 1 个任务在跑')
    await closeWindow(app)
    await expect.poll(() => windowVisible(app)).toBe(false)
    await expect.poll(() => tray.labels(app), { timeout: 20_000 }).toContain('没有任务在跑')
    await tray.click(app, '打开 Diffra')
    await expect.poll(() => windowVisible(app)).toBe(true)
    await waitTaskDone(window)
    await expect(window.getByTestId('turn').last()).toContainText('慢慢做完了')
    // 托盘里的「新任务」：打开窗口回到首页
    await closeWindow(app)
    await expect.poll(() => windowVisible(app)).toBe(false)
    await tray.click(app, '新任务')
    await expect.poll(() => windowVisible(app)).toBe(true)
    await expect(window.getByText('要做什么？')).toBeVisible()

    // 开机自启：登记带 --hidden
    await window.keyboard.press('ControlOrMeta+,')
    await settingsNav(window).getByRole('button', { name: '常规' }).click()
    await window.getByRole('switch', { name: '开机时自动启动' }).click()
    await expect.poll(() => JSON.parse(readFileSync(loginFile, 'utf8')) as unknown).toEqual({ openAtLogin: true, args: ['--hidden'] })

    // 像开机自启那样起来：不弹窗口，留在托盘里；从托盘打开
    await tray.click(app, '退出 Diffra')
    await app.waitForEvent('close')
    app = await launchApp(userDataDir, { ...env, DIFFRA_START_HIDDEN: '1' })
    window = await app.firstWindow()
    await expect.poll(() => tray.labels(app)).toContain('打开 Diffra')
    await window.waitForTimeout(3000)
    expect(await windowVisible(app)).toBe(false)
    await tray.click(app, '打开 Diffra')
    await expect.poll(() => windowVisible(app)).toBe(true)
    // 藏回托盘后系统换了深浅色（外观跟随系统时页面会重新套用外观），窗口不自己跳出来
    await window.keyboard.press('ControlOrMeta+,')
    await closeWindow(app)
    await expect.poll(() => windowVisible(app)).toBe(false)
    await app.evaluate(({ nativeTheme }) => (nativeTheme.themeSource = 'dark'))
    await window.waitForTimeout(1500)
    expect(await windowVisible(app)).toBe(false)
    await tray.click(app, '打开 Diffra')
    await expect.poll(() => windowVisible(app)).toBe(true)

    // 关掉托盘和开机自启：关窗口就退出
    await settingsNav(window).getByRole('button', { name: '常规' }).click()
    await window.getByRole('switch', { name: '关掉窗口时留在托盘里' }).click()
    await window.getByRole('switch', { name: '开机时自动启动' }).click()
    await expect.poll(() => JSON.parse(readFileSync(loginFile, 'utf8')) as unknown).toEqual({ openAtLogin: false, args: [] })
    await expect.poll(() => tray.labels(app)).toEqual([])
    const closed = app.waitForEvent('close')
    await closeWindow(app)
    await closed
  } finally {
    await app.close().catch(() => {})
    await model.close()
    rmSync(workspace, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
