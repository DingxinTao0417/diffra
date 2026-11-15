import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, autoUpdater as nativeUpdater, shell } from 'electron'
import { z } from 'zod'
import { IPC_CHANNELS } from '../shared/ipc'
import { browserHost, registerBrowserIpc } from './browser'
import { designHost, registerDesignIpc } from './design'
import { logEvent, registerRendererLog } from './app-log'
import { registerAttachmentIpc } from './attachments'
import { recordVersion, registerChangelogIpc } from './changelog'
import { startCore, stopCore } from './core-process'
import { parse } from './ipc-input'
import { registerPluginsIpc } from './plugins-ipc'
import { registerExtensionsIpc } from './extensions-ipc'
import { SecretStore } from './secret-store'
import { coreClientHandlers, registerSessionIpc } from './session-ipc'
import { registerSettingsIpc } from './settings-ipc'
import { registerTodosIpc } from './todos-ipc'
import { registerRemoteIpc } from './remote-ipc'
import { registerArchitectureIpc } from './architecture-ipc'
import { SettingsStore } from './settings-store'
import { killAllTerminals, registerTerminalIpc } from './terminal-ipc'
import { registerFileIpc } from './file-ipc'
import { registerExportIpc } from './export-ipc'
import { setupUpdater } from './updater'
import { setupWindowChrome, titleBarOptions, watchAppCommands, watchFullScreen } from './window-chrome'

// 开发模式和 e2e 不碰正式安装版的数据目录（%APPDATA%\Diffra），必须在 ready 之前设置
if (!app.isPackaged) {
  app.setPath('userData', process.env.DIFFRA_USER_DATA_DIR || join(app.getPath('appData'), 'Diffra-dev'))
}

// 可视化卡片在主窗口里的位置（CSS 像素）
const visualRect = z.object({ x: z.number().int(), y: z.number().int(), width: z.number().int().positive(), height: z.number().int().positive() })

