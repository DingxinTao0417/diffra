import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain, type WebContents } from 'electron'
import { z } from 'zod'
import { IPC_CHANNELS } from '../shared/ipc'
import { parse } from './ipc-input'

// 关键节点同步记到 userData/logs/ 下，出了问题让用户把文件发过来看：
// updater.log 记更新和退出（更新时卸载旧版失败，靠它看旧版退出卡在哪一步；退出途中进程随时会结束，所以同步写）；
// remote.log 记设备连接建不起通道、被拒绝、通道出错这类（只在出问题时写，不记内容）；
// renderer.log 记界面里没接住的错误（白屏这类，不开开发者工具也能看到原因），界面无限更新、无响应时另录一份 CPU profile（renderer-profile.ts）。
// 超过上限把旧的挪成 *.old.log，只留一份
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

export function logRenderer(message: string, error?: unknown): void {
  append('renderer', message, error)
}

// 页面（lib/error-report.ts）和 preload 的订阅回调都把没接住的错误发到这里。每个页面一次加载最多记 50 条、连着一样的只记一次：
// 无限更新这类错误一秒能刷几十条。出现无限更新（React #185）时交给 onLoop（录 CPU profile）
const MAX_RENDERER_ERRORS = 50
const UPDATE_LOOP = /#185|Maximum update depth/

export function registerRendererLog(onLoop: (contents: WebContents) => void): void {
  const seen = new WeakMap<WebContents, { count: number; last: string }>()
  ipcMain.on(IPC_CHANNELS.rendererError, (event, raw: unknown) => {
    const message = parse(z.string().max(10_000), raw)
    let page = seen.get(event.sender)
    if (!page) {
      const fresh = { count: 0, last: '' }
      seen.set(event.sender, fresh)
      // 页面重新加载后重新计数
      event.sender.on('did-start-navigation', (details) => {
        if (!details.isMainFrame || details.isSameDocument) return
        fresh.count = 0
        fresh.last = ''
      })
      page = fresh
    }
    if (UPDATE_LOOP.test(message)) onLoop(event.sender)
    if (message === page.last || page.count >= MAX_RENDERER_ERRORS) return
    page.last = message
    page.count++
    append('renderer', message)
  })
}
