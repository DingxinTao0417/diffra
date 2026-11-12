import { randomUUID } from 'node:crypto'
import { type IPty, spawn } from 'node-pty'
import { logRemote } from '../app-log'
import { defaultShell } from '../terminal-ipc'

// 开放了「完全控制」的设备在本机开的终端（docs/decisions.md「设备连接」）：起始目录是项目目录，shell 本身不受项目限制。
// 输出攒一小会儿一批发；积压太多就丢掉中间、留一句说明：中转每秒约 200 KB，一个终端狂刷不能占满发给这台设备的通道（会话同步也走它）。
// 每台设备最多开几个；通道断了、降级、撤销时由 HostSync 全部结束

const MAX_PER_DEVICE = 3
const FLUSH_MS = 30
const MAX_BATCH_CHARS = 64 * 1024
const MAX_PENDING_CHARS = 512 * 1024

interface Entry {
  deviceId: string
  cwd: string
  pty: IPty
  pending: string
  dropped: number
  timer: NodeJS.Timeout | null
}

export interface HostTerminalsDeps {
  send(deviceId: string, message: unknown): boolean
  // 开着的远程终端数变了（本机横幅显示）
  changed(): void
}

export class HostTerminals {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly deps: HostTerminalsDeps) {}

  count(deviceId: string): number {
    let count = 0
    for (const entry of this.entries.values()) if (entry.deviceId === deviceId) count++
    return count
  }

  open(deviceId: string, cwd: string, size: { cols: number; rows: number }): string {
    if (this.count(deviceId) >= MAX_PER_DEVICE) throw new Error(`最多同时开 ${MAX_PER_DEVICE} 个远程终端`)
    const shell = defaultShell()
    const pty = spawn(shell.file, shell.args, { name: 'xterm-256color', cols: size.cols, rows: size.rows, cwd, env: process.env })
    const id = randomUUID()
    const entry: Entry = { deviceId, cwd, pty, pending: '', dropped: 0, timer: null }
    this.entries.set(id, entry)
    pty.onData((data) => {
      entry.pending += data
      if (entry.pending.length > MAX_PENDING_CHARS) {
        entry.dropped += entry.pending.length - MAX_PENDING_CHARS
        entry.pending = entry.pending.slice(-MAX_PENDING_CHARS)
      }
      entry.timer ??= setTimeout(() => this.flush(id), FLUSH_MS)
    })
    pty.onExit(({ exitCode }) => {
      if (this.entries.get(id) !== entry) return
      this.flush(id)
      this.entries.delete(id)
      this.deps.send(deviceId, { type: 'event', event: 'terminal.exit', terminalId: id, exitCode })
      this.deps.changed()
    })
    this.deps.changed()
    return id
  }

  input(deviceId: string, id: string, data: string): void {
    this.owned(deviceId, id).pty.write(data)
  }

  resize(deviceId: string, id: string, size: { cols: number; rows: number }): void {
    this.owned(deviceId, id).pty.resize(size.cols, size.rows)
  }

  close(deviceId: string, id: string): void {
    this.owned(deviceId, id)
    this.kill(id)
  }

  closeDevice(deviceId: string): void {
    this.prune((owner) => owner !== deviceId)
  }

  // 授权改了：只留下 keep 说还能留的（项目还开放着「完全控制」）
  prune(keep: (deviceId: string, cwd: string) => boolean): void {
    for (const [id, entry] of [...this.entries]) if (!keep(entry.deviceId, entry.cwd)) this.kill(id)
  }

  private owned(deviceId: string, id: string): Entry {
    const entry = this.entries.get(id)
    if (!entry || entry.deviceId !== deviceId) throw new Error('这个终端已经关了')
    return entry
  }

  private kill(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    if (entry.timer) clearTimeout(entry.timer)
    try {
      entry.pty.kill()
    } catch (error) {
      logRemote(`结束远程终端 ${id.slice(0, 8)} 失败`, error)
    }
    this.deps.send(entry.deviceId, { type: 'event', event: 'terminal.exit', terminalId: id, exitCode: null })
    this.deps.changed()
  }

  private flush(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.timer = null
    if (entry.dropped > 0) {
      entry.pending = `\r\n[输出太多，省略了 ${entry.dropped} 个字符]\r\n${entry.pending}`
      entry.dropped = 0
    }
    const data = entry.pending.slice(0, MAX_BATCH_CHARS)
    entry.pending = entry.pending.slice(data.length)
    if (data) this.deps.send(entry.deviceId, { type: 'event', event: 'terminal.data', terminalId: id, data })
    if (entry.pending) entry.timer = setTimeout(() => this.flush(id), FLUSH_MS)
  }
}
