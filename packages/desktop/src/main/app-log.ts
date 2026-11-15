import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import { z } from 'zod'
import { IPC_CHANNELS } from '../shared/ipc'
import { parse } from './ipc-input'

// 关键节点同步记到 userData/logs/ 下，出了问题让用户把文件发过来看：
// updater.log 记更新和退出（更新时卸载旧版失败，靠它看旧版退出卡在哪一步；退出途中进程随时会结束，所以同步写）；
// remote.log 记设备连接建不起通道、被拒绝、通道出错这类（只在出问题时写，不记内容）；
// renderer.log 记界面里没接住的错误（白屏这类，不开开发者工具也能看到原因）。超过上限把旧的挪成 *.old.log，只留一份
const MAX_BYTES = 1024 * 1024

function append(name: string, message: string, error?: unknown): void {
  try {
    const dir = join(app.getPath('userData'), 'logs')
    const file = join(dir, `${name}.log`)
    mkdirSync(dir, { recursive: true })
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) renameSync(file, join(dir, `${name}.old.log`))
    const detail = error === undefined ? '' : ` ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
    appendFileSync(file, `${new Date().toISOString()} [${process.pid}] ${message}${detail}\n`)
  } catch (writeError) {
    console.error('[log] 写日志失败', writeError)
  }
}

export function logEvent(message: string, error?: unknown): void {
  append('updater', message, error)
}

// 设备 ID 只记前 8 位
export function logRemote(message: string, error?: unknown): void {
  console.error(`[remote] ${message}`, ...(error === undefined ? [] : [error]))
  append('remote', message, error)
}

// 页面那边已经限了条数（lib/error-report.ts），这里只限单条长度
export function registerRendererLog(): void {
  ipcMain.on(IPC_CHANNELS.rendererError, (_event, raw: unknown) => append('renderer', parse(z.string().max(10_000), raw)))
}
