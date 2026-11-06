import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { ipcMain, type WebContents } from 'electron'
import { type IPty, spawn } from 'node-pty'
import { z } from 'zod'
import { IPC_CHANNELS } from '../shared/ipc'
import { parse } from './ipc-input'

// 同时开着的终端上限，防止界面出错时不停地开进程
const MAX_TERMINALS = 8

const sizeSchema = z.object({ cols: z.number().int().min(2).max(1000), rows: z.number().int().min(1).max(500) })
const idSchema = z.string().min(1)

interface TerminalEntry {
  pty: IPty
  owner: WebContents
}

const terminals = new Map<string, TerminalEntry>()
// 已经挂了清理监听的窗口
const watched = new WeakSet<WebContents>()

// Windows 用 PowerShell（系统自带，和 VS Code 的默认一致）；其他系统用登录 shell
function defaultShell(): { file: string; args: string[] } {
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

function killOwnedBy(owner: WebContents): void {
  for (const [id, entry] of terminals) if (entry.owner === owner) killTerminal(id)
}

// 只有开这个终端的窗口能写、改大小、关掉它
function ownedEntry(id: string, sender: WebContents): TerminalEntry | null {
  const entry = terminals.get(id)
  return entry && entry.owner === sender ? entry : null
}

export function registerTerminalIpc(): void {
  ipcMain.handle(IPC_CHANNELS.terminalCreate, async (event, rawCwd: unknown, rawSize: unknown) => {
    const cwd = parse(z.string().min(1), rawCwd)
    const { cols, rows } = parse(sizeSchema, rawSize)
    if (!(await stat(cwd).catch(() => null))?.isDirectory()) throw new Error(`目录不存在：${cwd}`)
    if (terminals.size >= MAX_TERMINALS) throw new Error(`最多同时开 ${MAX_TERMINALS} 个终端，先关掉几个`)

    const owner = event.sender
    // 页面刷新或窗口关掉时，这个窗口开的终端一起结束
    if (!watched.has(owner)) {
      watched.add(owner)
      owner.on('destroyed', () => killOwnedBy(owner))
      owner.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) killOwnedBy(owner)
      })
    }

    const shell = defaultShell()
    const pty = spawn(shell.file, shell.args, { name: 'xterm-256color', cols, rows, cwd, env: process.env })
    const id = randomUUID()
    terminals.set(id, { pty, owner })
    pty.onData((data) => {
      if (!owner.isDestroyed()) owner.send(IPC_CHANNELS.terminalData, { id, data })
    })
    pty.onExit(({ exitCode }) => {
      terminals.delete(id)
      if (!owner.isDestroyed()) owner.send(IPC_CHANNELS.terminalExit, { id, exitCode })
    })
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
