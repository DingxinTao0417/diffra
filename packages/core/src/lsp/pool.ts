import { extname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LspDiagnostic, LspFileDiagnostics, LspServerState, LspServerStatus } from '../protocol.js'
import { fileUri, LspProcess, type PublishedDiagnostics } from './client.js'
import type { LspServerSpec } from './config.js'

// 语言服务器池（v2 · M4）：同一个项目、同样配置的服务器在各个任务间共用一个进程。
// 用到才启动（智能体改了它管的扩展名的文件），一阵子没用就停掉；崩了按退避重启，超过次数就停在「失败」，用户可以在任务监控里重启。
// 停止（用户点的）之后不再自动启动，直到用户点启动
const IDLE_STOP_MS = 10 * 60_000
// 改完文件等诊断最多这么久；收到一次后再等一小会儿，服务器常常分几次发
const DIAGNOSTICS_WAIT_MS = 5_000
const SETTLE_MS = 150
const RESTART_BACKOFF_MS = 1_000
const MAX_STATUS_FILES = 20
const MAX_STATUS_ITEMS = 5

interface Doc {
  version: number
  languageId: string
  text: string
}

interface Waiter {
  uri: string
  version: number
  resolve(outcome: 'published' | 'gone'): void
}

interface Entry {
  cwd: string
  spec: LspServerSpec
  state: LspServerState
  process: LspProcess | null
  starting: Promise<void> | null
  // 这一轮（上次用户启动以来）崩溃后重启了几次
  restarts: number
  error: string | null
  docs: Map<string, Doc>
  diagnostics: Map<string, { version: number | null; items: LspDiagnostic[] }>
  waiters: Set<Waiter>
  // 停止、重启时加一，作废还在退避等待中的重启
  generation: number
  idleTimer: NodeJS.Timeout | null
}

export interface LspPoolOptions {
  idleStopMs?: number
  diagnosticsWaitMs?: number
  restartBackoffMs?: number
}

// 一个文件交给一个服务器检查的结果；diagnostics 为 null 是没拿到（没启动、崩了、超时），note 说为什么
export interface LspCheck {
  server: string
  state: LspServerState
  diagnostics: LspDiagnostic[] | null
  note: string | null
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref())

function exitReason(code: number | null, signal: string | null): string {
  return code !== null ? `退出码 ${code}` : signal ? `信号 ${signal}` : '原因不明'
}

const withStderr = (message: string, stderr: string) => {
  const tail = stderr.trim().split(/\r?\n/).slice(-5).join('\n')
  return tail ? `${message}\n${tail}` : message
}

export class LspPool {
  private readonly entries = new Map<string, Entry>()
  private readonly idleStopMs: number
  private readonly diagnosticsWaitMs: number
  private readonly restartBackoffMs: number

  constructor(options: LspPoolOptions = {}) {
    this.idleStopMs = options.idleStopMs ?? IDLE_STOP_MS
    this.diagnosticsWaitMs = options.diagnosticsWaitMs ?? DIAGNOSTICS_WAIT_MS
    this.restartBackoffMs = options.restartBackoffMs ?? RESTART_BACKOFF_MS
  }

  private key(cwd: string, spec: LspServerSpec): string {
    return JSON.stringify([cwd, spec])
  }

  private entry(cwd: string, spec: LspServerSpec): Entry {
    const key = this.key(cwd, spec)
    let entry = this.entries.get(key)
    if (!entry) {
      entry = { cwd, spec, state: 'idle', process: null, starting: null, restarts: 0, error: null, docs: new Map(), diagnostics: new Map(), waiters: new Set(), generation: 0, idleTimer: null }
      this.entries.set(key, entry)
    }
    return entry
  }

  // 管这个文件的服务器（按扩展名）
  matching(specs: LspServerSpec[], path: string): LspServerSpec[] {
    const extension = extname(path).toLowerCase()
    return extension ? specs.filter((spec) => spec.extensions[extension] !== undefined) : []
  }

