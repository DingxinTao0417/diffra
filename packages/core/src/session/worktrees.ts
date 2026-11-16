import { spawn } from 'node:child_process'
import { cp, lstat, mkdir, readdir, rm, rmdir, stat, symlink, unlink } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

// 多候选方案（v2）用的 git worktree：每个候选在用户仓库外面的一个独立工作目录里改，互不影响，选中的那个再合回项目。
// 用 --detach，不建分支；工作目录放在应用数据目录下，不往项目里写。git 会在仓库的 .git/worktrees 里记一笔，清理时 prune 掉

const GIT_TIMEOUT_MS = 120_000
const MAX_UNTRACKED_FILES = 5000
// 依赖目录不复制，链接到项目里的那一份（Windows 用目录联接，不要管理员权限），候选里设成禁写，免得改坏项目的依赖
const DEPENDENCY_DIRS = new Set(['node_modules', '.venv', 'venv'])
const DEPENDENCY_DEPTH = 3

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Diffra',
  GIT_AUTHOR_EMAIL: 'candidate@diffra.local',
  GIT_COMMITTER_NAME: 'Diffra',
  GIT_COMMITTER_EMAIL: 'candidate@diffra.local',
  // 不弹任何交互
  GIT_TERMINAL_PROMPT: '0',
}

export class WorktreeError extends Error {}

// 跑一条 git 命令：输入、输出都按字节（补丁里可能有二进制）
function git(args: string[], cwd: string, input?: Buffer, okCodes: number[] = [0]): Promise<{ stdout: Buffer; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', ...args], { cwd, env: { ...process.env, ...GIT_ENV }, windowsHide: true })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const result = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8').trim(), code: code ?? -1 }
      if (code !== null && okCodes.includes(code)) resolve(result)
      else reject(new WorktreeError(`git ${args.join(' ')} 失败（${code}）：${result.stderr}`))
    })
    child.stdin.end(input ?? Buffer.alloc(0))
  })
}

const text = async (args: string[], cwd: string) => (await git(args, cwd)).stdout.toString('utf8').trim()

// 项目所在的 git 仓库根目录；不是 git 仓库时为 null。按 --show-cdup（相对路径）算，
// 不用 --show-toplevel：Git Bash 里的 git 给的是 /d/... 这种写法
export async function repoRootOf(cwd: string): Promise<string | null> {
  try {
    const up = await text(['rev-parse', '--show-cdup'], cwd)
    return resolve(cwd, up || '.')
  } catch {
    return null
  }
}

// 候选的起点：仓库的 HEAD 加上工作区里还没提交的改动（含没跟踪的新文件），和用户眼前的项目一样
export interface Baseline {
  repoRoot: string
  // 任务目录相对仓库根目录（/ 分隔），在根目录就是空串
  subdir: string
  head: string
  patch: Buffer
  untracked: string[]
}

export async function captureBaseline(cwd: string): Promise<Baseline> {
  const repoRoot = await repoRootOf(cwd)
  if (!repoRoot) throw new WorktreeError('多候选方案要在 Git 仓库里用：每个候选是一个 git worktree')
  const head = await text(['rev-parse', '--verify', 'HEAD'], repoRoot).catch(() => {
    throw new WorktreeError('这个仓库还没有提交，建不了 worktree；先提交一次再生成候选方案')
  })
  const patch = (await git(['diff', '--binary', 'HEAD'], repoRoot)).stdout
  const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z'], repoRoot)).stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
  if (untracked.length > MAX_UNTRACKED_FILES) throw new WorktreeError(`项目里没跟踪的文件有 ${untracked.length} 个，太多了；先提交或加进 .gitignore 再生成候选方案`)
  return { repoRoot, subdir: relative(repoRoot, cwd).split(sep).join('/'), head, patch, untracked }
}

// 依赖目录：仓库里（不进依赖目录本身）三层以内的 node_modules、.venv、venv，相对仓库根目录
export async function dependencyDirs(repoRoot: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string, depth: number) => {
    const entries = await readdir(join(repoRoot, dir), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.git') continue
      const rel = dir ? `${dir}/${entry.name}` : entry.name
      if (DEPENDENCY_DIRS.has(entry.name)) found.push(rel)
      else if (depth < DEPENDENCY_DEPTH) await walk(rel, depth + 1)
    }
  }
  await walk('', 1)
  return found
}

export interface Worktree {
  dir: string
  // 链进来的依赖目录（相对 worktree 根目录），清理时先断开链接
  links: string[]
  // 起点的 git 树（只认项目里的文件，不含链进来的依赖）
  baseTree: string
}

