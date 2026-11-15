import { type ChildProcess, spawn } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { resolve } from 'node:path'
import type { BackgroundProcess } from '../protocol.js'
import { DEFAULT_MAX_OUTPUT_TOKENS, killTree, killTreeSync, truncateForModel } from '../process.js'
import { localUrlIn } from '../urls.js'
import { applyPatchTool, patchFromCommand } from './apply-patch.js'
import { commandEnv, missingCommandHint, saveFullOutput } from './command.js'
import { ToolError, type ToolContext, type ToolOutput } from './types.js'

// 命令执行，参照 Codex 的 unified exec（第 506 步）：一个 exec_command 跑命令，到点还没结束就返回会话号，进程在后台接着跑，
// 之后用 write_stdin 取新的输出、往里输入（或发 Ctrl-C 结束）。没有硬超时：长命令、开发服务器、watch 都用这一个工具。
// 和 Codex 一样用管道不用终端。输入默认关着：开着的话 rg foo 这类不带路径的命令会去等输入、一直卡住；
// 要往程序里输入时用 stdin: true 打开（第 523 步）

// 等待时间：exec_command 默认 10 秒，250 毫秒到 30 秒；write_stdin 空轮询 5 秒到 5 分钟，输入后默认 1 秒，发 Ctrl-C 时等到进程退出
export const DEFAULT_EXEC_YIELD_MS = 10_000
const MIN_EXEC_YIELD_MS = 250
const MAX_EXEC_YIELD_MS = 30_000
const MIN_POLL_YIELD_MS = 5_000
const MAX_POLL_YIELD_MS = 300_000
const DEFAULT_INPUT_YIELD_MS = 1_000
// 每个进程留着的输出：头尾各 512 KiB，中间丢掉的记个数
const HEAD_BYTES = 512 * 1024
const TAIL_BYTES = 512 * 1024
// 同时开着的进程最多这么多个，超出时结束最久没用的那个，最近用过的 8 个不动
const MAX_SESSIONS = 64
const PROTECTED_RECENT = 8
const CTRL_C = '\u0003'
const CTRL_D = '\u0004'
// 模型常把控制字符写成转义的文字（第 522 步：评测里把 Ctrl-C 写成了六个字符的 \u0003，停不掉服务，转去按进程名杀 node）
const CONTROL_SPELLINGS: Record<string, string> = { '\\u0003': CTRL_C, '\\x03': CTRL_C, '^C': CTRL_C, '\\u0004': CTRL_D, '\\x04': CTRL_D, '^D': CTRL_D }
// 停止后最多等进程退出这么久
const STOP_WAIT_MS = 5_000
// 界面「查看输出」看的最近输出，和交给模型的 pending 分开留
const RECENT_CHARS = 64_000
const URL_OVERLAP_CHARS = 200

interface ExecProcess {
  id: number
  command: string
  cwd: string
  child: ChildProcess
  started: number
  lastUsed: number
  // 上次交给模型之后新来的输出
  pending: { head: string; tail: string; omittedBytes: number; bytes: number }
  exitCode: number | null
  exited: boolean
  // 是我们结束的（Ctrl-C、用户点停止）：退出码不算命令失败
  stopped: boolean
  // 用户在「运行中」点的停止，告诉模型是用户停的
  stoppedByUser: boolean
  // 工具到点返回时还在跑：转到了后台，界面「运行中」列着它
  background: boolean
  recent: string
  // 输出里第一次出现的本地地址（开发服务器），界面「运行中」据此给「打开网页」
  url: string | null
  waiters: Set<() => void>
}

const emptyPending = () => ({ head: '', tail: '', omittedBytes: 0, bytes: 0 })

// 开过进程的进程表：内核退出前一起结束，免得命令留在后台（Windows 上桌面端用 taskkill /T 连子进程一起结束）
const live = new Set<ExecSessions>()
let exitHooked = false
function hookExit(sessions: ExecSessions): void {
  live.add(sessions)
  if (exitHooked) return
  exitHooked = true
  process.once('exit', () => {
    for (const item of live) item.killAll(true)
  })
  // 默认收到 SIGTERM 直接退出，不跑 exit 监听
  if (process.platform !== 'win32') process.once('SIGTERM', () => process.exit(143))
}