  private launch(entry: Entry): Promise<void> {
    entry.state = 'starting'
    const process = new LspProcess(entry.spec, entry.cwd, {
      onDiagnostics: (published) => this.published(entry, process, published),
      onExit: (info) => this.exited(entry, process, info),
    })
    entry.process = process
    entry.starting = process.start().then(
      () => {
        if (entry.process !== process) return
        entry.state = 'running'
        entry.error = null
        // 崩溃重启后把打开过的文件再交给它
        for (const [uri, doc] of entry.docs) process.notify('textDocument/didOpen', { textDocument: { uri, languageId: doc.languageId, version: doc.version, text: doc.text } })
      },
      (error: unknown) => {
        if (entry.process !== process) return
        entry.process = null
        entry.state = 'failed'
        entry.error = withStderr(`没启动起来：${error instanceof Error ? error.message : String(error)}`, process.stderr)
        console.error(`[lsp] ${entry.spec.name} 没启动起来`, error)
      },
    )
    return entry.starting
  }

  private published(entry: Entry, process: LspProcess, published: PublishedDiagnostics): void {
    if (entry.process !== process) return
    entry.diagnostics.set(published.uri, { version: published.version, items: published.diagnostics })
    for (const waiter of entry.waiters) {
      if (waiter.uri === published.uri && (published.version === null || published.version >= waiter.version)) waiter.resolve('published')
    }
  }

  private release(entry: Entry): void {
    for (const waiter of entry.waiters) waiter.resolve('gone')
    entry.waiters.clear()
  }

  private exited(entry: Entry, process: LspProcess, info: { code: number | null; signal: string | null; intentional: boolean; stderr: string }): void {
    if (entry.process !== process) return
    this.release(entry)
    // 启动时就退出了：start() 那边记成失败（它看 entry.process 还是不是自己，所以这里先不清）
    if (entry.state === 'starting') return
    entry.process = null
    if (info.intentional) return
    const reason = exitReason(info.code, info.signal)
    if (entry.spec.restartOnCrash && entry.restarts < entry.spec.maxRestarts) {
      entry.restarts++
      entry.state = 'restarting'
      entry.error = withStderr(`崩溃了（${reason}），正在第 ${entry.restarts} 次重启`, info.stderr)
      console.warn(`[lsp] ${entry.spec.name} 崩溃了（${reason}），第 ${entry.restarts} 次重启`)
      const generation = entry.generation
      entry.starting = sleep(this.restartBackoffMs * 2 ** (entry.restarts - 1)).then(() =>
        entry.generation === generation && entry.state === 'restarting' ? this.launch(entry) : undefined,
      )
      return
    }
    entry.state = 'failed'
    entry.error = withStderr(entry.restarts > 0 ? `崩溃了（${reason}），重启了 ${entry.restarts} 次还是不行，不再自动重启` : `崩溃了（${reason}）`, info.stderr)
    console.error(`[lsp] ${entry.spec.name} ${entry.error}`)
  }

  private async ensureRunning(entry: Entry): Promise<boolean> {
    if (entry.state === 'idle') await this.launch(entry)
    else if (entry.state === 'starting' || entry.state === 'restarting') await entry.starting
    // 重启又崩了的那一下可能还在「重启中」：再等一轮
    if (entry.state === 'restarting') await entry.starting
    return entry.state === 'running'
  }