// 建一个候选的 worktree：从 HEAD 检出，补上没提交的改动和没跟踪的文件，链上依赖目录，记下起点的树
export async function createWorktree(baseline: Baseline, dir: string): Promise<Worktree> {
  await mkdir(dirname(dir), { recursive: true })
  await git(['worktree', 'add', '--detach', dir, baseline.head], baseline.repoRoot)
  const links: string[] = []
  try {
    if (baseline.patch.length > 0) await git(['apply', '--binary', '--whitespace=nowarn'], dir, baseline.patch)
    for (const file of baseline.untracked) {
      const target = join(dir, file)
      await mkdir(dirname(target), { recursive: true })
      await cp(join(baseline.repoRoot, file), target, { force: true, verbatimSymlinks: true })
    }
    for (const rel of await dependencyDirs(baseline.repoRoot)) {
      const target = join(dir, rel)
      if (await stat(target).catch(() => null)) continue
      await mkdir(dirname(target), { recursive: true })
      await symlink(join(baseline.repoRoot, rel), target, process.platform === 'win32' ? 'junction' : 'dir')
      links.push(rel)
    }
    return { dir, links, baseTree: await treeOf(dir, links) }
  } catch (error) {
    await removeWorktree(baseline.repoRoot, { dir, links }).catch(() => undefined)
    throw error
  }
}

// worktree 当前的树：所有改动都暂存进它自己的索引再写树；链进来的依赖目录不算。
// 已经被 .gitignore 忽略的链接不能再写进排除：git add 碰到点名的被忽略路径会退出 1（检查点那边踩过，第 632 步）
export async function treeOf(dir: string, links: string[]): Promise<string> {
  const ignored = links.length > 0 ? new Set((await git(['check-ignore', '--stdin', '-z'], dir, Buffer.from(`${links.join('\0')}\0`), [0, 1])).stdout.toString('utf8').split('\0')) : new Set<string>()
  await git(['add', '--all', '--', '.', ...links.filter((link) => !ignored.has(link)).map((link) => `:(exclude,literal)${link}`)], dir)
  return text(['write-tree'], dir)
}

export interface DiffStats {
  files: number
  added: number
  removed: number
  paths: string[]
}

export async function diffStats(dir: string, from: string, to: string): Promise<DiffStats> {
  const lines = (await text(['diff-tree', '-r', '--numstat', '--no-renames', from, to], dir)).split('\n').filter(Boolean)
  let added = 0
  let removed = 0
  const paths: string[] = []
  for (const line of lines) {
    const [plus = '0', minus = '0', ...rest] = line.split('\t')
    // 二进制文件是「-」
    added += Number(plus) || 0
    removed += Number(minus) || 0
    paths.push(rest.join('\t'))
  }
  return { files: paths.length, added, removed, paths }
}

// 给人看的 diff（二进制文件只写一句）
export async function diffText(dir: string, from: string, to: string): Promise<string> {
  return (await git(['diff-tree', '-p', '-r', '--no-renames', '--no-color', from, to], dir)).stdout.toString('utf8')
}

// 合回项目用的补丁：带二进制、完整的对象 id，路径相对仓库根目录
export async function patchOf(dir: string, from: string, to: string): Promise<Buffer> {
  return (await git(['diff-tree', '-p', '-r', '--no-renames', '--binary', '--full-index', from, to], dir)).stdout
}

// 应用前检查：项目在生成候选之后又改过的文件会对不上。不改任何文件
export async function checkApply(repoRoot: string, patch: Buffer): Promise<{ ok: true } | { ok: false; conflicts: string[]; message: string }> {
  const result = await git(['apply', '--check', '--binary', '--whitespace=nowarn'], repoRoot, patch, [0, 1])
  if (result.code === 0) return { ok: true }
  const conflicts = new Set<string>()
  for (const line of result.stderr.split('\n')) {
    const match = /^error: (?:patch failed: (.+?):\d+|(.+?): (?:does not exist in index|already exists in working directory|No such file or directory|patch does not apply))$/.exec(line.trim())
    const path = match?.[1] ?? match?.[2]
    if (path) conflicts.add(path)
  }
  return { ok: false, conflicts: [...conflicts], message: result.stderr }
}

export async function applyPatch(repoRoot: string, patch: Buffer): Promise<void> {
  await git(['apply', '--binary', '--whitespace=nowarn'], repoRoot, patch)
}

// 删掉 worktree：先断开链进来的依赖目录（只删链接本身，不碰项目里的依赖），再让 git 删目录、prune 掉记录。
// 目录已经不在、git 已经不认识它时照样清干净
export async function removeWorktree(repoRoot: string, worktree: Pick<Worktree, 'dir' | 'links'>): Promise<void> {
  for (const rel of worktree.links) {
    const link = join(worktree.dir, rel)
    const info = await lstat(link).catch(() => null)
    if (!info) continue
    // Windows 的目录联接用 rmdir 断开，符号链接用 unlink；都不会跟进去删目标
    if (info.isSymbolicLink()) await unlink(link).catch(() => rmdir(link)).catch(() => undefined)
    // 断不开就不往下删：递归删除可能顺着链接删掉项目里真正的依赖
    if (await lstat(link).catch(() => null)) throw new WorktreeError(`断不开依赖目录的链接 ${link}，没有删除这个 worktree，免得误删项目的依赖。请手动删除 ${worktree.dir}`)
  }
  await git(['worktree', 'remove', '--force', '--force', worktree.dir], repoRoot).catch(() => undefined)
  await rm(worktree.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  await git(['worktree', 'prune'], repoRoot).catch(() => undefined)
}
