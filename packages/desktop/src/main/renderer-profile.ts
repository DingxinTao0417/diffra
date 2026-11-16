import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type WebContents } from 'electron'
import { logRenderer } from './app-log'
import { sleep, withTimeout } from './browser-page'

// 界面陷入无限更新（React #185）或无响应时，用调试协议录 5 秒 CPU profile 存到 logs/，
// 用开发者工具的 Performance 面板打开就能看到是哪段代码在转（光有报错只知道哪里更新失败，不知道谁在循环）。
// 每个窗口每次启动只录一次；logs/ 里已经有 5 份就不再录，旧的不自动删。
// 页面主线程被占住时调试命令要排队，等得久一些
const PROFILE_MS = 5000
const MAX_PROFILES = 5
const COMMAND_TIMEOUT_MS = 120_000
const profiled = new WeakSet<WebContents>()

export async function captureRendererProfile(contents: WebContents, reason: string): Promise<void> {
  if (profiled.has(contents) || contents.isDestroyed()) return
  profiled.add(contents)
  const dir = join(app.getPath('userData'), 'logs')
  mkdirSync(dir, { recursive: true })
  if (readdirSync(dir).filter((name) => name.endsWith('.cpuprofile')).length >= MAX_PROFILES) {
    logRenderer(`[profile] ${reason}：logs 里已经有 ${MAX_PROFILES} 份 CPU profile，这次不录`)
    return
  }
  const debug = contents.debugger
  const attachedHere = !debug.isAttached()
  try {
    if (attachedHere) debug.attach('1.3')
    const send = (method: string) => withTimeout(debug.sendCommand(method), COMMAND_TIMEOUT_MS, `${method} ${COMMAND_TIMEOUT_MS / 1000} 秒没有回应`)
    await send('Profiler.enable')
    await send('Profiler.start')
    await sleep(PROFILE_MS)
    const { profile } = (await send('Profiler.stop')) as { profile: unknown }
    const file = join(dir, `renderer-${new Date().toISOString().replace(/[:.]/g, '-')}.cpuprofile`)
    writeFileSync(file, JSON.stringify(profile))
    logRenderer(`[profile] ${reason}：录了 ${PROFILE_MS / 1000} 秒 CPU，存在 ${file}`)
  } catch (error) {
    logRenderer(`[profile] ${reason}：没录成`, error)
  } finally {
    if (attachedHere && !contents.isDestroyed() && debug.isAttached()) debug.detach()
  }
}
