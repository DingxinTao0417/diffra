import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ComputerActionParams, ComputerActionResult } from '@diffra/core/types'
import { desktopCapturer, ipcMain, type NativeImage, nativeImage, screen } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc'
import type { ComputerAuditEntry, ComputerStatus } from '../../shared/settings'
import type { SettingsStore } from '../settings-store'
import { testOverridesAllowed } from '../test-overrides'
import { FakeDriver, type InputDriver, platformSupported, ScriptDriver, type ScreenPoint } from './driver'
import { parseKeys, textSegments } from './keys'

// 电脑操控（v2 · M5）：core 发来的每一步在这里做——先看设置里还开着没有（关掉立即生效），截屏、换算坐标、发鼠标键盘事件，
// 每步有时限，做完（或失败）记一条审计。只操作主屏幕
const MAX_SHOT_WIDTH = 1280
const THUMB_WIDTH = 480
const ACTION_TIMEOUT_MS = 20_000
// 驱动进程闲置这么久就结束，下次用到再起
const IDLE_STOP_MS = 5 * 60_000
const AUDIT_FILE = 'computer-audit.jsonl'
const AUDIT_KEEP = 1000
const AUDIT_SHOW = 200
const DRAG_STEPS = 10
const STEP_DELAY_MS = 30
const DOUBLE_CLICK_GAP_MS = 60

interface Shot {
  // 截图的像素尺寸和当时的主屏幕（逻辑像素）
  width: number
  height: number
  display: Electron.Rectangle
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([promise, new Promise<never>((_resolve, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))]).finally(() => clearTimeout(timer))
}

const fakeMode = () => testOverridesAllowed() && process.env.DIFFRA_COMPUTER_DRIVER === 'fake'

// 这台电脑支不支持：Windows、macOS；测试的假驱动哪都行
export function computerSupported(): boolean {
  return fakeMode() || platformSupported()
}

export function computerEnabled(settings: SettingsStore | null): boolean {
  return computerSupported() && settings?.get().computerUse?.enabled === true
}

// 审计里的一句话：输入的文字只记字数（可能是密码），按键、坐标照记
function describe(action: ComputerActionParams): string {
  switch (action.action) {
    case 'screenshot':
      return '截屏'
    case 'cursor':
      return '读鼠标位置'
    case 'click':
      return `${action.button === 'right' ? '右键单击' : action.count === 2 ? '双击' : '单击'} (${Math.round(action.x)}, ${Math.round(action.y)})`
    case 'move':
      return `移动到 (${Math.round(action.x)}, ${Math.round(action.y)})`
    case 'drag':
      return `从 (${Math.round(action.x)}, ${Math.round(action.y)}) 拖到 (${Math.round(action.toX)}, ${Math.round(action.toY)})`
    case 'type':
      return `输入 ${[...action.text].length} 个字`
    case 'key':
      return `按 ${action.keys}`
    case 'scroll':
      return `在 (${Math.round(action.x)}, ${Math.round(action.y)}) 滚动 ${action.direction} ${action.amount} 格`
  }
}

export class ComputerHost {
  private driver: InputDriver | null = null
  private idleTimer: NodeJS.Timeout | null = null
  // 每个任务最近一张截图：坐标按它换算
  private readonly shots = new Map<string, Shot>()
  private auditQueue: Promise<unknown> = Promise.resolve()
  private settings: SettingsStore | null = null
  private userDataDir = ''

  // 启动时：知道设置和数据目录（审计记录、驱动脚本放在数据目录里）
  start(settings: SettingsStore, userDataDir: string): void {
    this.settings = settings
    this.userDataDir = userDataDir
  }

  status(): ComputerStatus {
    return { supported: computerSupported(), platform: process.platform }
  }

  private auditPath(): string {
    return join(this.userDataDir, AUDIT_FILE)
  }

