import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, sep } from 'node:path'
import { localUrlIn } from '@diffra/core'
import type { DevServerParams, DevServerResult } from '@diffra/core/types'
import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { type IPty, spawn } from 'node-pty'
import { z } from 'zod'
import { IPC_CHANNELS } from '../shared/ipc'
import { parse } from './ipc-input'
import { redactTerminalOutput, TERMINAL_MAX_LINES } from '../shared/terminal-output'

// 同时开着的终端上限，防止界面出错时不停地开进程
const MAX_TERMINALS = 8

const sizeSchema = z.object({ cols: z.number().int().min(2).max(1000), rows: z.number().int().min(1).max(500) })
const idSchema = z.string().min(1)

interface TerminalEntry {
  cwd: string
  pty: IPty
  owner: WebContents
  // 开发服务器的终端留着最近的输出（去掉颜色控制符），给智能体看
  output: string | null
  exited: boolean
  // 开发服务器的终端：输出里第一次出现本地地址时告诉界面（任务监控「运行中」），之后不再找
  url?: string | null
}

// 开发服务器：一个任务一个，跑在终端里
const DEV_SERVER_WAIT_MS = 60_000
const MAX_OUTPUT_CHARS = 64_000
const LOG_LINES = 80
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g
const devServers = new Map<string, { terminalId: string; command: string }>()
// 结束终端后等它退出的上限
const EXIT_WAIT_MS = 5000

const terminals = new Map<string, TerminalEntry>()
// 已经挂了清理监听的窗口
const watched = new WeakSet<WebContents>()

// Windows 用 PowerShell（系统自带，和 VS Code 的默认一致）；其他系统用登录 shell
export function defaultShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo'] }
  return { file: process.env.SHELL || '/bin/bash', args: ['-l'] }
}

function killTerminal(id: string): void {
  const entry = terminals.get(id)
  if (!entry) return
  terminals.delete(id)
  try {
    entry.pty.kill()
  } catch (error) {
    console.error(`[terminal] 结束终端 ${id} 失败`, error)
  }
}

// 等进程真正退出：Windows 上进程还在时，它的当前目录删不掉也移不走
function killTerminalAndWait(id: string): Promise<void> {
  const entry = terminals.get(id)
  if (!entry) return Promise.resolve()
  let timer: NodeJS.Timeout | undefined
  const exited = new Promise<void>((resolve) => {
    entry.pty.onExit(() => resolve())
    timer = setTimeout(resolve, EXIT_WAIT_MS)
  })
  killTerminal(id)
  return exited.finally(() => clearTimeout(timer))
}

function killOwnedBy(owner: WebContents): void {
  for (const [id, entry] of terminals) if (entry.owner === owner) killTerminal(id)
}

// 只有开这个终端的窗口能写、改大小、关掉它
function ownedEntry(id: string, sender: WebContents): TerminalEntry | null {
  const entry = terminals.get(id)
  return entry && entry.owner === sender ? entry : null
}

async function openTerminal(
  owner: WebContents,
  cwd: string,
  shell: { file: string; args: string[] },
  size: { cols: number; rows: number },
  devServer = false,
): Promise<string> {
  if (!(await stat(cwd).catch(() => null))?.isDirectory()) throw new Error(`目录不存在：${cwd}`)
  if (terminals.size >= MAX_TERMINALS) throw new Error(`最多同时开 ${MAX_TERMINALS} 个终端，先关掉几个`)
  // 页面刷新或窗口关掉时，这个窗口开的终端一起结束
  if (!watched.has(owner)) {
    watched.add(owner)
    owner.on('destroyed', () => killOwnedBy(owner))
    owner.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) killOwnedBy(owner)
    })
  }
  const pty = spawn(shell.file, shell.args, { name: 'xterm-256color', cols: size.cols, rows: size.rows, cwd, env: process.env })
  const id = randomUUID()
  const entry: TerminalEntry = { cwd, pty, owner, output: '', exited: false, ...(devServer ? { url: null } : {}) }
  terminals.set(id, entry)
  pty.onData((data) => {
    if (entry.output !== null) entry.output = (entry.output + data.replace(ANSI, '')).slice(-MAX_OUTPUT_CHARS)
    if (!owner.isDestroyed()) owner.send(IPC_CHANNELS.terminalData, { id, data })
    if (entry.url === null && entry.output !== null) {
      entry.url = localUrlIn(entry.output)
      if (entry.url && !owner.isDestroyed()) owner.send(IPC_CHANNELS.terminalUrl, { id, url: entry.url })
    }
  })
  pty.onExit(({ exitCode }) => {
    entry.exited = true
    terminals.delete(id)
    if (!owner.isDestroyed()) owner.send(IPC_CHANNELS.terminalExit, { id, exitCode })
  })
  return id
}

const tail = (output: string) => output.split(/\r?\n/).slice(-LOG_LINES).join('\n').trim()