// 一个会话里所有后台进程；会话删除、应用退出时全部结束
export class ExecSessions {
  private readonly processes = new Map<number, ExecProcess>()
  // 后台命令列表变了（有命令转到后台、后台的命令结束了）时调，会话据此告诉界面
  onChange: (() => void) | null = null

  get size(): number {
    return this.processes.size
  }

  ids(): number[] {
    return [...this.processes.keys()]
  }

  // keepStdin：输入开着，之后能用 write_stdin 往里写
  start(command: string, cwd: string, bashPath: string, rgPath?: string, keepStdin = false): ExecProcess {
    hookExit(this)
    this.evict()
    let id = randomInt(1000, 100_000)
    while (this.processes.has(id)) id = randomInt(1000, 100_000)
    const child = spawn(bashPath, ['-c', command], {
      cwd,
      env: commandEnv(rgPath),
      windowsHide: true,
      stdio: [keepStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    const now = Date.now()
    const entry: ExecProcess = {
      id,
      command,
      cwd,
      child,
      started: now,
      lastUsed: now,
      pending: emptyPending(),
      exitCode: null,
      exited: false,
      stopped: false,
      stoppedByUser: false,
      background: false,
      recent: '',
      url: null,
      waiters: new Set(),
    }
    const collect = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      // 地址可能被切在两块输出之间：带上一块的末尾一起找
      const before = entry.recent.slice(-URL_OVERLAP_CHARS)
      appendOutput(entry, text)
      if (entry.url === null) {
        entry.url = localUrlIn(before + text)
        if (entry.url && entry.background) this.onChange?.()
      }
      for (const wake of entry.waiters) wake()
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    // 进程先退出了再往里写会报 EPIPE：交给 writeStdinTool 按进程已结束处理，这里不能让它变成没人接的错误
    child.stdin?.on('error', () => {})
    const finish = (code: number | null) => {
      if (entry.exited) return
      entry.exited = true
      entry.exitCode = code
      for (const wake of entry.waiters) wake()
      if (entry.background) this.onChange?.()
    }
    child.on('error', (error) => {
      appendOutput(entry, `\n${error.message}\n`)
      finish(null)
    })
    child.on('close', (code) => finish(code))
    this.processes.set(id, entry)
    return entry
  }

  get(id: number): ExecProcess | undefined {
    const entry = this.processes.get(id)
    if (entry) entry.lastUsed = Date.now()
    return entry
  }

  remove(id: number): void {
    this.processes.delete(id)
  }

  kill(id: number, byUser = false): void {
    const entry = this.processes.get(id)
    if (!entry || entry.exited) return
    entry.stopped = true
    entry.stoppedByUser = byUser
    killTree(entry.child.pid)
  }

  markBackground(id: number): void {
    const entry = this.processes.get(id)
    if (!entry || entry.exited || entry.background) return
    entry.background = true
    this.onChange?.()
  }

  background(): BackgroundProcess[] {
    return [...this.processes.values()].filter((entry) => entry.background && !entry.exited).map((entry) => ({ id: entry.id, command: entry.command, cwd: entry.cwd, startedAt: entry.started, url: entry.url }))
  }

  // 不动交给模型的那份新输出
  recentOutput(id: number): { text: string; running: boolean } | null {
    const entry = this.processes.get(id)
    return entry ? { text: entry.recent, running: !entry.exited } : null
  }

  // sync：内核退出前调，等进程真的结束再返回
  killAll(sync = false): void {
    for (const entry of this.processes.values()) if (!entry.exited) (sync ? killTreeSync : killTree)(entry.child.pid)
    this.processes.clear()
    live.delete(this)
  }

  private evict(): void {
    if (this.processes.size < MAX_SESSIONS) return
    const byAge = [...this.processes.values()].sort((a, b) => a.lastUsed - b.lastUsed)
    const recent = new Set(byAge.slice(-PROTECTED_RECENT).map((entry) => entry.id))
    // 先清已经结束的，再清最久没用的
    const victim = byAge.find((entry) => entry.exited) ?? byAge.find((entry) => !recent.has(entry.id))
    if (!victim) return
    if (!victim.exited) killTree(victim.child.pid)
    this.processes.delete(victim.id)
  }
}

function appendOutput(entry: ExecProcess, text: string): void {
  entry.recent = (entry.recent + text).slice(-RECENT_CHARS)
  const pending = entry.pending
  pending.bytes += Buffer.byteLength(text)
  if (Buffer.byteLength(pending.head) < HEAD_BYTES) {
    pending.head += text
    return
  }
  pending.tail += text
  const tailBytes = Buffer.byteLength(pending.tail)
  if (tailBytes > TAIL_BYTES) {
    const cut = pending.tail.length - Math.floor(pending.tail.length * (TAIL_BYTES / tailBytes))
    pending.omittedBytes += Buffer.byteLength(pending.tail.slice(0, cut))
    pending.tail = pending.tail.slice(cut)
  }
}

function takePending(entry: ExecProcess): { text: string; raw: string } {
  const { head, tail, omittedBytes } = entry.pending
  entry.pending = emptyPending()
  const middle = omittedBytes > 0 ? `\n... ${omittedBytes} bytes omitted ...\n` : ''
  return { text: head + middle + tail, raw: head + middle + tail }
}

// 等进程结束、或者等满 yieldMs，先到哪个算哪个；中途用户停下就提前回
function waitFor(entry: ExecProcess, yieldMs: number, signal: AbortSignal): Promise<void> {
  if (entry.exited) return Promise.resolve()
  return new Promise((resolveWait) => {
    const done = () => {
      clearTimeout(timer)
      entry.waiters.delete(onChange)
      signal.removeEventListener('abort', done)
      resolveWait()
    }
    const onChange = () => {
      if (entry.exited) done()
    }
    const timer = setTimeout(done, yieldMs)
    entry.waiters.add(onChange)
    signal.addEventListener('abort', done, { once: true })
  })
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

function statusLine(entry: ExecProcess): string {
  if (!entry.exited) return `Process running with session ID ${entry.id}`
  if (entry.stoppedByUser) return 'Process stopped by the user'
  return entry.stopped ? 'Process stopped (Ctrl-C)' : `Process exited with code ${entry.exitCode ?? -1}`
}

function report(entry: ExecProcess, wallMs: number, output: string, maxTokens: number): { text: string; full: string } {
  const shown = truncateForModel(output, maxTokens)
  return {
    text: [`Wall time: ${(wallMs / 1000).toFixed(4)} seconds`, statusLine(entry), ...(shown.truncated ? [`Original token count: ${shown.originalTokens}`] : []), 'Output:', shown.text].join('\n'),
    full: output,
  }
}

export interface ExecCommandInput {
  cmd: string
  workdir?: string
  yield_time_ms?: number
  max_output_tokens?: number
  justification?: string
  stdin?: boolean
}

export async function execCommandTool(context: ToolContext, input: ExecCommandInput): Promise<ToolOutput> {
  // 模型用 shell 调 apply_patch（cd x && apply_patch <<'EOF' ... EOF）：照 apply_patch 处理，不真去跑，和 Codex 一样
  const intercepted = patchFromCommand(input.cmd)
  if (intercepted) return applyPatchTool(context, { input: intercepted.patch }, intercepted.workdir ?? input.workdir ?? null)
  if (!context.bashPath) throw new ToolError('No bash found. Install Git for Windows to run commands.')
  if (!context.execSessions) throw new ToolError('Commands are not available here.')
  const cwd = input.workdir ? resolve(context.cwd, input.workdir) : context.cwd
  const permission = await context.requestCommandPermission(input.cmd, input.justification, cwd)
  if (!permission.allowed) throw new ToolError(permission.reason)
  const started = Date.now()
  const entry = context.execSessions.start(input.cmd, cwd, context.bashPath, context.rgPath, input.stdin === true)
  await waitFor(entry, clamp(input.yield_time_ms ?? DEFAULT_EXEC_YIELD_MS, MIN_EXEC_YIELD_MS, MAX_EXEC_YIELD_MS), context.signal)
  return finishReport(context, entry, started, input.max_output_tokens, `执行 ${input.cmd}`)
}

export interface WriteStdinInput {
  session_id: number
  chars?: string
  yield_time_ms?: number
  max_output_tokens?: number
}

export async function writeStdinTool(context: ToolContext, input: WriteStdinInput): Promise<ToolOutput> {
  const entry = context.execSessions?.get(input.session_id)
  if (!entry) {
    throw new ToolError(`No running process with session ID ${input.session_id}. Running sessions: ${context.execSessions?.ids().join(', ') || 'none'}.`)
  }
  const raw = input.chars ?? ''
  const chars = CONTROL_SPELLINGS[raw] ?? raw
  const started = Date.now()
  let yieldMs: number
  let action: string
  if (chars === CTRL_C) {
    context.execSessions!.kill(entry.id)
    // 等进程真的退出（最多 STOP_WAIT_MS，退出了马上返回）：Windows 上 taskkill 要一会儿，早返回时进程还占着目录
    yieldMs = STOP_WAIT_MS
    action = '结束'
  } else if (chars !== '') {
    const stdin = entry.child.stdin
    if (!stdin || !stdin.writable) {
      throw new ToolError(
        entry.exited
          ? 'The process has already exited; there is nothing to type into. Poll it with empty chars to read its last output.'
          : 'This process was started without input, so you cannot type into it. To type into a program, start it again with exec_command and stdin: true. To stop this one, send "\\u0003" (the Ctrl-C control character).',
      )
    }
    if (chars === CTRL_D) stdin.end()
    else stdin.write(chars)
    yieldMs = clamp(input.yield_time_ms ?? DEFAULT_INPUT_YIELD_MS, MIN_EXEC_YIELD_MS, MAX_EXEC_YIELD_MS)
    action = '输入'
  } else {
    yieldMs = clamp(input.yield_time_ms ?? MIN_POLL_YIELD_MS, MIN_POLL_YIELD_MS, MAX_POLL_YIELD_MS)
    action = '查看'
  }
  await waitFor(entry, yieldMs, context.signal)
  return finishReport(context, entry, started, input.max_output_tokens, `${action} ${entry.command}`)
}

async function finishReport(context: ToolContext, entry: ExecProcess, started: number, maxTokens: number | undefined, title: string): Promise<ToolOutput> {
  // 用户点了停止：等着的这个进程一起结束，不留在后台；等它真的退出再返回（Windows 上进程还占着目录时撤销、删任务会失败）
  if (context.signal.aborted && !entry.exited) {
    context.execSessions?.kill(entry.id)
    await waitFor(entry, STOP_WAIT_MS, new AbortController().signal)
    context.execSessions?.remove(entry.id)
    throw new ToolError('Cancelled by the user. The process was stopped.')
  }
  const output = takePending(entry)
  const limit = clamp(maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, 1, DEFAULT_MAX_OUTPUT_TOKENS * 4)
  const { text } = report(entry, Date.now() - started, output.text.trim(), limit)
  const shortened = truncateForModel(output.text, limit).truncated
  const saved = shortened ? await saveFullOutput(context.outputDir, output.raw) : ''
  const hint = entry.exited && !entry.stopped && entry.exitCode === 127 ? await missingCommandHint(context, output.text) : ''
  if (entry.exited) context.execSessions?.remove(entry.id)
  else context.execSessions?.markBackground(entry.id)
  const header = !entry.exited ? `运行中（会话 ${entry.id}）` : entry.stopped ? '已停止' : `Exit code: ${entry.exitCode}`
  return {
    text: text + saved + hint,
    title,
    terminalOutput: `${header}\n${output.text.trim() || '(no output)'}`,
    durationMs: Date.now() - started,
    // 我们结束的进程退出码不算命令失败（第 524 步：停服务不该在界面上变成「有 1 条命令失败」）
    ...(entry.exited && !entry.stopped ? { commandSucceeded: entry.exitCode === 0 } : {}),
  }
}
