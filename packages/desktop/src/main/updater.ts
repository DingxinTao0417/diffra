import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import { parseNotes } from '../shared/changelog'
import { IPC_CHANNELS, type UpdateNotes, type UpdateStatus } from '../shared/ipc'
import { logEvent } from './app-log'

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

// 安装版的程序目录里有 NSIS 卸载程序。没有的就是免安装版（比如本地打包出来的 release/win-unpacked）：
// 更新包只会装到已安装的那份，免安装版下载、安装了也换不掉自己，重开还是旧版，还会一直提示有新版本
const UNINSTALLER = 'Uninstall Diffra.exe'

// Mac 上的自动更新要求新旧版本用同一个 Developer ID 签名。打包时有证书才在包里的 package.json 写 macDeveloperId（electron-builder.config.ts），
// 临时签名（ad-hoc）的包（本地试打包、打包版 e2e）更新必然失败，不检查
function macDeveloperIdSigned(): boolean {
  try {
    return (JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as { macDeveloperId?: boolean }).macDeveloperId === true
  } catch {
    return false
  }
}

function disabledReason(): 'development' | 'portable' | 'mac-unsigned' | null {
  if (!app.isPackaged) return 'development'
  if (process.platform === 'darwin') return macDeveloperIdSigned() ? null : 'mac-unsigned'
  return existsSync(join(dirname(app.getPath('exe')), UNINSTALLER)) ? null : 'portable'
}

const disabled = disabledReason()
let status: UpdateStatus = disabled ? { state: 'disabled', reason: disabled } : { state: 'idle' }

function setStatus(next: UpdateStatus): void {
  status = next
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(IPC_CHANNELS.updateStatusChanged, next)
  }
}

// latest.yml 里的 releaseNotes 是打包时写进去的这版说明（scripts/changelog.ts 的 formatNotes）
function notesOf(info: UpdateInfo): UpdateNotes {
  const text = typeof info.releaseNotes === 'string' ? info.releaseNotes : (info.releaseNotes?.[0]?.note ?? '')
  const notes = parseNotes(text)
  return notes.added.length + notes.fixed.length > 0 ? notes : null
}

function checkForUpdates(): void {
  if (disabled) return
  // 已在下载或已下载完时不再检查，避免把「重启并更新」的状态覆盖掉
  if (status.state === 'checking' || status.state === 'downloading' || status.state === 'downloaded') return
  // 失败会同时触发 error 事件和 reject；error 事件里已经记录日志并更新状态，这里只接住 reject
  autoUpdater.checkForUpdates().catch(() => {})
}

export function setupUpdater(): void {
  ipcMain.handle(IPC_CHANNELS.updateStatus, () => status)
  ipcMain.handle(IPC_CHANNELS.updateCheck, () => checkForUpdates())
  ipcMain.handle(IPC_CHANNELS.updateInstall, () => {
    // 静默安装后自动重新启动；不点按钮时，下次正常退出也会安装（autoInstallOnAppQuit 默认开启）
    if (status.state !== 'downloaded') return
    logEvent(`[updater] 点了重启并更新，安装 ${status.version}`)
    autoUpdater.quitAndInstall(true, true)
  })

  if (disabled === 'portable') logEvent(`[updater] 程序目录里没有 ${UNINSTALLER}，是免安装版，不检查更新`)
  if (disabled) return

  autoUpdater.disableWebInstaller = true
  // electron-updater 自己的日志（下载到哪、用什么参数启动安装程序）一起记下来
  autoUpdater.logger = {
    info: (message?: unknown) => logEvent(`[updater] ${String(message)}`),
    warn: (message?: unknown) => logEvent(`[updater] 警告 ${String(message)}`),
    error: (message?: unknown) => logEvent('[updater] 错误', message),
  }
  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking' }))
  autoUpdater.on('update-not-available', () => setStatus({ state: 'up-to-date' }))
  autoUpdater.on('update-available', (info) => setStatus({ state: 'downloading', version: info.version, percent: 0, notes: notesOf(info) }))
  autoUpdater.on('download-progress', (progress) => {
    if (status.state === 'downloading') setStatus({ ...status, percent: Math.floor(progress.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => setStatus({ state: 'downloaded', version: info.version, notes: notesOf(info) }))
  autoUpdater.on('error', (error) => {
    console.error('[updater] 更新失败', error)
    setStatus({ state: 'error', message: error.message })
  })

  checkForUpdates()
  setInterval(checkForUpdates, CHECK_INTERVAL_MS)
}
