import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { killTree, locateCommand, spawnCommand } from '../external/spawn.js'
import type { LspDiagnostic } from '../protocol.js'
import { CORE_VERSION } from '../version.js'
import { expandLsp, type LspServerSpec } from './config.js'

// 一个语言服务器进程：stdio 上的 LSP（JSON-RPC，消息前面是 Content-Length 头）。只做诊断要用的那部分：
// initialize / initialized、didChangeConfiguration、打开和改文件、收 publishDiagnostics；服务器反过来问的常见请求给个空回答，免得它干等
const STDERR_TAIL_CHARS = 4000
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024

export interface PublishedDiagnostics {
  uri: string
  version: number | null
  diagnostics: LspDiagnostic[]
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

export class LspError extends Error {}

type Message = { id?: number | string | null; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } }

const asRecord = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {})

function diagnosticOf(raw: unknown): LspDiagnostic {
  const item = asRecord(raw)
  const start = asRecord(asRecord(item.range).start)
  return {
    line: typeof start.line === 'number' ? start.line : 0,
    character: typeof start.character === 'number' ? start.character : 0,
    severity: typeof item.severity === 'number' ? item.severity : 1,
    message: typeof item.message === 'string' ? item.message : '',
    source: typeof item.source === 'string' ? item.source : null,
    code: typeof item.code === 'string' || typeof item.code === 'number' ? String(item.code) : null,
  }
}

export function fileUri(path: string): string {
  return pathToFileURL(path).href
}

export interface LspProcessEvents {
  onDiagnostics(published: PublishedDiagnostics): void
  // 进程退出了（自己退出或崩溃）；intentional 为真是我们让它停的
  onExit(info: { code: number | null; signal: string | null; intentional: boolean; stderr: string }): void
}

export class LspProcess {
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = Buffer.alloc(0)
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private stderrTail = ''
  private stopping = false
  private exited: Promise<void> = Promise.resolve()

  constructor(
    readonly spec: LspServerSpec,
    readonly cwd: string,
    private readonly events: LspProcessEvents,
  ) {}

  get pid(): number | null {
    return this.child?.pid ?? null
  }

  get stderr(): string {
    return this.stderrTail
  }

