import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, Menu, type MenuItemConstructorOptions, type NativeImage, nativeImage, Tray } from 'electron'
import { IPC_CHANNELS, type MenuCommand } from '../shared/ipc'
import type { SystemSettings } from '../shared/settings'
import type { SettingsStore } from './settings-store'
import { testOverridesAllowed } from './test-overrides'

// 托盘和开机自启（v2 · M7），设置「常规」里开，都默认关：
// - 开着托盘时关窗口只是藏起来（任务、终端照常跑），托盘图标能打开窗口、新建任务、看几个任务在跑、退出；Mac 上关窗本来就是藏起来，托盘是菜单栏图标。
// - 开机自启：登记到系统的登录项（Windows 带 --hidden 参数）；开着托盘时启动后直接藏在托盘里，没开托盘就照常显示窗口。
//   开发版不往系统里登记（登记的会是 electron.exe），e2e 用 DIFFRA_LOGIN_ITEM_FILE 写进文件

export const DEFAULT_SYSTEM: SystemSettings = { tray: false, launchAtLogin: false }

export interface TrayTestHandle {
  labels(): string[]
  click(label: string): void
  tooltip(): string
}

let tray: Tray | null = null
let running = 0
let hiddenNoticeShown = false
let quitRequested: () => void = () => {}
// 这次启动先不显示窗口（开机自启、开着托盘）
let holdShow = false

export function initialShowHeld(): boolean {
  return holdShow
}

function systemOf(settings: SettingsStore): SystemSettings {
  return settings.get().system ?? DEFAULT_SYSTEM
}

export function trayEnabled(settings: SettingsStore): boolean {
  return systemOf(settings).tray
}

function mainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

export function showMainWindow(): void {
  const window = mainWindow()
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function send(command: MenuCommand): void {
  showMainWindow()
  mainWindow()?.webContents.send(IPC_CHANNELS.menuCommand, command)
}

function trayIcon(): NativeImage {
  // 开发版跑的是 electron.exe，图标用仓库里的；安装版用程序自己的图标
  const path = app.isPackaged ? process.execPath : join(import.meta.dirname, '../../build', process.platform === 'darwin' ? 'icon.icns' : 'icon.ico')
  const image = nativeImage.createFromPath(path)
  return image.isEmpty() ? image : image.resize({ width: 16, height: 16 })
}

interface Entry {
  label?: string
  action?: () => void
  disabled?: boolean
}

function entries(): Entry[] {
  return [
    { label: '打开 Diffra', action: () => showMainWindow() },
    { label: '新任务', action: () => send('new-task') },
    {},
    { label: running > 0 ? `${running} 个任务在跑` : '没有任务在跑', disabled: true },
    {},
    { label: '退出 Diffra', action: () => quitRequested() },
  ]
}

function menuItems(): MenuItemConstructorOptions[] {
  return entries().map((entry): MenuItemConstructorOptions => (entry.label ? { label: entry.label, enabled: !entry.disabled, click: entry.action } : { type: 'separator' }))
}

function refresh(): void {
  if (!tray) return
  tray.setToolTip(running > 0 ? `Diffra · ${running} 个任务在跑` : 'Diffra')
  tray.setContextMenu(Menu.buildFromTemplate(menuItems()))
}

// 按设置建或拆托盘图标
export function applyTray(settings: SettingsStore): void {
  const enabled = trayEnabled(settings)
  if (!enabled) {
    tray?.destroy()
    tray = null
    return
  }
  if (!tray) {
    tray = new Tray(trayIcon())
    tray.on('click', () => {
      const window = mainWindow()
      if (window?.isVisible() && !window.isMinimized()) window.hide()
      else showMainWindow()
    })
  }
  refresh()
}

export function setRunningTasks(count: number): void {
  if (count === running) return
  running = count
  refresh()
}

// 开着托盘时关窗口：藏起来；第一次藏的时候在 Windows 上冒个气泡说还在后台
export function hideToTray(window: BrowserWindow): void {
  window.hide()
  if (hiddenNoticeShown || !tray || process.platform !== 'win32') return
  hiddenNoticeShown = true
  // e2e 不在用户桌面上冒真的通知
  if (testOverridesAllowed() && process.env.DIFFRA_TRAY_QUIET === '1') return
  tray.displayBalloon({ title: 'Diffra 还在后台运行', content: '任务会接着跑。点托盘里的图标打开，右键可以退出。' })
}

// 开机自启：开发版不登记（测试写进文件）
export function applyLoginItem(settings: SettingsStore): void {
  const openAtLogin = systemOf(settings).launchAtLogin
  const file = testOverridesAllowed() ? process.env.DIFFRA_LOGIN_ITEM_FILE : undefined
  if (file) {
    writeFileSync(file, JSON.stringify({ openAtLogin, args: openAtLogin ? ['--hidden'] : [] }))
    return
  }
  if (!app.isPackaged) return
  try {
    app.setLoginItemSettings(process.platform === 'darwin' ? { openAtLogin } : { openAtLogin, args: ['--hidden'] })
  } catch (error) {
    console.error('[tray] 登记开机启动失败', error)
  }
}

// 这次是开机自启起来的：Windows 看 --hidden 参数，Mac 问系统；测试用 DIFFRA_START_HIDDEN
export function startedHidden(): boolean {
  if (testOverridesAllowed() && process.env.DIFFRA_START_HIDDEN === '1') return true
  if (process.argv.includes('--hidden')) return true
  return process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin === true
}

export function setupTray(settings: SettingsStore, quit: () => void): void {
  quitRequested = quit
  holdShow = startedHidden() && trayEnabled(settings)
  applyTray(settings)
  if (testOverridesAllowed()) {
    const handle: TrayTestHandle = {
      labels: () => (tray ? entries().flatMap((entry) => (entry.label ? [entry.label] : [])) : []),
      click: (label) => entries().find((entry) => entry.label === label && !entry.disabled)?.action?.(),
      tooltip: () => (running > 0 ? `Diffra · ${running} 个任务在跑` : 'Diffra'),
    }
    Object.assign(globalThis, { diffraTray: handle })
  }
}
