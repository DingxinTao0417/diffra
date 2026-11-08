import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configureSession } from '@diffra/core'
import { type DesignActionParams, type DesignActionResult, PROMPT_IMAGE_TYPES, type SessionDesign } from '@diffra/core/types'
import { app, BrowserWindow, dialog, session as electronSession, ipcMain, WebContentsView } from 'electron'
import { z } from 'zod'
import { type BrowserRect, IPC_CHANNELS } from '../shared/ipc'
import { coreConnection } from './core-process'
import { parse } from './ipc-input'

// 设计页：OpenPencil 矢量编辑器，每个任务一个，叠在窗口里设计面板的位置上（和内置浏览器同一套做法）。
// 页面的 CSP 放开了 WASM 和 eval（见 design.html），所以单独一个沙箱视图，preload 只有「文档改了」一个通知，外部网络一律拦掉。
// 主进程用 executeJavaScript 调页面里的 window.__diffraDesign。
// 每个任务的文档自动存到 userData/designs/<会话 id>.fig，重新打开时载入；删除任务时一起删
const PARTITION = 'diffra-design'
const RENDERER_DIR = join(import.meta.dirname, '../renderer')
// 画布启动（CanvasKit 加载、首次绘制）要面板显示过；智能体调用时面板没开就请界面打开，等这么久
const READY_WAIT_MS = 15_000
// 编辑停下来这么久后自动保存
const SAVE_DELAY_MS = 1_500
// 每个设计页带一份 CanvasKit 和字体（实测一个约 300MB），同时最多留这么多个，最久没显示的先存盘再卸载（下次用到时从文件载入）
const MAX_PAGES = 2
// 会话 id 拼进文件名，只接受 UUID 这类字符
const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const designToolResultSchema = z.object({
  text: z.string(),
  image: z.object({ mimeType: z.enum(PROMPT_IMAGE_TYPES), data: z.string() }).nullable(),
})

interface DesignPage {
  view: WebContentsView
  shown: boolean
  // 页面加载好、存过的文档也载入了
  loaded: Promise<void>
  lastShown: number
  // 改了还没存；saving 是正在写的那次
  dirty: boolean
  saveTimer: ReturnType<typeof setTimeout> | null
  saving: Promise<void> | null
}

function designFile(sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) throw new Error(`无效的会话 id：${sessionId}`)
  return join(app.getPath('userData'), 'designs', `${sessionId}.fig`)
}