// 智能体起开发服务器：开一个终端标签页跑命令，等它打出本地地址（最多一分钟）
export async function devServer(params: DevServerParams): Promise<DevServerResult> {
  if (params.action === 'terminal-list' || params.action === 'terminal-read') {
    const owner = BrowserWindow.getAllWindows()[0]?.webContents
    if (!owner) throw new Error('应用窗口还没打开')
    if (params.action === 'terminal-list') {
      return { text: [...terminals].filter(([, entry]) => entry.owner === owner).map(([id, entry]) => `${id} · ${entry.cwd} · ${entry.exited ? '已退出' : '运行中'}`).join('\n') || '没有可读取的终端', url: null }
    }
    const lines = parse(z.number().int().min(1).max(TERMINAL_MAX_LINES), params.lines)
    const entry = ownedEntry(parse(z.string().uuid(), params.terminalId), owner)
    if (!entry) throw new Error('终端不存在或不属于当前窗口')
    return { text: redactTerminalOutput((entry.output ?? '').split(/\r?\n/).slice(-lines).join('\n')) || '（暂无输出）', url: null }
  }
  const running = devServers.get(params.sessionId)
  const entry = running ? terminals.get(running.terminalId) : undefined
  if (params.action === 'stop') {
    if (!running || !entry) return { text: '这个任务没有在运行的开发服务器。', url: null }
    devServers.delete(params.sessionId)
    killTerminal(running.terminalId)
    return { text: `已停止：${running.command}`, url: null }
  }
  if (params.action === 'logs') {
    if (!running) return { text: '这个任务还没有起开发服务器。', url: null }
    const output = entry?.output ?? ''
    return { text: `${entry ? '运行中' : '已退出'}：${running.command}\n${tail(output) || '（还没有输出）'}`, url: localUrlIn(output) }
  }
  if (running && entry) {
    const output = entry.output ?? ''
    return { text: `已经在运行：${running.command}\n地址：${localUrlIn(output) ?? '还没看到'}\n${tail(output)}`, url: localUrlIn(output) }
  }
  const owner = BrowserWindow.getAllWindows()[0]?.webContents
  if (!owner) throw new Error('应用窗口还没打开')
  const shell =
    process.platform === 'win32'
      ? { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-Command', params.command] }
      : { file: process.env.SHELL || '/bin/bash', args: ['-lc', params.command] }
  const terminalId = await openTerminal(owner, params.cwd, shell, { cols: 120, rows: 30 }, true)
  devServers.set(params.sessionId, { terminalId, command: params.command })
  owner.send(IPC_CHANNELS.terminalOpened, { id: terminalId, cwd: params.cwd, shell: '开发服务器', devServer: { sessionId: params.sessionId, command: params.command } })
  const started = Date.now()
  const opened = terminals.get(terminalId)
  while (Date.now() - started < DEV_SERVER_WAIT_MS) {
    const output = opened?.output ?? ''
    const url = localUrlIn(output)
    if (url) return { text: `已启动：${params.command}\n地址：${url}\n${tail(output)}`, url }
    if (!opened || opened.exited) return { text: `命令退出了：${params.command}\n${tail(output) || '（没有输出）'}`, url: null }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return { text: `已经在跑，但一分钟内没看到本地地址：${params.command}\n${tail(opened?.output ?? '')}\n可以用 dev_server_logs 再看输出。`, url: null }
}

export async function stopDevServer(sessionId: string): Promise<void> {
  const running = devServers.get(sessionId)
  if (!running) return
  devServers.delete(sessionId)
  await killTerminalAndWait(running.terminalId)
}

// path 是 dir 本身或在它下面；Windows 路径不分大小写
export function pathInside(dir: string, path: string): boolean {
  const rel = process.platform === 'win32' ? relative(dir.toLowerCase(), path.toLowerCase()) : relative(dir, path)
  return !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
}

// 结束起始目录在 dir 里（含子目录）的终端，等它们退出
export async function killTerminalsIn(dir: string): Promise<void> {
  await Promise.all([...terminals].filter(([, entry]) => pathInside(dir, entry.cwd)).map(([id]) => killTerminalAndWait(id)))
}

export function registerTerminalIpc(): void {
  ipcMain.handle(IPC_CHANNELS.terminalCreate, async (event, rawCwd: unknown, rawSize: unknown) => {
    const cwd = parse(z.string().min(1), rawCwd)
    const size = parse(sizeSchema, rawSize)
    const shell = defaultShell()
    const id = await openTerminal(event.sender, cwd, shell, size)
    return { id, shell: basename(shell.file) }
  })

  // 按键和改大小很频繁，用单向消息；参数不对只记日志
  ipcMain.on(IPC_CHANNELS.terminalWrite, (event, rawId: unknown, rawData: unknown) => {
    try {
      ownedEntry(parse(idSchema, rawId), event.sender)?.pty.write(parse(z.string().max(1_000_000), rawData))
    } catch (error) {
      console.error('[terminal] 写入失败', error)
    }
  })

  ipcMain.on(IPC_CHANNELS.terminalResize, (event, rawId: unknown, rawSize: unknown) => {
    try {
      const { cols, rows } = parse(sizeSchema, rawSize)
      ownedEntry(parse(idSchema, rawId), event.sender)?.pty.resize(cols, rows)
    } catch (error) {
      console.error('[terminal] 调整大小失败', error)
    }
  })

  ipcMain.handle(IPC_CHANNELS.terminalKill, (event, rawId: unknown) => {
    const id = parse(idSchema, rawId)
    if (ownedEntry(id, event.sender)) killTerminal(id)
  })
}

export function killAllTerminals(): void {
  for (const id of [...terminals.keys()]) killTerminal(id)
}