// 同一份用户数据只跑一个主进程，再次启动时把已有窗口调到前面。
// 两个实例会同时占着安装目录里的文件，更新时只有点了更新的那个会退出，卸载旧版就会失败
const isPrimaryInstance = app.requestSingleInstanceLock()
// Mac 上点红绿灯关窗只是藏起来（任务、终端照常跑），点 Dock 图标再拿出来；⌘Q、菜单退出、更新时才真正退出
const HIDE_ON_CLOSE = process.platform === 'darwin'
let quitting = false
// Windows 的系统通知按 AppUserModelId 认应用，要和安装包的 appId 一致；开发版不设，免得和装好的 Diffra 混在一起
if (process.platform === 'win32' && app.isPackaged) app.setAppUserModelId('dev.diffra.desktop')
if (!isPrimaryInstance) app.quit()
app.on('second-instance', () => {
  const window = BrowserWindow.getAllWindows()[0]
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
})

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 820,
    show: false,
    title: 'Diffra',
    // 安装版的任务栏图标取自 exe 内嵌的图标；开发模式跑的是 electron.exe，要单独指定
    icon: app.isPackaged ? undefined : join(import.meta.dirname, '../../build/icon.ico'),
    ...titleBarOptions(),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
    },
  })
  // 页面第一次套用外观时显示（见 window-chrome）；页面没来得及发就按时显示，免得窗口一直不出来
  window.once('ready-to-show', () =>
    setTimeout(() => {
      if (!window.isDestroyed() && !window.isVisible()) window.show()
    }, 1500),
  )
  watchAppCommands(window)
  watchFullScreen(window)
  if (HIDE_ON_CLOSE) {
    window.on('close', (event) => {
      if (quitting) return
      event.preventDefault()
      // 全屏的窗口直接藏起来会留下一块黑屏，先退出全屏再藏
      if (window.isFullScreen()) {
        window.once('leave-full-screen', () => window.hide())
        window.setFullScreen(false)
      } else window.hide()
    })
  }
  // 设计页叠在窗口上、随窗口销毁：还有没存的改动时先存完再关
  let designFlushed = false
  window.on('close', (event) => {
    if (designFlushed || !designHost.hasUnsaved()) return
    event.preventDefault()
    designFlushed = true
    logEvent('[quit] 关窗前先保存设计页')
    void designHost.flushAll().finally(() => window.close())
  })
  // 回复里的链接等不在应用窗口里打开，需要时走 openExternal 用系统浏览器
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })
  // 对话里的可视化在 iframe 里：只许加载自己的容器页，模型写的代码不能把这个框导航到别的网站
  window.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return
    if (!/\/visual\.html(?:$|[?#])/.test(event.url)) event.preventDefault()
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  const loading = rendererUrl
    ? window.loadURL(rendererUrl)
    : window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  loading.catch((error: unknown) => console.error('[window] 页面加载失败', error))
}

app
  .whenReady()
  .then(async () => {
    if (!isPrimaryInstance) return
    const coreStatus = startCore(coreClientHandlers)
    ipcMain.handle(IPC_CHANNELS.coreStatus, () => coreStatus)
    ipcMain.handle(IPC_CHANNELS.appVersion, () => app.getVersion())
    ipcMain.handle(IPC_CHANNELS.visualSavePng, async (event, rawRect: unknown, rawTitle: unknown) => {
      const rect = parse(visualRect, rawRect)
      const title = parse(z.string().max(200), rawTitle).replace(/[\\/:*?"<>|]/g, '_') || '可视化'
      const owner = BrowserWindow.fromWebContents(event.sender)
      if (!owner) return
      const image = await owner.webContents.capturePage(rect)
      const picked = await dialog.showSaveDialog(owner, { title: '另存为 PNG', defaultPath: `${title}.png`, filters: [{ name: 'PNG 图片', extensions: ['png'] }] })
      if (!picked.canceled && picked.filePath) await writeFile(picked.filePath, image.toPNG())
    })
    ipcMain.handle(IPC_CHANNELS.visualCapture, async (event, rawRect: unknown) => {
      const rect = parse(visualRect, rawRect)
      const owner = BrowserWindow.fromWebContents(event.sender)
      if (!owner || !owner.isVisible() || owner.isMinimized()) return null
      const image = await owner.webContents.capturePage(rect)
      return image.isEmpty() ? null : { mimeType: 'image/png', data: image.toPNG().toString('base64') }
    })
    ipcMain.handle(IPC_CHANNELS.openExternal, async (_event, raw: unknown) => {
      const url = new URL(parse(z.string().min(1), raw))
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只能打开 http(s) 链接')
      await shell.openExternal(url.toString())
    })
    const userDataDir = app.getPath('userData')
    const settings = await SettingsStore.open(userDataDir)
    registerChangelogIpc()
    // 记不下版本号只是少一次「已更新」提示，不影响启动
    await recordVersion(settings).catch((error: unknown) => console.error('[changelog] 记录版本号失败', error))
    const secrets = await SecretStore.open(userDataDir)
    registerSettingsIpc(settings, secrets)
    const { architectureModel } = registerSessionIpc(settings, secrets, userDataDir)
    registerTodosIpc(userDataDir)
    registerRemoteIpc(userDataDir)
    registerArchitectureIpc(architectureModel)
    registerPluginsIpc(settings, userDataDir)
    registerExtensionsIpc(settings, secrets)
    registerBrowserIpc()
    // 浏览器扩展的宿主登记和管道：失败了只影响用户自己的浏览器，内置浏览器照常
    browserHost.start(settings, userDataDir).catch((error: unknown) => console.error('[browser] 启动浏览器扩展通道失败', error))
    registerDesignIpc()
    registerAttachmentIpc()
    registerTerminalIpc()
    registerFileIpc()
    registerExportIpc()
    setupUpdater()
    setupWindowChrome()
    registerRendererLog()
    createWindow()
  })
  .catch((error: unknown) => {
    console.error('[app] 启动失败', error)
    app.quit()
  })

app.on('before-quit', () => {
  quitting = true
  logEvent('[quit] 开始退出')
})
// Mac 上装更新时先关窗口、后发 before-quit，关窗前就要放行
if (HIDE_ON_CLOSE) nativeUpdater.on('before-quit-for-update', () => (quitting = true))

app.on('window-all-closed', () => app.quit())

// Mac 上点 Dock 图标：把藏起来的窗口拿出来
app.on('activate', () => {
  const window = BrowserWindow.getAllWindows()[0]
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.show()
})

app.on('will-quit', () => {
  logEvent('[quit] 窗口已全部关闭，结束终端和 core')
  killAllTerminals()
  stopCore()
  browserHost.stop()
})

app.on('quit', (_event, exitCode) => logEvent(`[quit] 主进程退出 code=${exitCode}`))