  // 启动并握手；startupTimeout 内没答 initialize 算启动失败（进程结束掉）
  async start(): Promise<void> {
    const { spec, cwd } = this
    const expand = (value: string) => expandLsp(value, spec.root, cwd)
    const env = { ...process.env, ...Object.fromEntries(Object.entries(spec.env).map(([name, value]) => [name, expand(value)])), CLAUDE_PLUGIN_ROOT: spec.root, CLAUDE_PROJECT_DIR: cwd }
    const command = expand(spec.command)
    const path = await locateCommand(command, env)
    if (!path) throw new LspError(`找不到命令 ${command}，先装好这个语言服务器`)
    const child = spawnCommand(path, spec.args.map(expand), { cwd, env })
    this.child = child
    this.exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        for (const [, pending] of this.pending) {
          clearTimeout(pending.timer)
          pending.reject(new LspError(`语言服务器退出了${code !== null ? `（退出码 ${code}）` : ''}`))
        }
        this.pending.clear()
        this.events.onExit({ code, signal, intentional: this.stopping, stderr: this.stderrTail })
        resolve()
      })
    })
    child.once('error', (error) => {
      this.stderrTail = `${this.stderrTail}${error.message}\n`.slice(-STDERR_TAIL_CHARS)
    })
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS)
    })
    // 写进已经退出的进程会报 EPIPE；退出由 exit 事件处理
    child.stdin.on('error', () => {})
    const folder = spec.workspaceFolder ? expand(spec.workspaceFolder) : cwd
    try {
      await this.request(
        'initialize',
        {
          processId: process.pid,
          clientInfo: { name: 'diffra', version: CORE_VERSION },
          rootUri: fileUri(folder),
          rootPath: folder,
          workspaceFolders: [{ uri: fileUri(folder), name: folder.split(/[\\/]/).at(-1) ?? folder }],
          initializationOptions: spec.initializationOptions,
          capabilities: {
            textDocument: {
              synchronization: { didSave: false, dynamicRegistration: false },
              publishDiagnostics: { relatedInformation: false, versionSupport: true },
            },
            workspace: { configuration: true, workspaceFolders: true },
            window: { workDoneProgress: false },
          },
        },
        spec.startupTimeoutMs,
        `${spec.startupTimeoutMs / 1000} 秒内没启动好`,
      )
      this.notify('initialized', {})
      if (spec.settings !== null) this.notify('workspace/didChangeConfiguration', { settings: spec.settings })
    } catch (error) {
      await this.kill()
      throw error
    }
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  request(method: string, params: unknown, timeoutMs = this.spec.requestTimeoutMs, timeoutMessage?: string): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new LspError(timeoutMessage ?? `${method} 等了 ${Math.round(timeoutMs / 1000)} 秒没有回答`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  // 好好退出：shutdown、exit，等一会儿；不退就结束整个进程树
  async stop(): Promise<void> {
    const child = this.child
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    this.stopping = true
    const timeout = this.spec.shutdownTimeoutMs
    try {
      await this.request('shutdown', null, timeout)
      this.notify('exit', null)
    } catch {
      // 不答 shutdown 就直接结束
    }
    const exited = await Promise.race([this.exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeout))])
    if (!exited) await this.kill()
  }

  async kill(): Promise<void> {
    const child = this.child
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    this.stopping = true
    killTree(child)
    await Promise.race([this.exited, new Promise((resolve) => setTimeout(resolve, 5000))])
  }

  private send(message: Record<string, unknown>): void {
    const child = this.child
    if (!child || child.exitCode !== null || !child.stdin.writable) return
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]))
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const header = this.buffer.subarray(0, headerEnd).toString('ascii')
      const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? NaN)
      if (!Number.isFinite(length) || length > MAX_MESSAGE_BYTES) {
        // 头坏了：丢掉这一段，免得卡死在这里
        console.error(`[lsp] ${this.spec.name} 的输出不是 LSP 消息，丢掉：${header.slice(0, 200)}`)
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }
      const start = headerEnd + 4
      if (this.buffer.length < start + length) return
      const body = this.buffer.subarray(start, start + length).toString('utf8')
      this.buffer = this.buffer.subarray(start + length)
      try {
        this.handle(JSON.parse(body) as Message)
      } catch (error) {
        console.error(`[lsp] ${this.spec.name} 的消息处理失败`, error)
      }
    }
  }

  private handle(message: Message): void {
    if (message.method && message.id !== undefined && message.id !== null) {
      this.answer(message.id, message.method, message.params)
      return
    }
    if (message.method) {
      if (message.method === 'textDocument/publishDiagnostics') {
        const params = asRecord(message.params)
        if (typeof params.uri !== 'string') return
        this.events.onDiagnostics({
          uri: params.uri,
          version: typeof params.version === 'number' ? params.version : null,
          diagnostics: Array.isArray(params.diagnostics) ? params.diagnostics.map(diagnosticOf) : [],
        })
      }
      return
    }
    if (typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error) pending.reject(new LspError(message.error.message))
    else pending.resolve(message.result ?? null)
  }

  // 服务器反过来问的：配置按 section 从 settings 里取，注册能力、进度这类答「好」，其他答「不支持」
  private answer(id: number | string, method: string, params: unknown): void {
    const reply = (result: unknown) => this.send({ jsonrpc: '2.0', id, result })
    switch (method) {
      case 'workspace/configuration': {
        const items = Array.isArray(asRecord(params).items) ? (asRecord(params).items as unknown[]) : []
        reply(items.map((item) => this.section(asRecord(item).section)))
        return
      }
      case 'workspace/workspaceFolders':
        reply([{ uri: fileUri(this.cwd), name: this.cwd.split(/[\\/]/).at(-1) ?? this.cwd }])
        return
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'window/workDoneProgress/create':
      case 'window/showMessageRequest':
        reply(null)
        return
      default:
        this.send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Diffra 不支持 ${method}` } })
    }
  }

  private section(section: unknown): unknown {
    if (typeof section !== 'string' || section === '') return this.spec.settings
    let value: unknown = this.spec.settings
    for (const part of section.split('.')) value = asRecord(value)[part]
    return value ?? null
  }
}
