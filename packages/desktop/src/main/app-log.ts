import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

// 更新和退出的关键节点记到 userData/logs/updater.log：更新时卸载旧版失败，靠它看旧版退出卡在哪一步。
// 退出途中进程随时会结束，所以同步写；超过上限把旧的挪成 updater.old.log，只留一份
const MAX_BYTES = 1024 * 1024

export function logEvent(message: string, error?: unknown): void {
  try {
    const dir = join(app.getPath('userData'), 'logs')
    const file = join(dir, 'updater.log')
    mkdirSync(dir, { recursive: true })
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) renameSync(file, join(dir, 'updater.old.log'))
    const detail = error === undefined ? '' : ` ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
    appendFileSync(file, `${new Date().toISOString()} [${process.pid}] ${message}${detail}\n`)
  } catch (writeError) {
    console.error('[log] 写日志失败', writeError)
  }
}