  private touch(entry: Entry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null
      if (entry.state === 'running' && entry.waiters.size === 0) void this.stop(entry, 'idle')
    }, this.idleStopMs)
    entry.idleTimer.unref()
  }

  private async stop(entry: Entry, state: 'idle' | 'stopped'): Promise<void> {
    entry.generation++
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = null
    const process = entry.process
    entry.process = null
    entry.state = state
    entry.error = null
    entry.docs.clear()
    entry.diagnostics.clear()
    this.release(entry)
    await process?.stop()
  }

  // 把改后的内容交给管它的服务器，等它发这个版本的诊断
  async check(cwd: string, spec: LspServerSpec, path: string, text: string, signal?: AbortSignal): Promise<LspCheck> {
    const entry = this.entry(cwd, spec)
    const result = (diagnostics: LspDiagnostic[] | null, note: string | null): LspCheck => ({ server: spec.name, state: entry.state, diagnostics, note })
    if (entry.state === 'stopped') return result(null, '已停止')
    if (!(await this.ensureRunning(entry)) || !entry.process) return result(null, entry.error)
    this.touch(entry)
    const process = entry.process
    const uri = fileUri(path)
    const previous = entry.docs.get(uri)
    const version = (previous?.version ?? 0) + 1
    const languageId = spec.extensions[extname(path).toLowerCase()] ?? 'plaintext'
    entry.docs.set(uri, { version, languageId, text })
    let waiter: Waiter | null = null
    const published = new Promise<'published' | 'gone'>((resolve) => {
      waiter = { uri, version, resolve }
      entry.waiters.add(waiter)
    })
    if (previous) process.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] })
    else process.notify('textDocument/didOpen', { textDocument: { uri, languageId, version, text } })
    let outcome: 'published' | 'gone' | 'timeout' | 'aborted'
    try {
      outcome = await Promise.race([
        published,
        sleep(this.diagnosticsWaitMs).then(() => 'timeout' as const),
        new Promise<'aborted'>((resolve) => {
          if (signal?.aborted) resolve('aborted')
          signal?.addEventListener('abort', () => resolve('aborted'), { once: true })
        }),
      ])
    } finally {
      if (waiter) entry.waiters.delete(waiter)
    }
    if (outcome === 'published') await sleep(SETTLE_MS)
    if (outcome === 'gone') return result(null, entry.state === 'restarting' ? '检查这个文件时崩溃了，正在重启' : (entry.error ?? '已停止'))
    if (outcome === 'aborted') return result(null, '已取消')
    const current = entry.diagnostics.get(uri)
    if (!current || (current.version !== null && current.version < version)) return result(null, `${this.diagnosticsWaitMs / 1000} 秒内没给出这个文件的诊断`)
    return result(current.items, null)
  }

  status(cwd: string, specs: LspServerSpec[]): LspServerStatus[] {
    return specs.map((spec) => {
      const entry = this.entries.get(this.key(cwd, spec))
      const files: LspFileDiagnostics[] = []
      let errors = 0
      let warnings = 0
      for (const [uri, published] of entry?.diagnostics ?? []) {
        const items = published.items.filter((item) => item.severity <= 2)
        const fileErrors = items.filter((item) => item.severity === 1).length
        errors += fileErrors
        warnings += items.length - fileErrors
        if (items.length === 0) continue
        let path = uri
        try {
          path = relative(cwd, fileURLToPath(uri)).replaceAll('\\', '/')
        } catch {
          // 不是 file: 地址就照原样显示
        }
        files.push({ path, errors: fileErrors, warnings: items.length - fileErrors, diagnostics: items.slice(0, MAX_STATUS_ITEMS) })
      }
      files.sort((a, b) => b.errors - a.errors || b.warnings - a.warnings || a.path.localeCompare(b.path))
      return {
        name: spec.name,
        plugin: spec.plugin,
        extensions: Object.keys(spec.extensions),
        state: entry?.state ?? 'idle',
        error: entry?.error ?? null,
        restarts: entry?.restarts ?? 0,
        pid: entry?.process?.pid ?? null,
        errors,
        warnings,
        files: files.slice(0, MAX_STATUS_FILES),
      }
    })
  }

  // 用户在任务监控里点的：停止；启动或重启（重启次数清零）
  async control(cwd: string, spec: LspServerSpec, action: 'start' | 'stop' | 'restart'): Promise<void> {
    const entry = this.entry(cwd, spec)
    if (action === 'stop') return this.stop(entry, 'stopped')
    await this.stop(entry, 'idle')
    entry.restarts = 0
    await this.launch(entry)
    if (entry.state === 'running') this.touch(entry)
  }

  // 只留还开着的任务的项目里的服务器
  async retain(cwds: Iterable<string>): Promise<void> {
    const keep = new Set(cwds)
    for (const [key, entry] of this.entries) {
      if (keep.has(entry.cwd)) continue
      this.entries.delete(key)
      await this.stop(entry, 'idle')
    }
  }

  async dispose(): Promise<void> {
    const entries = [...this.entries.values()]
    this.entries.clear()
    await Promise.all(entries.map((entry) => this.stop(entry, 'idle')))
  }
}
