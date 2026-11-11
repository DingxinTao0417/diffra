import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { CommitInfo } from './model.js'

const GIT_TIMEOUT_MS = 60_000
const MAX_COMMITS = 3000
const COMMITS_PER_FILE = 10

// 逐行读命令输出：git log、rg --files 在大仓库里输出几十 MB，不能整段收进内存再切
export function streamLines(
  file: string,
  args: string[],
  cwd: string,
  onLine: (line: string) => boolean | void,
  options: { signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ exitCode: number | null; stopped: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env: options.env ?? process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let stopped = false
    const stop = () => {
      stopped = true
      child.kill()
    }
    const timer = setTimeout(stop, options.timeoutMs ?? GIT_TIMEOUT_MS)
    options.signal?.addEventListener('abort', stop, { once: true })
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => {
      if (stopped) return
      if (onLine(line) === false) stop()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (exitCode) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', stop)
      resolve({ exitCode, stopped })
    })
  })
}

async function gitLines(root: string, args: string[], signal?: AbortSignal): Promise<string[] | null> {
  const lines: string[] = []
  try {
    const { exitCode } = await streamLines('git', args, root, (line) => void lines.push(line), { signal, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C.UTF-8' } })
    return exitCode === 0 ? lines : null
  } catch {
    // 没装 git
    return null
  }
}

export interface GitState {
  head: string | null
  branch: string | null
  toplevel: string | null
}

export async function gitState(root: string): Promise<GitState> {
  const toplevel = (await gitLines(root, ['rev-parse', '--show-toplevel']))?.[0] ?? null
  if (!toplevel) return { head: null, branch: null, toplevel: null }
  const head = (await gitLines(root, ['rev-parse', 'HEAD']))?.[0] ?? null
  const branch = (await gitLines(root, ['branch', '--show-current']))?.[0] || null
  return { head, branch, toplevel }
}

// 判断分析是否过期的指纹。git 仓库：HEAD + 工作区状态 + 改动文件的修改时间（同一个文件接着改也能发现）；
// 不是 git 仓库：所有代码文件的路径、大小、修改时间
export async function gitFingerprint(root: string, state: GitState): Promise<string | null> {
  if (!state.toplevel) return null
  const status = await gitLines(root, ['-c', 'core.quotepath=off', 'status', '--porcelain=v1', '--untracked-files=all', '--', '.'])
  if (!status) return null
  const hash = createHash('sha1').update(state.head ?? '').update('\n')
  for (const line of status.slice(0, 5000)) {
    const path = line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop() ?? ''
    const info = await stat(join(state.toplevel, path)).catch(() => null)
    hash.update(`${line}\u0000${info?.mtimeMs ?? 0}\n`)
  }
  return `git:${hash.digest('hex')}`
}

export function filesFingerprint(files: ReadonlyArray<{ path: string; size: number; mtimeMs: number }>): string {
  const hash = createHash('sha1')
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) hash.update(`${file.path}\u0000${file.size}\u0000${file.mtimeMs}\n`)
  return `files:${hash.digest('hex')}`
}

export interface Churn {
  commits: CommitInfo[]
  // 文件 → 提交下标（新的在前），最多 COMMITS_PER_FILE 个；count 是窗口内的总提交数
  byFile: Map<string, { count: number; commits: number[] }>
}

// 最近 days 天改过每个文件的提交；路径相对分析的目录（--relative），目录外的改动不算
export async function readChurn(root: string, days: number, signal?: AbortSignal): Promise<Churn | null> {
  const commits: CommitInfo[] = []
  const byFile = new Map<string, { count: number; commits: number[] }>()
  let current = -1
  try {
    const { exitCode } = await streamLines(
      'git',
      ['-c', 'core.quotepath=off', 'log', `--since=${days}.days.ago`, '--no-merges', '--relative', '--name-only', `-n${MAX_COMMITS}`, '--format=%x1e%H%x1f%aI%x1f%s'],
      root,
      (line) => {
        if (line.startsWith('\u001e')) {
          const [hash, date, subject] = line.slice(1).split('\u001f')
          commits.push({ hash: hash ?? '', date: date ?? '', subject: subject ?? '' })
          current = commits.length - 1
          return
        }
        const path = line.trim()
        if (!path || current < 0) return
        const entry = byFile.get(path) ?? { count: 0, commits: [] }
        entry.count++
        if (entry.commits.length < COMMITS_PER_FILE) entry.commits.push(current)
        byFile.set(path, entry)
      },
      { signal, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
    )
    if (exitCode !== 0) return null
  } catch {
    return null
  }
  return { commits, byFile }
}
