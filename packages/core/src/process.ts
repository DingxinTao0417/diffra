import { spawn, spawnSync } from 'node:child_process'

// 超过这个大小只保留开头和结尾，防止输出巨大的命令撑爆内存
const MAX_CAPTURE_BYTES = 1024 * 1024
const KEEP_BYTES = 64 * 1024

export interface ProcessOptions {
  cwd: string
  timeoutMs: number
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
}

export interface ProcessResult {
  exitCode: number | null
  output: string
  timedOut: boolean
  aborted: boolean
  durationMs: number
}

export function runProcess(file: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  const started = performance.now()
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      // 非 Windows 上开新进程组，超时时可以连同子进程一起结束
      detached: process.platform !== 'win32',
    })

    const head: Buffer[] = []
    let headBytes = 0
    let tail: Buffer[] = []
    let tailBytes = 0
    let dropped = false
    const collect = (chunk: Buffer) => {
      if (headBytes < KEEP_BYTES) {
        head.push(chunk)
        headBytes += chunk.length
        return
      }
      tail.push(chunk)
      tailBytes += chunk.length
      if (headBytes + tailBytes > MAX_CAPTURE_BYTES) {
        while (tailBytes > KEEP_BYTES && tail.length > 1) {
          const first = tail.shift()
          tailBytes -= first?.length ?? 0
          dropped = true
        }
      }
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)

    let timedOut = false
    let aborted = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
    }, options.timeoutMs)
    const onAbort = () => {
      aborted = true
      killTree(child.pid)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    child.on('error', (error) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      const middle = dropped ? Buffer.from('\n... (output too long, middle part dropped) ...\n') : Buffer.alloc(0)
      resolve({
        exitCode: code,
        output: Buffer.concat([...head, middle, ...tail]).toString('utf8'),
        timedOut,
        aborted,
        durationMs: Math.round(performance.now() - started),
      })
    })
  })
}

// 进程退出前用：等 taskkill 跑完再返回
export function killTreeSync(pid: number | undefined): void {
  if (pid === undefined) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // 进程组已经没了
  }
}

export function killTree(pid: number | undefined): void {
  if (pid === undefined) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).on('error', (error) =>
      console.error('[process] taskkill 失败', error),
    )
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (error) {
    console.error('[process] 结束进程组失败', error)
  }
}

// 给模型看的工具输出上限（token，按 4 字节一个估算），和 Codex 的默认一样
export const DEFAULT_MAX_OUTPUT_TOKENS = 10_000
const BYTES_PER_TOKEN = 4

// 按 token 头尾各留一半，中间换成「…N tokens truncated…」；截了就在前面说明原来有多长（第 511 步，Codex 的格式）。
// 命令、MCP、浏览器、检查命令的输出都用它
export function truncateForModel(text: string, maxTokens = DEFAULT_MAX_OUTPUT_TOKENS): { text: string; truncated: boolean; originalTokens: number } {
  const originalTokens = Math.ceil(Buffer.byteLength(text) / BYTES_PER_TOKEN)
  if (originalTokens <= maxTokens) return { text, truncated: false, originalTokens }
  const keepChars = Math.floor((maxTokens * BYTES_PER_TOKEN) / 2)
  // 按字符近似：中文一个字三个字节，宁可少留不多留
  const ratio = text.length / Buffer.byteLength(text)
  const keep = Math.max(1, Math.floor(keepChars * ratio))
  const omitted = originalTokens - maxTokens
  const lines = text.split(/\r?\n/).length
  const body = `${text.slice(0, keep)}…${omitted} tokens truncated…${text.slice(-keep)}`
  return { text: `Warning: truncated output (original token count: ${originalTokens})\nTotal output lines: ${lines}\n${body}`, truncated: true, originalTokens }
}

// 按行截断：保留开头和结尾，给模型看的输出不超过这个规模
export function truncateLines(text: string, maxLines = 400, maxChars = 30_000): string {
  let lines = text.split(/\r?\n/)
  if (lines.length > maxLines) {
    const keep = Math.floor(maxLines / 2)
    lines = [...lines.slice(0, keep), `... (${lines.length - maxLines} lines omitted) ...`, ...lines.slice(-keep)]
  }
  let result = lines.join('\n')
  if (result.length > maxChars) {
    const keep = Math.floor(maxChars / 2)
    result = `${result.slice(0, keep)}\n... (${result.length - maxChars} characters omitted) ...\n${result.slice(-keep)}`
  }
  return result
}
