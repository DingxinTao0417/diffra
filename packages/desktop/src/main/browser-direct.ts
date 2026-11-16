import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { BridgeCall, DiffraMessage, ExtensionMessage } from '../shared/browser-bridge'
import type { DirectChromeStatus } from '../shared/ipc'
import { BridgeConnection } from './browser-bridge'
import { sleep } from './browser-page'
import { testOverridesAllowed } from './test-overrides'

// 直接启动系统里装的 Chrome（v2 · M5）：不用装扩展，Diffra 自己的配置目录（userData/system-chrome，登录状态留在这里，和用户平时的 Chrome 分开），
// 开调试端口（只听 127.0.0.1，端口随机），WebSocket 连上去。Chrome 136 起不让默认配置开调试端口，所以只能用单独的配置。
// 在进程里模拟一个扩展连接（BridgeConnection）：标签页、投屏、PageAgent 都和经扩展的那条路共用
const LAUNCH_TIMEOUT_MS = 20_000
const CDP_TIMEOUT_MS = 30_000

export interface SystemChrome {
  path: string
  name: string
}

// 用户选的程序叫什么：按文件名认 Edge、Chromium，其余都叫 Chrome
function nameOf(path: string): string {
  const file = basename(path).toLowerCase()
  return file.includes('edge') ? 'Edge' : file.includes('chromium') ? 'Chromium' : 'Chrome'
}

