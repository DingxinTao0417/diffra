import { type ChildProcessByStdio, spawn } from 'node:child_process'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { connectToCore, handshake } from '@diffra/core'
import { app, BrowserWindow, ipcMain } from 'electron'
import { type CoreStatus, IPC_CHANNELS } from '../shared/ipc'
import { setupUpdater } from './updater'

const HANDSHAKE_TIMEOUT_MS = 10_000

let coreProcess: ChildProcessByStdio<Writable, Readable, null> | undefined
let quitting = false

function startCore(): ChildProcessByStdio<Writable, Readable, null> {
  // 用 Electron 自带的 Node 跑 core，不额外打包 Node；打包时不能关闭 RunAsNode fuse。
  const child = spawn(process.execPath, [join(import.meta.dirname, 'core.js')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  child.on('error', (error) => console.error('[core] 进程启动失败', error))
  child.on('exit', (code, signal) => {
    if (!quitting) console.error(`[core] 进程意外退出 code=${code} signal=${signal}`)
  })
  return child
}

async function connectCore(): Promise<CoreStatus> {
  coreProcess = startCore()
  try {
    const info = await handshake(connectToCore(coreProcess.stdin, coreProcess.stdout), HANDSHAKE_TIMEOUT_MS)
    return { state: 'connected', ...info }
  } catch (error) {
    console.error('[core] 握手失败', error)
    return { state: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1100,
    height: 720,
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
  .then(() => {
    const coreStatus = connectCore()
    ipcMain.handle(IPC_CHANNELS.coreStatus, () => coreStatus)
    ipcMain.handle(IPC_CHANNELS.appVersion, () => app.getVersion())
    setupUpdater()
    createWindow()
  })
  .catch((error: unknown) => {
    console.error('[app] 启动失败', error)
    app.quit()
  })

app.on('window-all-closed', () => app.quit())

app.on('will-quit', () => {
  quitting = true
  coreProcess?.kill()
})
