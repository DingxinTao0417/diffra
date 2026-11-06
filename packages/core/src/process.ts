import { spawn } from 'node:child_process'

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

function killTree(pid: number | undefined): void {
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
