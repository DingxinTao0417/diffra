import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
// scripts/ 用 node 直接跑 TS，导入要写 .ts 后缀（见 tsconfig.node.json）
import { normalizeRepoOrigin, type RepoIdentity } from '../shared/repo-identity.ts'

const execFileAsync = promisify(execFile)
const READ_TIMEOUT_MS = 5000
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024

export interface GitFileState {
  path: string
  added: number
  removed: number
  binary: boolean
}

export interface ProjectGitState {
  repo: boolean
  branch: string | null
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
  // 工作区相对 HEAD 的未提交改动（含未跟踪文件）
  files: GitFileState[]
}

const EMPTY: ProjectGitState = { repo: false, branch: null, head: null, upstream: null, ahead: 0, behind: 0, files: [] }

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: READ_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

// 认项目身份要读 git，侧栏每次刷新都问一次太贵；同一个路径 30 秒内复用上次的结果
const IDENTITY_TTL_MS = 30_000
const identities = new Map<string, { at: number; value: RepoIdentity | null }>()

// 项目所在仓库的远程地址和在仓库里的相对路径；不是 Git 仓库、没有 origin 时认不出来，返回 null
export async function repoIdentity(cwd: string): Promise<RepoIdentity | null> {
  const key = cwd.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
  const cached = identities.get(key)
  if (cached && Date.now() - cached.at < IDENTITY_TTL_MS) return cached.value
  let value: RepoIdentity | null = null
  try {
    const [prefix, origin] = await Promise.all([git(cwd, ['rev-parse', '--show-prefix']), git(cwd, ['config', '--get', 'remote.origin.url'])])
    // 远程地址归一化后再记：发给别的设备时不会带上地址里的用户名和令牌，两边的写法不一样也能对上
    const remote = normalizeRepoOrigin(origin)
    if (remote) value = { origin: remote, subpath: prefix.trim().replace(/\\/g, '/').replace(/\/+$/, '') }
  } catch {
    // 不是 Git 仓库、没有 origin、没装 Git：这台机器上认不出项目身份，按单独的项目显示
    value = null
  }
  identities.set(key, { at: Date.now(), value })
  return value
}

function projectPath(repoPath: string, prefix: string): string | null {
  if (prefix && !repoPath.startsWith(prefix)) return null
  return repoPath.slice(prefix.length)
}

// git diff --numstat -z：每条是「新增\t删除\t路径\0」，二进制是「-\t-\t路径\0」
export function parseNumstat(output: string, prefix: string): GitFileState[] {
  const files: GitFileState[] = []
  for (const entry of output.split('\0')) {
    if (!entry) continue
    const first = entry.indexOf('\t')
    const second = first < 0 ? -1 : entry.indexOf('\t', first + 1)
    if (first < 0 || second < 0) continue
    const added = entry.slice(0, first)
    const removed = entry.slice(first + 1, second)
    const path = projectPath(entry.slice(second + 1), prefix)
    if (!path) continue
    const binary = added === '-' || removed === '-'
    files.push({ path, added: binary ? 0 : Number(added) || 0, removed: binary ? 0 : Number(removed) || 0, binary })
  }
  return files
}

// git rev-list --left-right --count upstream...HEAD：先是落后（上游独有），再是领先
export function parseAheadBehind(output: string): { ahead: number; behind: number } {
  const [behind, ahead] = output.trim().split(/\s+/).map((value) => Number(value) || 0)
  return { ahead: ahead ?? 0, behind: behind ?? 0 }
}

export function countUntracked(content: Buffer): { added: number; binary: boolean } {
  if (content.includes(0)) return { added: 0, binary: true }
  let added = 0
  for (const byte of content) if (byte === 10) added += 1
  if (content.length > 0 && content[content.length - 1] !== 10) added += 1
  return { added, binary: false }
}

// 工作区相对 HEAD 的改动，加上分支和上游状态。不是 Git 仓库时 repo 为 false
export async function projectGitState(cwd: string): Promise<ProjectGitState> {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']).catch(() => '')
  if (inside.trim() !== 'true') return EMPTY
  const prefix = (await git(cwd, ['rev-parse', '--show-prefix']).catch(() => '')).trim()
  const head = (await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '')).trim() || null
  const branch = (await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim() || (head ? head.slice(0, 7) : null)
  const upstream = (await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')).trim() || null
  const { ahead, behind } = upstream ? parseAheadBehind(await git(cwd, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`]).catch(() => '')) : { ahead: 0, behind: 0 }
  const files = parseNumstat(await git(cwd, ['diff', 'HEAD', '--numstat', '--no-renames', '-z', '--', '.']).catch(() => ''), prefix)
  const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.']).catch(() => '')
  for (const repoPath of untracked.split('\0').filter(Boolean)) {
    const path = projectPath(repoPath, prefix)
    if (!path) continue
    const content = await readFile(join(cwd, path)).catch(() => null)
    if (!content) continue
    if (content.length > MAX_UNTRACKED_BYTES) {
      files.push({ path, added: 0, removed: 0, binary: true })
      continue
    }
    files.push({ path, ...countUntracked(content), removed: 0 })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { repo: true, branch, head, upstream, ahead, behind, files }
}
