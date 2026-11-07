import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { z } from 'zod'
import { IPC_CHANNELS } from '../shared/ipc'
import { registerBrowserIpc } from './browser'
import { registerAttachmentIpc } from './attachments'
import { startCore, stopCore } from './core-process'
import { parse } from './ipc-input'
import { registerPluginsIpc } from './plugins-ipc'
import { SecretStore } from './secret-store'
import { coreClientHandlers, registerSessionIpc } from './session-ipc'
import { registerSettingsIpc } from './settings-ipc'
import { SettingsStore } from './settings-store'
import { killAllTerminals, registerTerminalIpc } from './terminal-ipc'
import { setupUpdater } from './updater'
import { setupWindowChrome, titleBarOptions, watchAppCommands } from './window-chrome'

// 开发模式和 e2e 不碰正式安装版的数据目录（%APPDATA%\Diffra），必须在 ready 之前设置
if (!app.isPackaged) {
  app.setPath('userData', process.env.DIFFRA_USER_DATA_DIR || join(app.getPath('appData'), 'Diffra-dev'))
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 820,
    show: false,
    title: 'Diffra',
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
  // 回复里的链接等不在应用窗口里打开，需要时走 openExternal 用系统浏览器
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
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
    const coreStatus = startCore(coreClientHandlers)
    ipcMain.handle(IPC_CHANNELS.coreStatus, () => coreStatus)
    ipcMain.handle(IPC_CHANNELS.appVersion, () => app.getVersion())
    ipcMain.handle(IPC_CHANNELS.openExternal, async (_event, raw: unknown) => {
      const url = new URL(parse(z.string().min(1), raw))
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只能打开 http(s) 链接')
      await shell.openExternal(url.toString())
    })
    const userDataDir = app.getPath('userData')
    const settings = await SettingsStore.open(userDataDir)
    const secrets = await SecretStore.open(userDataDir)
    registerSettingsIpc(settings, secrets)
    registerSessionIpc(settings, secrets, userDataDir)
    registerPluginsIpc(settings, userDataDir)
    registerBrowserIpc()
    registerAttachmentIpc()
    registerTerminalIpc()
    setupUpdater()
    setupWindowChrome()
    createWindow()
  })
  .catch((error: unknown) => {
    console.error('[app] 启动失败', error)
    app.quit()
  })

app.on('window-all-closed', () => app.quit())

app.on('will-quit', () => {
  killAllTerminals()
  stopCore()
})
