import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, type Locator, test } from '@playwright/test'
import { BACK_KEY, chooseProject, settingsNav, startTask, waitTaskDone } from './flows'
import { isPackagedRun, launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

// e2e 的 tsconfig 不带 DOM 类型，计算样式从元素所在的窗口取
const computedStyle = (locator: Locator, property: string) =>
  locator.evaluate((element, name) => element.ownerDocument.defaultView?.getComputedStyle(element).getPropertyValue(name) ?? '', property)
const appRegion = (locator: Locator) => computedStyle(locator, '-webkit-app-region')

// 点主进程里的菜单项，和用户在弹出的菜单里点一样
const clickMenuItem = (app: ElectronApplication, id: string) => app.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu()?.getMenuItemById(itemId)?.click(), id)

test('标题栏：顶栏能拖动、弹窗时不拖动；中文菜单从 ≡ 弹出、菜单项能用；系统窗口按钮跟着深浅色；侧栏开关；后退前进（含设计首页）', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-titlebar-'))
  const model = await startScriptedModel([{ text: '好' }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    const bar = window.getByTestId('title-bar')
    await expect(bar).toBeVisible()
    expect(await appRegion(bar)).toBe('drag')
    const mac = process.platform === 'darwin'
    // Windows 上右边给系统的窗口按钮留出位置；Mac 上左边给红绿灯留位置，菜单在系统菜单栏里，没有 ≡
    if (process.platform === 'win32') expect(Number.parseFloat(await computedStyle(bar, 'padding-right'))).toBeGreaterThan(100)
    if (mac) {
      expect(Number.parseFloat(await computedStyle(bar, 'padding-left'))).toBeGreaterThanOrEqual(80)
      await expect(bar.getByRole('button', { name: '主菜单' })).toHaveCount(0)
      // 顶栏不单独占一行：按钮组浮在侧栏顶上，内容面板顶到窗口上沿（不留缝，留缝的话右上角会被窗口圆角切掉）；窗口最上面一条能拖动
      expect((await bar.boundingBox())!.width).toBeLessThan(300)
      expect((await window.locator('main').first().boundingBox())!.y).toBe(0)
      expect(await appRegion(window.locator('.mac-drag-strip'))).toBe('drag')
    } else expect(await appRegion(bar.getByRole('button', { name: '主菜单' }))).toBe('no-drag')

    // 中文菜单
    const menu = await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()?.items.map((item) => [item.label, item.submenu?.items.filter((sub) => sub.type !== 'separator').map((sub) => sub.label)]),
    )
    // 正式版不放重新加载
    const reload = isPackagedRun() ? [] : ['重新加载']
    if (mac) {
      const appName = await app.evaluate(({ app }) => app.name)
      expect(menu).toEqual([
        [appName, ['关于 Diffra', '检查更新…', '设置…', '服务', '隐藏 Diffra', '隐藏其他', '全部显示', '退出 Diffra']],
        ['文件', ['新任务', '打开项目文件夹…', '关闭窗口']],
        ['编辑', ['撤销', '重做', '剪切', '复制', '粘贴', '粘贴并匹配样式', '全选']],
        ['视图', ['侧栏', '搜索任务', '终端', '记一条待办', '后退', '前进', '进入全屏', ...reload]],
        ['窗口', ['最小化', '缩放', '前置全部窗口']],
        ['帮助', ['Diffra 官网', '开发者工具']],
      ])
    } else {
      expect(menu).toEqual([
        ['文件', ['新任务', '打开项目文件夹…', '设置', '退出']],
        ['编辑', ['撤销', '重做', '剪切', '复制', '粘贴', '全选']],
        ['视图', ['侧栏', '搜索任务', '终端', '记一条待办', '后退', '前进', '全屏', ...reload]],
        ['帮助', ['Diffra 官网', '检查更新', '开发者工具', '关于 Diffra']],
      ])
    }
    // ≡ 在按钮下面弹出这个菜单（测试里记下弹出位置，不真的弹）；Mac 没有 ≡
    if (!mac) await expectMenuPopup(app, bar)


    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })

    // 菜单项「设置」；设置页里不显示侧栏开关
    await clickMenuItem(app, 'settings')
    await expect(settingsNav(window)).toBeVisible()
    await expect(bar.getByRole('button', { name: /侧栏/ })).toHaveCount(0)

    // 系统窗口按钮的颜色跟着深浅色，原生菜单也跟着
    if (process.platform === 'win32') {
      await app.evaluate(({ BrowserWindow }) => {
        const state = globalThis as unknown as { overlays: unknown[] }
        state.overlays = []
        const win = BrowserWindow.getAllWindows()[0]!
        const original = win.setTitleBarOverlay.bind(win)
        win.setTitleBarOverlay = (options) => {
          state.overlays.push(options)
          original(options)
        }
      })
    }
    await settingsNav(window).getByRole('button', { name: '外观' }).click()
    await window.getByRole('combobox', { name: '主题', exact: true }).click()
    await window.getByRole('option', { name: '深色', exact: true }).click()
    await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark')
    if (process.platform === 'win32') {
      await expect
        .poll(() => app.evaluate(() => (globalThis as unknown as { overlays: unknown[] }).overlays.at(-1)))
        .toEqual({ color: '#1b1b19', symbolColor: '#ecece8', height: 40 })
    }
    await window.screenshot({ path: 'test-results/titlebar-dark.png' })
    await window.getByRole('combobox', { name: '主题', exact: true }).click()
    await window.getByRole('option', { name: '浅色', exact: true }).click()
    await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light')

    // 设置页里后退就是回到进设置前的页面
    await bar.getByRole('button', { name: '后退' }).click()
    await expect(settingsNav(window)).toBeHidden()

    // 弹窗打开时顶栏不拖动，免得盖在上面的弹窗点不到
    await window.keyboard.press('ControlOrMeta+k')
    await expect(window.getByRole('dialog')).toBeVisible()
    expect(await appRegion(bar)).toBe('no-drag')
    await window.keyboard.press('Escape')
    await expect(window.getByRole('dialog')).toBeHidden()
    await expect.poll(() => appRegion(bar)).toBe('drag')

    // 顶栏的侧栏开关
    await bar.getByRole('button', { name: '收起侧栏' }).click()
    await expect(window.getByTestId('sidebar')).toBeHidden()
    await bar.getByRole('button', { name: '展开侧栏' }).click()
    await expect(window.getByTestId('sidebar')).toBeVisible()

    // 后退、前进：顶栏按钮、Alt+←（Mac 上 ⌘[）、菜单都能用；菜单「新任务」回首页
    await chooseProject(app, window, project)
    await startTask(window, '打个招呼')
    await waitTaskDone(window)
    const back = bar.getByRole('button', { name: '后退' })
    const forward = bar.getByRole('button', { name: '前进' })
    await expect(forward).toBeDisabled()
    await back.click()
    await expect(window.getByRole('heading', { name: '要做什么？' })).toBeVisible()
    await forward.click()
    await expect(window.getByTestId('task-title')).toHaveText('打个招呼')
    await window.keyboard.press(BACK_KEY)
    await expect(window.getByRole('heading', { name: '要做什么？' })).toBeVisible()
    await clickMenuItem(app, 'forward')
    await expect(window.getByTestId('task-title')).toHaveText('打个招呼')
    await clickMenuItem(app, 'new-task')
    await expect(window.getByRole('heading', { name: '要做什么？' })).toBeVisible()
    await expect(forward).toBeDisabled()

    // 设计首页也记进历史：首页 → 设计首页，后退回首页，前进回设计首页
    await window.getByTestId('sidebar').getByRole('button', { name: '设计', exact: true }).click()
    await expect(window.getByRole('heading', { name: '要设计什么？' })).toBeVisible()
    await back.click()
    await expect(window.getByRole('heading', { name: '要做什么？' })).toBeVisible()
    await forward.click()
    await expect(window.getByRole('heading', { name: '要设计什么？' })).toBeVisible()
    await expect(forward).toBeDisabled()
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

async function expectMenuPopup(app: ElectronApplication, bar: Locator): Promise<void> {
  await app.evaluate(({ Menu }) => {
    const state = globalThis as unknown as { popups: Array<{ x?: number; y?: number }> }
    state.popups = []
    const appMenu = Menu.getApplicationMenu()
    if (appMenu) appMenu.popup = (options) => void state.popups.push({ x: options?.x, y: options?.y })
  })
  await bar.getByRole('button', { name: '主菜单' }).click()
  await expect
    .poll(() => app.evaluate(() => (globalThis as unknown as { popups: Array<{ x?: number; y?: number }> }).popups))
    .toEqual([{ x: 8, y: 35 }])
}
