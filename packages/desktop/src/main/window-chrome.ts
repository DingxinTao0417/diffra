import { app, BrowserWindow, ipcMain, Menu, type MenuItemConstructorOptions, nativeTheme, shell } from 'electron'
import { z } from 'zod'
import { IPC_CHANNELS, type MenuCommand } from '../shared/ipc'
import { parse } from './ipc-input'

// Windows 上去掉系统标题栏，最小化 / 最大化 / 关闭用系统的窗口按钮（titleBarOverlay），
// 颜色跟页面的顶栏一致；贴靠布局、双击最大化、右键系统菜单都是系统自己处理的
export const TITLE_BAR_HEIGHT = 40
export const USE_TITLE_BAR_OVERLAY = process.platform === 'win32'

export function titleBarOptions(): Electron.BrowserWindowConstructorOptions {
  if (!USE_TITLE_BAR_OVERLAY) return {}
  return { titleBarStyle: 'hidden', titleBarOverlay: { color: '#f5f5f2', symbolColor: '#1c1c1a', height: TITLE_BAR_HEIGHT } }
}

function sendCommand(command: MenuCommand): void {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  window?.webContents.send(IPC_CHANNELS.menuCommand, command)
}

// 页面自己处理的快捷键（任务页终端里要让给 shell）在菜单上只显示、不注册，免得按一次触发两次
function command(label: string, id: MenuCommand, accelerator?: string, registerAccelerator = true): MenuItemConstructorOptions {
  return { id, label, accelerator, registerAccelerator, click: () => sendCommand(id) }
}

function menuTemplate(): MenuItemConstructorOptions[] {
  return [
    {
      label: '文件',
      submenu: [
        command('新任务', 'new-task', 'Ctrl+N'),
        command('打开项目文件夹…', 'open-project', 'Ctrl+O'),
        { type: 'separator' },
        command('设置', 'settings', 'Ctrl+,', false),
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        command('侧栏', 'toggle-sidebar', 'Ctrl+B', false),
        command('搜索任务', 'search', 'Ctrl+K', false),
        command('终端', 'terminal', 'Ctrl+`', false),
        { type: 'separator' },
        command('后退', 'back', 'Alt+Left', false),
        command('前进', 'forward', 'Alt+Right', false),
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        // 正式版不放重新加载：会丢掉正在运行的任务在界面上的状态
        ...(app.isPackaged ? [] : [{ role: 'reload' as const, label: '重新加载' }]),
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: 'Diffra 官网', click: () => void shell.openExternal('https://diffra.dev') },
        command('检查更新', 'check-updates'),
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        command('关于 Diffra', 'about'),
      ],
    },
  ]
}

const chromeSchema = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  symbolColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  theme: z.enum(['system', 'light', 'dark']),
})

export function setupWindowChrome(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate()))

  // 顶栏的 ≡ 按钮：在按钮下面弹出上面的菜单
  ipcMain.handle(IPC_CHANNELS.menuPopup, (event, raw: unknown) => {
    const { x, y } = parse(z.object({ x: z.number().int(), y: z.number().int() }), raw)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window) Menu.getApplicationMenu()?.popup({ window, x, y })
  })

  // 页面套用外观后把顶栏颜色告诉系统窗口按钮，原生菜单跟着深浅色；第一次套用后才显示窗口，免得先闪一下浅色
  ipcMain.handle(IPC_CHANNELS.windowChrome, (event, raw: unknown) => {
    const { color, symbolColor, theme } = parse(chromeSchema, raw)
    nativeTheme.themeSource = theme
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return
    if (USE_TITLE_BAR_OVERLAY) window.setTitleBarOverlay({ color, symbolColor, height: TITLE_BAR_HEIGHT })
    if (!window.isVisible()) window.show()
  })
}

// 鼠标侧键前进后退（Windows 上是 app-command）
export function watchAppCommands(window: BrowserWindow): void {
  window.on('app-command', (_event, name) => {
    if (name === 'browser-backward') sendCommand('back')
    if (name === 'browser-forward') sendCommand('forward')
  })
}
