import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc'
import { startCore, stopCore } from './core-process'
import { RulePackStore } from './rule-packs'
import { registerRulesIpc } from './rules-ipc'
import { SecretStore } from './secret-store'
import { coreClientHandlers, registerSessionIpc } from './session-ipc'
import { registerSettingsIpc } from './settings-ipc'
import { SettingsStore } from './settings-store'
import { setupUpdater } from './updater'

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
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
    },
  })
  window.once('ready-to-show', () => window.show())

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
    const userDataDir = app.getPath('userData')
    const settings = await SettingsStore.open(userDataDir)
    const secrets = await SecretStore.open(userDataDir)
    const rulePacks = new RulePackStore(join(userDataDir, 'rules'))
    registerSettingsIpc(settings, secrets)
    registerRulesIpc(rulePacks)
    registerSessionIpc(settings, secrets, userDataDir, rulePacks)
    setupUpdater()
    createWindow()
  })
  .catch((error: unknown) => {
    console.error('[app] 启动失败', error)
    app.quit()
  })

app.on('window-all-closed', () => app.quit())

app.on('will-quit', () => stopCore())