  private input(): InputDriver {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.stop(), IDLE_STOP_MS)
    this.idleTimer.unref()
    if (!this.driver) {
      const log = process.env.DIFFRA_COMPUTER_LOG
      this.driver = fakeMode() && log ? new FakeDriver(log) : new ScriptDriver(join(this.userDataDir, 'computer'))
    }
    return this.driver
  }

  stop(): void {
    this.driver?.dispose()
    this.driver = null
  }

  forget(sessionId: string): void {
    this.shots.delete(sessionId)
  }

  private display(): Electron.Rectangle {
    if (fakeMode()) return { x: 0, y: 0, width: 1600, height: 900 }
    return screen.getPrimaryDisplay().bounds
  }

  private async capture(width: number, height: number): Promise<NativeImage> {
    if (fakeMode()) {
      // 假屏幕：灰色底上一块蓝色方块，看得出是张图就行
      const pixels = Buffer.alloc(width * height * 4)
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const offset = (y * width + x) * 4
          const box = x > width / 4 && x < width / 2 && y > height / 4 && y < height / 2
          pixels.set(box ? [220, 120, 40, 255] : [235, 235, 235, 255], offset)
        }
      return nativeImage.createFromBitmap(pixels, { width, height })
    }
    const primary = screen.getPrimaryDisplay()
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } })
    const source = sources.find((item) => item.display_id === String(primary.id)) ?? sources[0]
    const image = source?.thumbnail
    if (!image || image.isEmpty()) {
      throw new Error(process.platform === 'darwin' ? '截不到屏幕：请在「系统设置 → 隐私与安全性 → 屏幕录制」里允许 Diffra，再重新打开 Diffra' : '截不到屏幕')
    }
    return image
  }

  private async screenshot(sessionId: string): Promise<ComputerActionResult> {
    const display = this.display()
    const width = Math.min(MAX_SHOT_WIDTH, display.width)
    const height = Math.round((display.height * width) / display.width)
    const image = await this.capture(width, height)
    const size = image.getSize()
    this.shots.set(sessionId, { width: size.width, height: size.height, display })
    const thumb = image.resize({ width: Math.min(THUMB_WIDTH, size.width) })
    return {
      text: `屏幕 ${display.width}×${display.height}（逻辑像素），截图 ${size.width}×${size.height}。坐标按这张截图的像素算。`,
      image: { mimeType: 'image/jpeg', data: image.toJPEG(70).toString('base64') },
      thumbnail: { mimeType: 'image/jpeg', data: thumb.toJPEG(60).toString('base64') },
    }
  }

  // 截图上的点换成主屏幕上的点；没截过图或者超出截图的报错
  private point(sessionId: string, x: number, y: number): ScreenPoint {
    const shot = this.shots.get(sessionId)
    if (!shot) throw new Error('先截一张屏幕截图（action: screenshot），坐标按截图的像素算')
    if (x > shot.width || y > shot.height) throw new Error(`坐标 (${x}, ${y}) 超出了截图（${shot.width}×${shot.height}）`)
    const fx = x / shot.width
    const fy = y / shot.height
    return { fx, fy, x: shot.display.x + fx * shot.display.width, y: shot.display.y + fy * shot.display.height }
  }

  private async press(input: InputDriver, keys: string): Promise<void> {
    const combo = parseKeys(keys)
    for (const modifier of combo.modifiers) await input.key(modifier, true)
    try {
      if (combo.key) {
        await input.key(combo.key, true)
        await input.key(combo.key, false)
      }
    } finally {
      for (const modifier of [...combo.modifiers].reverse()) await input.key(modifier, false)
    }
  }

  private async perform(action: ComputerActionParams): Promise<ComputerActionResult> {
    const { sessionId } = action
    switch (action.action) {
      case 'screenshot':
        return this.screenshot(sessionId)
      case 'cursor': {
        const position = await this.input().cursor()
        const shot = this.shots.get(sessionId)
        return { text: shot ? `鼠标在截图的 (${Math.round(position.fx * shot.width)}, ${Math.round(position.fy * shot.height)})` : `鼠标在屏幕宽 ${Math.round(position.fx * 100)}%、高 ${Math.round(position.fy * 100)}% 处（先截图才能换算成截图坐标）`, image: null }
      }
      case 'click': {
        const input = this.input()
        await input.move(this.point(sessionId, action.x, action.y))
        for (let click = 1; click <= action.count; click++) {
          await input.button(action.button, true, click)
          await input.button(action.button, false, click)
          if (click < action.count) await sleep(DOUBLE_CLICK_GAP_MS)
        }
        return { text: `${describe(action)}，再截图看看结果`, image: null }
      }
      case 'move':
        await this.input().move(this.point(sessionId, action.x, action.y))
        return { text: describe(action), image: null }
      case 'drag': {
        const input = this.input()
        const from = this.point(sessionId, action.x, action.y)
        const to = this.point(sessionId, action.toX, action.toY)
        await input.move(from)
        await input.button('left', true, 1)
        try {
          for (let step = 1; step <= DRAG_STEPS; step++) {
            const t = step / DRAG_STEPS
            await input.move({ fx: from.fx + (to.fx - from.fx) * t, fy: from.fy + (to.fy - from.fy) * t, x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })
            await sleep(STEP_DELAY_MS)
          }
        } finally {
          await input.button('left', false, 1)
        }
        return { text: `${describe(action)}，再截图看看结果`, image: null }
      }
      case 'type': {
        const input = this.input()
        for (const segment of textSegments(action.text)) {
          if ('key' in segment) await this.press(input, segment.key)
          else await input.text(segment.text)
        }
        return { text: `${describe(action)}，再截图看看结果`, image: null }
      }
      case 'key':
        await this.press(this.input(), action.keys)
        return { text: `${describe(action)}，再截图看看结果`, image: null }
      case 'scroll': {
        const input = this.input()
        await input.move(this.point(sessionId, action.x, action.y))
        const dx = action.direction === 'left' ? -action.amount : action.direction === 'right' ? action.amount : 0
        const dy = action.direction === 'up' ? -action.amount : action.direction === 'down' ? action.amount : 0
        await input.wheel(dx, dy)
        return { text: describe(action), image: null }
      }
    }
  }

  async act(action: ComputerActionParams): Promise<ComputerActionResult> {
    const started = Date.now()
    const detail = describe(action)
    try {
      if (!this.userDataDir || !computerEnabled(this.settings)) throw new Error('电脑操控在设置里关掉了（或者这台电脑不支持），不要再试，告诉用户')
      const result = await withTimeout(this.perform(action), ACTION_TIMEOUT_MS, `这一步 ${ACTION_TIMEOUT_MS / 1000} 秒没做完`)
      this.audit({ at: new Date().toISOString(), sessionId: action.sessionId, action: action.action, detail, ok: true, error: null, ms: Date.now() - started })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.audit({ at: new Date().toISOString(), sessionId: action.sessionId, action: action.action, detail, ok: false, error: message, ms: Date.now() - started })
      throw error
    }
  }

  // 审计记录：一行一条，超过 2 倍上限时只留最近的；写失败只记日志，不挡操作
  private audit(entry: ComputerAuditEntry): void {
    this.auditQueue = this.auditQueue
      .then(async () => {
        await appendFile(this.auditPath(), `${JSON.stringify(entry)}\n`, 'utf8')
        const lines = (await readFile(this.auditPath(), 'utf8')).split('\n').filter(Boolean)
        if (lines.length > AUDIT_KEEP * 2) await writeFile(this.auditPath(), `${lines.slice(-AUDIT_KEEP).join('\n')}\n`, 'utf8')
      })
      .catch((error: unknown) => console.error('[computer] 写审计记录失败', error))
  }

  async auditEntries(): Promise<ComputerAuditEntry[]> {
    await this.auditQueue
    const text = await readFile(this.auditPath(), 'utf8').catch(() => '')
    const entries: ComputerAuditEntry[] = []
    for (const line of text.split('\n').filter(Boolean).slice(-AUDIT_SHOW)) {
      try {
        entries.push(JSON.parse(line) as ComputerAuditEntry)
      } catch {
        // 坏行跳过
      }
    }
    return entries.reverse()
  }

  async clearAudit(): Promise<void> {
    await this.auditQueue
    await writeFile(this.auditPath(), '', 'utf8')
  }
}

export const computerHost = new ComputerHost()

export function registerComputerIpc(): void {
  ipcMain.handle(IPC_CHANNELS.computerStatus, () => computerHost.status())
  ipcMain.handle(IPC_CHANNELS.computerAudit, () => computerHost.auditEntries())
  ipcMain.handle(IPC_CHANNELS.computerAuditClear, () => computerHost.clearAudit())
}