// 用户在设置里选了程序就只用它（不在了返回 null，不偷偷换成别的）；没选就按 Chrome、Edge、Chromium 的顺序找常见位置
export function findSystemChrome(custom: string | null = null): SystemChrome | null {
  const override = testOverridesAllowed() ? process.env.DIFFRA_SYSTEM_CHROME : undefined
  if (override && !custom) return existsSync(override) ? { path: override, name: 'Chromium' } : null
  if (custom) return existsSync(custom) ? { path: custom, name: nameOf(custom) } : null
  const candidates: SystemChrome[] = []
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter((root): root is string => Boolean(root))
    for (const root of roots) candidates.push({ path: join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'), name: 'Chrome' })
    for (const root of roots) candidates.push({ path: join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), name: 'Edge' })
  } else if (process.platform === 'darwin') {
    const home = process.env.HOME ?? ''
    for (const base of ['/Applications', join(home, 'Applications')]) {
      candidates.push({ path: join(base, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'), name: 'Chrome' })
      candidates.push({ path: join(base, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'), name: 'Edge' })
      candidates.push({ path: join(base, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'), name: 'Chromium' })
    }
  } else if (process.platform === 'linux') {
    for (const file of ['google-chrome', 'google-chrome-stable']) candidates.push({ path: join('/usr/bin', file), name: 'Chrome' })
    candidates.push({ path: '/opt/google/chrome/chrome', name: 'Chrome' })
    for (const file of ['microsoft-edge', 'microsoft-edge-stable']) candidates.push({ path: join('/usr/bin', file), name: 'Edge' })
    for (const path of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium']) candidates.push({ path, name: 'Chromium' })
  }
  return candidates.find((candidate) => existsSync(candidate.path)) ?? null
}

// 设置里选程序时选到的是 macOS 的 .app：换成包里真正的可执行文件
export function resolveChromeExecutable(picked: string): string {
  if (process.platform !== 'darwin' || !picked.endsWith('.app')) return picked
  const app = basename(picked, '.app')
  return join(picked, 'Contents', 'MacOS', app)
}

interface Tab {
  targetId: string
  session: string | null
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

export interface DirectChromeListener {
  message(connection: BridgeConnection, message: ExtensionMessage): void
  closed(connection: BridgeConnection): void
  changed(): void
}

type CdpMessage = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string }; sessionId?: string }

const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {})

export class DirectChrome {
  private socket: WebSocket | null = null
  private connection: BridgeConnection | null = null
  private child: ChildProcess | null = null
  private starting: Promise<void> | null = null
  private port: number | null = null
  private browserName: string | null = null
  private lastError: string | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private nextTabId = 1
  private readonly tabs = new Map<number, Tab>()

  constructor(
    private readonly profileDir: string,
    private readonly listener: DirectChromeListener,
    // 设置里选的程序（v2）；没选是 null
    private readonly customPath: () => string | null = () => null,
  ) {}

  connections(): BridgeConnection[] {
    return this.connection && !this.connection.closed ? [this.connection] : []
  }

  status(): DirectChromeStatus {
    const custom = this.customPath()
    const found = findSystemChrome(custom)
    return {
      supported: true,
      executable: found?.path ?? null,
      name: this.browserName ?? found?.name ?? null,
      running: this.connections().length > 0,
      error: this.lastError,
      custom,
    }
  }

  start(): Promise<void> {
    if (this.connections().length > 0) return Promise.resolve()
    this.starting ??= this.launch()
      .then(
        () => {
          this.lastError = null
        },
        (error: unknown) => {
          this.lastError = error instanceof Error ? error.message : String(error)
          throw error
        },
      )
      .finally(() => {
        this.starting = null
        this.listener.changed()
      })
    return this.starting
  }

  private activePortFile(): string {
    return join(this.profileDir, 'DevToolsActivePort')
  }

  private async readActivePort(): Promise<{ port: number; path: string } | null> {
    const text = await readFile(this.activePortFile(), 'utf8').catch(() => null)
    const [port, path] = text?.trim().split(/\r?\n/) ?? []
    return port && path && /^\d+$/.test(port) ? { port: Number(port), path } : null
  }

  private async launch(): Promise<void> {
    const custom = this.customPath()
    const chrome = findSystemChrome(custom)
    if (!chrome) throw new Error(custom ? `设置里选的浏览器程序不在了：${custom}` : '没找到 Chrome、Edge 或 Chromium')
    await mkdir(this.profileDir, { recursive: true })
    // 上次 Diffra 启动的那个 Chrome 还开着（同一个配置目录只能开一个）：直接连上去
    const existing = await this.readActivePort()
    if (existing && (await this.connect(existing, chrome.name).then(() => true, () => false))) return
    await rm(this.activePortFile(), { force: true })
    const extra = testOverridesAllowed() ? (process.env.DIFFRA_SYSTEM_CHROME_ARGS ?? '').split(' ').filter(Boolean) : []
    const child = spawn(chrome.path, ['--remote-debugging-port=0', `--user-data-dir=${this.profileDir}`, '--no-first-run', '--no-default-browser-check', ...extra, 'about:blank'], { stdio: 'ignore' })
    this.child = child
    let exited: string | null = null
    child.once('error', (error) => (exited = error.message))
    child.once('exit', (code) => {
      exited ??= `退出码 ${code}`
      if (this.child === child) this.child = null
    })
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS
    while (Date.now() < deadline) {
      const active = await this.readActivePort()
      if (active) return this.connect(active, chrome.name)
      if (exited && !existsSync(this.activePortFile())) {
        // 交给了已经开着的同一配置的 Chrome 时这个进程会马上退出，再等一会儿端口文件
        await sleep(300)
        if (!(await this.readActivePort())) throw new Error(`${chrome.name} 没启动起来（${exited}）`)
        continue
      }
      await sleep(100)
    }
    if (this.child === child) child.kill()
    throw new Error(`${chrome.name} ${LAUNCH_TIMEOUT_MS / 1000} 秒内没启动好`)
  }

  private async connect(active: { port: number; path: string }, name: string): Promise<void> {
    const socket = new WebSocket(`ws://127.0.0.1:${active.port}${active.path}`)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连不上 Chrome 的调试端口')), 5000)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('连不上 Chrome 的调试端口'))
      })
    })
    this.socket = socket
    this.port = active.port
    this.browserName = name
    socket.addEventListener('message', (event) => this.receive(String(event.data)))
    socket.addEventListener('close', () => this.disconnected())
    await this.cdp('Target.setDiscoverTargets', { discover: true })
    const connection = new BridgeConnection({ write: (line) => this.fromDiffra(connection, line), destroy: () => this.socket?.close() })
    connection.browser = 'chrome'
    connection.extensionVersion = 'direct'
    connection.direct = true
    this.connection = connection
  }

  private disconnected(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('和 Chrome 的连接断了'))
    }
    this.pending.clear()
    this.tabs.clear()
    this.socket = null
    this.port = null
    const connection = this.connection
    this.connection = null
    if (connection) {
      connection.close()
      this.listener.closed(connection)
    }
    this.listener.changed()
  }

  // 关掉 Diffra 时：让它自己关（Browser.close），关不掉再结束进程
  async stop(): Promise<void> {
    if (this.socket) await this.cdp('Browser.close').catch(() => {})
    this.socket?.close()
    this.child?.kill()
  }

  private cdp(method: string, params?: Record<string, unknown>, session?: string): Promise<unknown> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Chrome 没有连上'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Chrome ${CDP_TIMEOUT_MS / 1000} 秒没有回应（${method}）`))
      }, CDP_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ id, method, params: params ?? {}, ...(session ? { sessionId: session } : {}) }))
    })
  }

  private tabOf(targetId: string): number | null {
    for (const [tabId, tab] of this.tabs) if (tab.targetId === targetId) return tabId
    return null
  }

  private tabOfSession(session: string): number | null {
    for (const [tabId, tab] of this.tabs) if (tab.session === session) return tabId
    return null
  }

  private track(targetId: string): number {
    const known = this.tabOf(targetId)
    if (known !== null) return known
    const tabId = this.nextTabId++
    this.tabs.set(tabId, { targetId, session: null })
    return tabId
  }

  private target(tabId: number): Tab {
    const tab = this.tabs.get(tabId)
    if (!tab) throw new Error('这个标签页已经关了')
    return tab
  }

  // Diffra 发给「扩展」的：调用在这里做完，结果按扩展的回复格式交回去
  private fromDiffra(connection: BridgeConnection, line: string): void {
    let message: DiffraMessage
    try {
      message = JSON.parse(line) as DiffraMessage
    } catch {
      return
    }
    if (message.type !== 'call') return
    const { id } = message
    this.call(message).then(
      (result) => connection.reply({ type: 'reply', id, result }),
      (error: unknown) => connection.reply({ type: 'reply', id, error: error instanceof Error ? error.message : String(error) }),
    )
  }

  private async call(call: BridgeCall): Promise<unknown> {
    switch (call.method) {
      case 'tabs.create': {
        const result = record(await this.cdp('Target.createTarget', { url: call.params.url || 'about:blank', background: !call.params.active }))
        return { tabId: this.track(String(result.targetId)) }
      }
      case 'tabs.close':
        await this.cdp('Target.closeTarget', { targetId: this.target(call.params.tabId).targetId })
        this.tabs.delete(call.params.tabId)
        return null
      case 'tabs.activate':
        await this.cdp('Target.activateTarget', { targetId: this.target(call.params.tabId).targetId })
        return null
      case 'tabs.release': {
        const tab = this.tabs.get(call.params.tabId)
        if (tab?.session) await this.cdp('Target.detachFromTarget', { sessionId: tab.session }).catch(() => {})
        this.tabs.delete(call.params.tabId)
        return null
      }
      // 直接启动的 Chrome 里不分组：整个配置都是 Diffra 的
      case 'groups.title':
        return null
      case 'debugger.attach': {
        const tab = this.target(call.params.tabId)
        const attached = record(await this.cdp('Target.attachToTarget', { targetId: tab.targetId, flatten: true }))
        tab.session = String(attached.sessionId)
        const info = record(record(await this.cdp('Target.getTargetInfo', { targetId: tab.targetId })).targetInfo)
        return { url: String(info.url ?? ''), title: String(info.title ?? ''), loading: false }
      }
      case 'cdp': {
        const tab = this.target(call.params.tabId)
        if (!tab.session) throw new Error('这个标签页还没接上调试')
        return this.cdp(call.params.method, call.params.params, tab.session)
      }
    }
  }

  private emit(message: ExtensionMessage): void {
    if (this.connection) this.listener.message(this.connection, message)
  }

  private receive(text: string): void {
    let message: CdpMessage
    try {
      message = JSON.parse(text) as CdpMessage
    } catch {
      return
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result ?? null)
      return
    }
    if (!message.method) return
    const params = message.params ?? {}
    if (message.sessionId) {
      const tabId = this.tabOfSession(message.sessionId)
      if (tabId !== null) this.emit({ type: 'event', tabId, method: message.method, params })
      return
    }
    const info = record(params.targetInfo)
    switch (message.method) {
      case 'Target.targetInfoChanged': {
        const tabId = info.type === 'page' ? this.tabOf(String(info.targetId)) : null
        if (tabId !== null) this.emit({ type: 'tab-updated', tabId, url: String(info.url ?? ''), title: String(info.title ?? ''), loading: false })
        return
      }
      // 智能体的标签页里的网页开了新窗口：也交给这个任务
      case 'Target.targetCreated': {
        const opener = typeof info.openerId === 'string' ? this.tabOf(info.openerId) : null
        if (info.type === 'page' && opener !== null) this.emit({ type: 'tab-opened', tabId: this.track(String(info.targetId)), openerTabId: opener })
        return
      }
      case 'Target.targetDestroyed': {
        const tabId = this.tabOf(String(params.targetId))
        if (tabId === null) return
        this.tabs.delete(tabId)
        this.emit({ type: 'tab-closed', tabId })
        return
      }
      case 'Target.detachedFromTarget': {
        const tabId = typeof params.sessionId === 'string' ? this.tabOfSession(params.sessionId) : null
        if (tabId === null) return
        this.target(tabId).session = null
        this.emit({ type: 'detached', tabId, reason: 'target_closed' })
        return
      }
    }
  }

  // 开发者工具：在这个 Chrome 里开一个新窗口，打开这个标签页的检查器
  async inspect(tabId: number): Promise<void> {
    const tab = this.target(tabId)
    if (!this.port) throw new Error('Chrome 没有连上')
    const url = `http://127.0.0.1:${this.port}/devtools/inspector.html?ws=127.0.0.1:${this.port}/devtools/page/${tab.targetId}`
    await this.cdp('Target.createTarget', { url, newWindow: true })
  }
}