async function writeAtomic(path: string, data: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  await writeFile(temp, data)
  await rename(temp, path)
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'

// 只放行应用自己的页面文件：开发时是 electron-vite 的开发服务器，打包后是 out/renderer 里的文件
function isAppRequest(url: string): boolean {
  if (/^(data|blob|devtools):/i.test(url)) return true
  if (/^file:/i.test(url)) {
    const path = relative(RENDERER_DIR, fileURLToPath(url))
    return !path.startsWith('..') && !isAbsolute(path)
  }
  const dev = process.env.ELECTRON_RENDERER_URL
  if (!dev) return false
  try {
    const target = new URL(url)
    const origin = new URL(dev)
    return target.hostname === origin.hostname && target.port === origin.port
  } catch {
    return false
  }
}

export class DesignHost {
  private readonly pages = new Map<string, DesignPage>()
  // 用设计面板的会话：设计任务，或者这次运行里打开过设计面板的任务
  private readonly enabled = new Set<string>()
  private sessionReady = false

  private window(): BrowserWindow | null {
    return BrowserWindow.getAllWindows()[0] ?? null
  }

  private prepareSession(): void {
    if (this.sessionReady) return
    this.sessionReady = true
    const designSession = electronSession.fromPartition(PARTITION)
    // 只给读系统字体：内置字体没有中文，中文要回退到系统装的微软雅黑等（引擎通过 Local Font Access 读）。其他权限一律拒绝
    designSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'local-fonts'))
    designSession.setPermissionCheckHandler((_contents, permission) => permission === 'local-fonts')
    designSession.on('will-download', (event) => event.preventDefault())
    designSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isAppRequest(details.url) }))
  }

  private ensure(sessionId: string): DesignPage {
    const existing = this.pages.get(sessionId)
    if (existing && !existing.view.webContents.isDestroyed()) return existing
    const window = this.window()
    if (!window) throw new Error('应用窗口还没打开')
    this.prepareSession()
    this.evictBeyondLimit(sessionId)
    const view = new WebContentsView({
      webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, preload: join(import.meta.dirname, '../preload/design.cjs') },
    })
    view.setVisible(false)
    window.contentView.addChildView(view)
    const contents = view.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.on('console-message', (event) => {
      // 开发模式下 Electron 会对放开 unsafe-eval 的 CSP 报安全警告，这个页面是有意放开的
      if (event.message.startsWith('%cElectron Security Warning') || event.message.startsWith('Electron Security Warning')) return
      if (event.level === 'error' || event.level === 'warning') console.error(`[design] ${event.level}: ${event.message}`)
    })
    const rendererUrl = process.env.ELECTRON_RENDERER_URL
    const loading = rendererUrl ? contents.loadURL(`${rendererUrl}/design.html`) : contents.loadFile(join(RENDERER_DIR, 'design.html'))
    const page: DesignPage = { view, shown: false, loaded: loading.then(() => this.restore(sessionId, contents)), lastShown: Date.now(), dirty: false, saveTimer: null, saving: null }
    page.loaded.catch((error: unknown) => console.error('[design] 设计页加载失败', error))
    this.pages.set(sessionId, page)
    return page
  }

  // 载入这个任务存过的文档；没存过就是空白文档
  private async restore(sessionId: string, contents: Electron.WebContents): Promise<void> {
    const data = await readFile(designFile(sessionId)).catch((error: unknown) => {
      if (isMissing(error)) return null
      throw error
    })
    if (data) await contents.executeJavaScript(`window.__diffraDesign.openFig(${JSON.stringify(data.toString('base64'))})`, true)
  }

  private evictBeyondLimit(keep: string): void {
    const candidates = [...this.pages.entries()].filter(([id, page]) => id !== keep && !page.shown).sort((a, b) => a[1].lastShown - b[1].lastShown)
    let count = this.pages.size
    while (count >= MAX_PAGES && candidates.length > 0) {
      const [id] = candidates.shift()!
      count--
      this.unload(id).catch((error: unknown) => console.error('[design] 卸载设计页失败', error))
    }
  }

  // 设计页说文档改了：攒一会儿再存
  changed(contents: Electron.WebContents): void {
    const entry = [...this.pages.entries()].find(([, page]) => page.view.webContents === contents)
    if (!entry) return
    const [sessionId, page] = entry
    page.dirty = true
    if (page.saveTimer) clearTimeout(page.saveTimer)
    page.saveTimer = setTimeout(() => {
      page.saveTimer = null
      this.save(sessionId).catch((error: unknown) => console.error('[design] 自动保存失败', error))
    }, SAVE_DELAY_MS)
  }

  // 存一次；正在存的那次先写完，两次写不交错
  private async save(sessionId: string): Promise<void> {
    const page = this.pages.get(sessionId)
    if (!page) return
    if (page.saveTimer) {
      clearTimeout(page.saveTimer)
      page.saveTimer = null
    }
    await page.saving
    if (!page.dirty || page.view.webContents.isDestroyed()) return
    page.dirty = false
    const writing = (async () => {
      const base64 = await this.call<string>(sessionId, 'saveFig')
      await writeAtomic(designFile(sessionId), Buffer.from(base64, 'base64'))
    })()
    page.saving = writing
    try {
      await writing
    } catch (error) {
      page.dirty = true
      throw error
    } finally {
      page.saving = null
    }
  }

  hasUnsaved(): boolean {
    return [...this.pages.values()].some((page) => page.dirty || page.saving !== null)
  }

  // 应用退出前把还没存的都存上
  async flushAll(): Promise<void> {
    await Promise.all([...this.pages.keys()].map((id) => this.save(id).catch((error: unknown) => console.error('[design] 退出前保存失败', error))))
  }

  // 卸载设计页：先存盘，下次用到时从文件载入。设计工具的配置留着
  private async unload(sessionId: string): Promise<void> {
    await this.save(sessionId)
    this.destroy(sessionId)
  }

  private destroy(sessionId: string): void {
    const page = this.pages.get(sessionId)
    if (!page) return
    if (page.saveTimer) clearTimeout(page.saveTimer)
    this.pages.delete(sessionId)
    this.window()?.contentView.removeChildView(page.view)
    if (!page.view.webContents.isDestroyed()) page.view.webContents.close()
  }

  // 面板的位置；null 表示面板没显示（或者被弹窗盖着）。同一时间只显示一个任务的设计页
  setBounds(sessionId: string, rect: BrowserRect | null): void {
    for (const [id, page] of this.pages) {
      if (id === sessionId && rect) continue
      page.shown = false
      page.view.setVisible(false)
    }
    if (!rect) return
    const page = this.ensure(sessionId)
    page.view.setBounds({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)) })
    page.shown = true
    page.lastShown = Date.now()
    page.view.setVisible(true)
    this.enabled.add(sessionId)
  }

  enable(sessionId: string): void {
    this.enabled.add(sessionId)
  }

  // 每轮开始前把设计页的工具和说明配置给 core 的会话：core 重新加载会话（比如重开应用后打开任务）时会丢掉它
  async prepare(sessionId: string): Promise<void> {
    if (!this.enabled.has(sessionId)) return
    const design = await this.call<SessionDesign>(sessionId, 'session')
    await configureSession(await coreConnection(), sessionId, { design })
  }

  // 智能体调用设计工具。界面上把这个任务的设计面板打开，用户能看到在画什么
  async act({ sessionId, tool, args }: DesignActionParams): Promise<DesignActionResult> {
    this.window()?.webContents.send(IPC_CHANNELS.designActivity, { sessionId })
    const deadline = Date.now() + READY_WAIT_MS
    while (!(await this.call<boolean>(sessionId, 'ready'))) {
      if (Date.now() > deadline) throw new Error('设计面板的画布还没启动（这个任务不在前台），用户切到这个任务、打开设计面板后再试')
      await sleep(100)
    }
    return designToolResultSchema.parse(await this.call(sessionId, 'run', tool, args))
  }

  // 删除任务：关掉设计页，存过的文档一起删
  async remove(sessionId: string): Promise<void> {
    this.enabled.delete(sessionId)
    const page = this.pages.get(sessionId)
    if (page) {
      page.dirty = false
      await page.saving?.catch(() => {})
      this.destroy(sessionId)
    }
    await rm(designFile(sessionId), { force: true })
  }

  private async call<T>(sessionId: string, method: string, ...args: unknown[]): Promise<T> {
    const page = this.ensure(sessionId)
    await page.loaded
    const argList = args.map((arg) => JSON.stringify(arg)).join(', ')
    return (await page.view.webContents.executeJavaScript(`window.__diffraDesign.${method}(${argList})`, true)) as T
  }

  async openFile(sessionId: string): Promise<string | null> {
    const window = this.window()
    if (!window) return null
    const picked = await dialog.showOpenDialog(window, { title: '打开设计文件', filters: [{ name: 'Figma 文件', extensions: ['fig'] }], properties: ['openFile'] })
    const path = picked.filePaths[0]
    if (picked.canceled || !path) return null
    const data = await readFile(path)
    await this.call(sessionId, 'openFig', data.toString('base64'))
    return path
  }

  // 另存一份 .fig，默认放在项目文件夹里；自动保存的那份不受影响
  async saveFile(sessionId: string, projectPath: string): Promise<string | null> {
    const window = this.window()
    if (!window) return null
    const base64 = await this.call<string>(sessionId, 'saveFig')
    const picked = await dialog.showSaveDialog(window, { title: '另存设计文件', defaultPath: join(projectPath, '设计.fig'), filters: [{ name: 'Figma 文件', extensions: ['fig'] }] })
    if (picked.canceled || !picked.filePath) return null
    await writeFile(picked.filePath, Buffer.from(base64, 'base64'))
    return picked.filePath
  }
}

export const designHost = new DesignHost()

export function registerDesignIpc(): void {
  ipcMain.on(IPC_CHANNELS.designBounds, (_event, rawSessionId: unknown, rawRect: unknown) => {
    const sessionId = parse(z.string().min(1), rawSessionId)
    const rect = parse(z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable(), rawRect)
    try {
      designHost.setBounds(sessionId, rect)
    } catch (error) {
      console.error('[design] 设置面板位置失败', error)
    }
  })
  ipcMain.handle(IPC_CHANNELS.designOpenFile, (_event, rawSessionId: unknown) => designHost.openFile(parse(z.string().min(1), rawSessionId)))
  ipcMain.handle(IPC_CHANNELS.designSaveFile, (_event, rawSessionId: unknown, rawProjectPath: unknown) =>
    designHost.saveFile(parse(z.string().min(1), rawSessionId), parse(z.string().min(1), rawProjectPath)),
  )
  ipcMain.on(IPC_CHANNELS.designChanged, (event) => designHost.changed(event.sender))
}
