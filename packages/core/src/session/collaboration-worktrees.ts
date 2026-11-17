import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, readlink, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { CollaborationWorktree } from '../collaboration-types.js'
import { isProtectedFile } from '../tools/protected.js'
import { fromMsysPath } from '../tools/workspace.js'
import { applyPatch, captureBaseline, checkApply, createWorktree, patchOf, removeWorktree, repoRootOf, treeOf, WorktreeError } from './worktrees.js'

const MANAGED_DIRECTORY = 'collaboration'
const GIT_TIMEOUT_MS = 120_000
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024
const MAX_CHANGE_TEXT_BYTES = 200_000
const SAFE_WORKER_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const TREE_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const DEPENDENCY_NAMES = new Set(['node_modules', '.venv', 'venv'])
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const execute = promisify(execFile)

interface ManagedWorktree {
  repoRoot: string
  projectCwd: string
  root: string
  dir: string
  cwd: string
  gitDir: string
  commonDir: string
  commonDevice: number
  commonInode: number
  links: string[]
  baseTree: string
}

interface TreeChange {
  path: string
  oldMode: string
  newMode: string
}

export interface WorkerFileChange {
  path: string
  // null 表示文件不存在；undefined 表示二进制文件或正文过大。
  oldText: string | null | undefined
  newText: string | null | undefined
}

export interface WorkerIntegration {
  paths: string[]
  tree: string
  changes: WorkerFileChange[]
}

// 只有本进程创建或重新核验后恢复的目录能被操作，不能凭持久化对象指定任意目录来删除。
const managed = new Map<string, ManagedWorktree>()
const repositoryQueues = new Map<string, Promise<void>>()

async function git(args: string[], cwd: string): Promise<Buffer> {
  const { stdout } = await execute('git', ['-c', 'core.quotepath=false', ...args], {
    cwd,
    encoding: 'buffer',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  return stdout
}

async function gitDirectory(cwd: string, common: boolean): Promise<string> {
  const output = (await git(['rev-parse', common ? '--git-common-dir' : '--absolute-git-dir'], cwd)).toString('utf8').trim()
  const directory = resolve(cwd, fromMsysPath(output))
  await noLinks(directory)
  return realpath(directory)
}

async function serial<T>(repository: string, action: () => Promise<T>): Promise<T> {
  const previous = repositoryQueues.get(repository) ?? Promise.resolve()
  let release = () => {}
  const current = new Promise<void>((done) => { release = done })
  repositoryQueues.set(repository, current)
  await previous
  try {
    return await action()
  } finally {
    release()
    if (repositoryQueues.get(repository) === current) repositoryQueues.delete(repository)
  }
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

function comparable(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function samePath(left: string, right: string): boolean {
  return comparable(resolve(left)) === comparable(resolve(right))
}

function restoredPath(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new WorktreeError('worktree 保存的路径不是规范的绝对路径')
  const absolute = resolve(path)
  // 不能先折叠 alias/../worker 再检查祖先；实际访问可能先经过被隐藏的链接。
  if (comparable(path.split('/').join(sep)) !== comparable(absolute)) throw new WorktreeError('worktree 保存的路径不是规范的绝对路径')
  return absolute
}

async function infoOf(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

// 连同祖先一起检查；即使链接仍指向仓库内部，也不能通过它写文件或递归清理。
async function noLinks(path: string): Promise<void> {
  const absolute = resolve(path)
  const root = parse(absolute).root
  let current = root
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, part)
    const info = await infoOf(current)
    if (!info) return
    if (info.isSymbolicLink()) throw new WorktreeError(`路径包含符号链接或目录联接，拒绝操作：${current}`)
  }
}

function safeRelative(path: string, allowRoot = false): string {
  if (allowRoot && (path === '.' || path === '')) return ''
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '')
  const parts = normalized.split('/')
  if (isAbsolute(fromMsysPath(path)) || parts.some((part) => part === '' || part === '.' || part === '..' || /[\x00-\x1f:]/.test(part) || /[. ]$/.test(part) || WINDOWS_RESERVED_NAME.test(part))) {
    throw new WorktreeError(`路径不安全：${path}`)
  }
  return normalized
}

function forbidden(path: string): boolean {
  return path.split('/').some((part) => {
    const name = part.toLowerCase()
    return name === '.git' || name === '.gitmodules' || name === '.gitconfig' || DEPENDENCY_NAMES.has(name) || isProtectedFile(part)
  })
}

async function controlledRoot(root: string, repoRoot: string, commonDir: string, create = true): Promise<string> {
  if (!isAbsolute(fromMsysPath(root))) throw new WorktreeError('worktree 根目录必须是受控的绝对路径')
  const absolute = resolve(fromMsysPath(root))
  if (absolute === parse(absolute).root || inside(repoRoot, absolute) || inside(absolute, repoRoot) || inside(commonDir, absolute) || inside(absolute, commonDir)) {
    throw new WorktreeError('worktree 根目录必须与项目及 Git 管理目录分离')
  }
  const parts = relative(parse(absolute).root, absolute).split(sep)
  if (parts.some((part) => part.toLowerCase() === '.git' || DEPENDENCY_NAMES.has(part.toLowerCase()) || isProtectedFile(part))) {
    throw new WorktreeError('不能在 Git、依赖或受保护目录中创建 worktree')
  }
  await noLinks(absolute)
  if (create) await mkdir(join(absolute, MANAGED_DIRECTORY), { recursive: true })
  await noLinks(join(absolute, MANAGED_DIRECTORY))
  return realpath(absolute)
}

async function validate(worktree: CollaborationWorktree, missing = false): Promise<ManagedWorktree> {
  const entry = managed.get(comparable(resolve(worktree.dir)))
  if (!entry || !samePath(worktree.dir, entry.dir) || !samePath(worktree.repoRoot, entry.repoRoot) || !samePath(worktree.cwd, entry.cwd) || worktree.baseTree !== entry.baseTree || JSON.stringify(worktree.links) !== JSON.stringify(entry.links)) {
    throw new WorktreeError('不是当前进程管理的协作 worktree，拒绝操作')
  }
  if (dirname(entry.dir) !== join(entry.root, MANAGED_DIRECTORY) || !SAFE_WORKER_ID.test(basename(entry.dir))) throw new WorktreeError('worktree 不在受控目录中')
  await noLinks(entry.dir)
  await noLinks(entry.repoRoot)
  if (!samePath(await gitDirectory(entry.repoRoot, true), entry.commonDir)) throw new WorktreeError('原项目的 Git 仓库已改变，拒绝操作')
  const commonInfo = await lstat(entry.commonDir)
  if (commonInfo.isSymbolicLink() || commonInfo.dev !== entry.commonDevice || commonInfo.ino !== entry.commonInode) throw new WorktreeError('原项目的 Git 管理目录已被替换，拒绝操作')
  const info = await infoOf(entry.dir)
  if (!info && missing) return entry
  if (!info?.isDirectory()) throw new WorktreeError('协作 worktree 目录不存在')
  const gitFile = await infoOf(join(entry.dir, '.git'))
  if (!gitFile?.isFile() || gitFile.isSymbolicLink()) throw new WorktreeError('协作 worktree 的 Git 管理文件不安全')
  if (!samePath(await gitDirectory(entry.dir, false), entry.gitDir) || !samePath(await gitDirectory(entry.dir, true), entry.commonDir)) {
    throw new WorktreeError('协作 worktree 的 Git 仓库已改变')
  }
  return entry
}

async function validateProject(entry: ManagedWorktree, projectCwd: string): Promise<void> {
  const cwd = await realpath(fromMsysPath(projectCwd))
  const root = await repoRootOf(cwd)
  if (!root || !samePath(await realpath(root), entry.repoRoot) || !samePath(cwd, entry.projectCwd) || !samePath(await gitDirectory(cwd, true), entry.commonDir)) {
    throw new WorktreeError('整合目标与创建 worktree 时的项目不匹配')
  }
  await noLinks(cwd)
}

async function createManaged(projectCwd: string, root: string, workerId: string): Promise<CollaborationWorktree> {
  const baseline = await captureBaseline(projectCwd)
  const dir = join(root, MANAGED_DIRECTORY, workerId)
  await noLinks(dir)
  if (await infoOf(dir)) throw new WorktreeError(`协作 worktree 目录已存在：${dir}`)
  const result = await createWorktree(baseline, dir)
  const cwd = resolve(dir, baseline.subdir)
  try {
    await noLinks(cwd)
    await mkdir(cwd, { recursive: true })
    const commonDir = await gitDirectory(dir, true)
    const commonInfo = await lstat(commonDir)
    const entry: ManagedWorktree = {
      repoRoot: baseline.repoRoot,
      projectCwd,
      root,
      dir,
      cwd,
      gitDir: await gitDirectory(dir, false),
      commonDir,
      commonDevice: commonInfo.dev,
      commonInode: commonInfo.ino,
      links: [...result.links],
      baseTree: result.baseTree,
    }
    managed.set(comparable(dir), entry)
    return { repoRoot: entry.repoRoot, dir, cwd, links: [...result.links], baseTree: result.baseTree, integratedTree: null }
  } catch (error) {
    await noLinks(dir)
    for (const path of result.links) await noLinks(dirname(resolve(dir, safeRelative(path))))
    await removeWorktree(baseline.repoRoot, result)
    throw error
  }
}

/** root 由宿主提供，必须是项目之外、无链接的应用管理目录；依赖链接不是 OS 沙箱，宿主仍需限制工具写入。 */
export async function prepareWorkerWorktree(cwd: string, root: string, workerId: string): Promise<CollaborationWorktree> {
  if (!SAFE_WORKER_ID.test(workerId) || WINDOWS_RESERVED_NAME.test(workerId)) throw new WorktreeError('workerId 必须是 UUID 或安全的单段路径名称')
  const projectCwd = await realpath(fromMsysPath(cwd))
  await noLinks(projectCwd)
  const repo = await repoRootOf(projectCwd)
  if (!repo) throw new WorktreeError('多智能体独立 worktree 需要 Git 仓库，不能降级到共享写入')
  const repoRoot = await realpath(repo)
  const commonDir = await gitDirectory(repoRoot, true)
  return serial(commonDir, async () => {
    const managedRoot = await controlledRoot(root, repoRoot, commonDir)
    return createManaged(projectCwd, managedRoot, workerId)
  })
}

async function restoredGitDirectory(dir: string, repoRoot: string, commonDir: string): Promise<string> {
  const gitFile = await infoOf(join(dir, '.git'))
  if (!gitFile?.isFile() || gitFile.isSymbolicLink()) throw new WorktreeError('协作 worktree 的 Git 管理文件不安全')
  const actual = await repoRootOf(dir)
  if (!actual || !samePath(await realpath(actual), dir) || !samePath(await gitDirectory(dir, true), commonDir)) {
    throw new WorktreeError('协作 worktree 与原项目的 Git 仓库不匹配')
  }
  const gitDir = await gitDirectory(dir, false)
  if (!samePath(dirname(gitDir), join(commonDir, 'worktrees'))) throw new WorktreeError('协作 worktree 的 Git 管理目录不在原仓库中')
  const backlink = join(gitDir, 'gitdir')
  const backlinkInfo = await infoOf(backlink)
  if (!backlinkInfo?.isFile() || backlinkInfo.isSymbolicLink()) throw new WorktreeError('协作 worktree 的 Git 反向登记不安全')
  const registeredGitFile = resolve(gitDir, fromMsysPath((await readFile(backlink, 'utf8')).trim()))
  const records = (await git(['worktree', 'list', '--porcelain', '-z'], repoRoot)).toString('utf8').split('\0')
  if (!samePath(registeredGitFile, join(dir, '.git')) || !records.some((record) => record.startsWith('worktree ') && samePath(fromMsysPath(record.slice('worktree '.length)), dir))) {
    throw new WorktreeError('原仓库没有双向登记此协作 worktree，拒绝恢复')
  }
  return gitDir
}

async function validateRestoredLinks(dir: string, repoRoot: string, links: string[]): Promise<void> {
  if (!Array.isArray(links)) throw new WorktreeError('协作 worktree 的依赖链接列表不安全')
  const declared = new Set<string>()
  for (const link of links) {
    if (typeof link !== 'string') throw new WorktreeError('协作 worktree 的依赖链接路径不安全')
    const path = safeRelative(link)
    const parts = path.split('/')
    if (path !== link || !DEPENDENCY_NAMES.has(parts.pop() ?? '') || parts.some(forbidden) || declared.has(comparable(path))) {
      throw new WorktreeError(`协作 worktree 的依赖链接路径不安全：${link}`)
    }
    declared.add(comparable(path))
    const target = resolve(dir, path)
    const source = resolve(repoRoot, path)
    await noLinks(dirname(target))
    await noLinks(source)
    const info = await infoOf(target)
    if (!info?.isSymbolicLink() || !(await infoOf(source))?.isDirectory()) throw new WorktreeError(`协作 worktree 的依赖链接无效：${link}`)
    const destination = resolve(dirname(target), fromMsysPath(await readlink(target)))
    if (!samePath(destination, source) || !samePath(await realpath(target), await realpath(source))) {
      throw new WorktreeError(`协作 worktree 的依赖链接未指向原项目的相同路径：${link}`)
    }
  }
  // 不跟进依赖链接；未声明的外部链接不能借恢复取得可信身份。
  const walk = async (directory: string): Promise<void> => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) {
        const name = relative(dir, path).split(sep).join('/')
        if (declared.has(comparable(name))) continue
        const destination = resolve(dirname(path), fromMsysPath(await readlink(path)))
        if (!inside(dir, destination) || !inside(dir, await realpath(path))) throw new WorktreeError(`协作 worktree 包含未经验证的外部链接：${name}`)
      } else if (info.isDirectory()) await walk(path)
    }
  }
  await walk(dir)
}

/** 持久化数据不是授权；root 必须由宿主提供，恢复失败时只保留现场，不清理任何目录。 */
export async function restoreWorkerWorktree(worktree: CollaborationWorktree, projectCwd: string, root: string): Promise<void> {
  await noLinks(fromMsysPath(projectCwd))
  const cwd = await realpath(fromMsysPath(projectCwd))
  const repo = await repoRootOf(cwd)
  if (!repo) throw new WorktreeError('恢复协作 worktree 需要原 Git 仓库')
  await noLinks(repo)
  const repoRoot = await realpath(repo)
  if (!samePath(restoredPath(worktree.repoRoot), repoRoot)) throw new WorktreeError('恢复目标与原项目仓库不匹配')
  const commonDir = await gitDirectory(repoRoot, true)
  await serial(commonDir, async () => {
    const managedRoot = await controlledRoot(root, repoRoot, commonDir, false)
    const dir = restoredPath(worktree.dir)
    if (!samePath(dirname(dir), join(managedRoot, MANAGED_DIRECTORY)) || !SAFE_WORKER_ID.test(basename(dir)) || WINDOWS_RESERVED_NAME.test(basename(dir))) {
      throw new WorktreeError('worktree 不在受控目录的安全单段路径中')
    }
    await noLinks(dir)
    if (!(await infoOf(dir))?.isDirectory()) throw new WorktreeError('协作 worktree 目录不存在')
    const expectedCwd = resolve(dir, relative(repoRoot, cwd))
    if (!samePath(restoredPath(worktree.cwd), expectedCwd)) throw new WorktreeError('恢复目标与 worktree 的项目子目录不匹配')
    await noLinks(expectedCwd)
    if (!(await infoOf(expectedCwd))?.isDirectory()) throw new WorktreeError('协作 worktree 的项目子目录不存在')
    const existing = managed.get(comparable(dir))
    if (existing) {
      await validate(worktree)
      await validateProject(existing, cwd)
    }
    const commonInfo = await lstat(commonDir)
    const gitDir = await restoredGitDirectory(dir, repoRoot, commonDir)
    const trees = [worktree.baseTree]
    if (worktree.integratedTree !== null) trees.push(worktree.integratedTree)
    if (worktree.currentTree !== undefined) trees.push(worktree.currentTree)
    for (const tree of new Set(trees)) {
      if (typeof tree !== 'string' || !TREE_ID.test(tree) || (await git(['cat-file', '-t', tree], repoRoot)).toString('utf8').trim() !== 'tree') {
        throw new WorktreeError('worktree 保存的树不是有效的 Git 树对象')
      }
    }
    await validateRestoredLinks(dir, repoRoot, worktree.links)
    const currentCommonInfo = await lstat(commonDir)
    if (currentCommonInfo.isSymbolicLink() || currentCommonInfo.dev !== commonInfo.dev || currentCommonInfo.ino !== commonInfo.ino) throw new WorktreeError('恢复期间原项目的 Git 管理目录已被替换')
    // 跨进程不能沿用旧 inode 基线；先验证 Git 双向登记，再记录当前目录身份。
    if (!existing) managed.set(comparable(dir), {
      repoRoot, projectCwd: cwd, root: managedRoot, dir, cwd: expectedCwd, gitDir, commonDir,
      commonDevice: commonInfo.dev, commonInode: commonInfo.ino,
      links: [...worktree.links], baseTree: worktree.baseTree,
    })
  })
}

async function treeChanges(dir: string, from: string, to: string): Promise<TreeChange[]> {
  const fields = (await git(['diff-tree', '-r', '--raw', '--no-abbrev', '--no-renames', '-z', from, to], dir)).toString('utf8').split('\0')
  const changes: TreeChange[] = []
  for (let index = 0; index < fields.length - 1; index += 2) {
    const header = /^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ [A-Z]$/.exec(fields[index] ?? '')
    const path = fields[index + 1]
    if (!header || !path) throw new WorktreeError('无法识别 worktree 文件变化')
    changes.push({ path, oldMode: header[1] ?? '', newMode: header[2] ?? '' })
  }
  return changes
}

async function inspect(worktree: CollaborationWorktree) {
  await validate(worktree)
  const from = worktree.integratedTree ?? worktree.baseTree
  if (!TREE_ID.test(from)) throw new WorktreeError('worktree 基线不是有效的 Git 树')
  const tree = await treeOf(worktree.dir, worktree.links)
  const entries = await treeChanges(worktree.dir, from, tree)
  const patch = await patchOf(worktree.dir, from, tree)
  return { tree, paths: entries.map((entry) => entry.path), patch, entries }
}

export async function inspectWorkerChanges(worktree: CollaborationWorktree): Promise<{ tree: string; paths: string[]; patch: Buffer }> {
  const entry = await validate(worktree)
  return serial(entry.commonDir, async () => {
    const { tree, paths, patch } = await inspect(worktree)
    return { tree, paths, patch }
  })
}

function scopes(cwd: string, paths: string[]): string[] {
  return paths.map((path) => resolve(cwd, safeRelative(path, true)))
}

async function validateChanges(entry: ManagedWorktree, changes: TreeChange[], allowed: string[], readOnly: string[]): Promise<void> {
  for (const change of changes) {
    const path = safeRelative(change.path)
    if (path !== change.path) throw new WorktreeError(`Git 路径包含不安全的分隔符：${change.path}`)
    const target = resolve(entry.repoRoot, path)
    if (!inside(entry.projectCwd, target) || !allowed.some((scope) => inside(scope, target))) throw new WorktreeError(`变更超出允许的写入范围：${path}`)
    if (forbidden(path) || readOnly.some((scope) => inside(scope, target)) || entry.links.some((link) => inside(resolve(entry.repoRoot, link), target))) {
      throw new WorktreeError(`变更涉及受保护文件、依赖或禁写路径：${path}`)
    }
    if ([change.oldMode, change.newMode].some((mode) => mode === '120000' || mode === '160000')) throw new WorktreeError(`不能整合符号链接或子模块变更：${path}`)
    await noLinks(target)
    await noLinks(resolve(entry.dir, path))
  }
}

async function readText(path: string): Promise<string | null | undefined> {
  const info = await infoOf(path)
  if (!info) return null
  if (!info.isFile() || info.size > MAX_CHANGE_TEXT_BYTES) return undefined
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(MAX_CHANGE_TEXT_BYTES + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    const content = buffer.subarray(0, bytesRead)
    return bytesRead > MAX_CHANGE_TEXT_BYTES || content.includes(0) ? undefined : content.toString('utf8')
  } finally {
    await file.close()
  }
}

/** scope 和 readOnlyPaths 相对 projectCwd；宿主必须先完成根项目写入审批再调用。 */
export async function integrateWorkerWorktree(worktree: CollaborationWorktree, projectCwd: string, allowedPaths: string[], signal?: AbortSignal, readOnlyPaths: string[] = []): Promise<WorkerIntegration> {
  const entry = await validate(worktree)
  return serial(entry.commonDir, async () => {
    signal?.throwIfAborted()
    await validateProject(entry, projectCwd)
    const allowed = scopes(entry.projectCwd, allowedPaths)
    const readOnly = scopes(entry.projectCwd, readOnlyPaths)
    const result = await inspect(worktree)
    await validateChanges(entry, result.entries, allowed, readOnly)
    if (result.paths.length === 0) return { paths: [], tree: result.tree, changes: [] }
    const check = await checkApply(entry.repoRoot, result.patch)
    if (!check.ok) throw new WorktreeError(`协作改动与项目冲突，什么都没有写入：${check.conflicts.join('、')}\n${check.message}`)
    const changes: WorkerFileChange[] = []
    for (const change of result.entries) {
      await noLinks(resolve(entry.repoRoot, change.path))
      changes.push({ path: change.path, oldText: await readText(resolve(entry.repoRoot, change.path)), newText: undefined })
    }
    // 检查冲突和生成 UI 正文期间路径可能被换成链接，应用之前重新核验。
    await validate(worktree)
    await validateProject(entry, projectCwd)
    await validateChanges(entry, result.entries, allowed, readOnly)
    signal?.throwIfAborted()
    // git apply 默认全有或全无；不使用 --reject / --3way，也不在应用中途取消。
    await applyPatch(entry.repoRoot, result.patch)
    worktree.integratedTree = result.tree
    for (const change of changes) {
      const target = resolve(entry.repoRoot, change.path)
      await noLinks(target)
      change.newText = await readText(target)
    }
    return { paths: result.paths, tree: result.tree, changes }
  })
}

async function removeManaged(worktree: CollaborationWorktree): Promise<void> {
  const entry = await validate(worktree, true)
  for (const path of entry.links) {
    safeRelative(path)
    await noLinks(dirname(resolve(entry.dir, path)))
    const info = await infoOf(resolve(entry.dir, path))
    if (info && !info.isSymbolicLink()) throw new WorktreeError(`依赖链接被替换成真实目录，拒绝清理：${path}`)
  }
  const links: string[] = []
  // 不跟进任何链接；把普通仓库符号链接也交给 removeWorktree 先断开，避免 Windows 联接被递归清理。
  const walk = async (directory: string): Promise<void> => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) links.push(relative(entry.dir, path).split(sep).join('/'))
      else if (info.isDirectory()) await walk(path)
    }
  }
  if (await infoOf(entry.dir)) await walk(entry.dir)
  await noLinks(entry.dir)
  await removeWorktree(entry.repoRoot, { dir: entry.dir, links })
  managed.delete(comparable(entry.dir))
}

/** 无未整合改动时才刷新：先建完整替代目录，再清理旧目录并更新同一个对象。 */
export async function refreshWorkerWorktree(worktree: CollaborationWorktree, projectCwd: string, signal?: AbortSignal): Promise<CollaborationWorktree> {
  const entry = await validate(worktree)
  return serial(entry.commonDir, async () => {
    signal?.throwIfAborted()
    await controlledRoot(entry.root, entry.repoRoot, entry.commonDir)
    await validateProject(entry, projectCwd)
    if ((await inspect(worktree)).paths.length > 0) throw new WorktreeError('worktree 还有未整合的修改，不能刷新或覆盖')
    const replacement = await createManaged(entry.projectCwd, entry.root, randomUUID())
    try {
      signal?.throwIfAborted()
      if ((await inspect(worktree)).paths.length > 0) throw new WorktreeError('刷新期间出现了未整合的修改，原 worktree 已保留')
      await removeManaged(worktree)
    } catch (error) {
      await removeManaged(replacement)
      throw error
    }
    Object.assign(worktree, replacement)
    worktree.currentTree = replacement.baseTree
    return worktree
  })
}

export async function disposeWorkerWorktree(worktree: CollaborationWorktree): Promise<void> {
  const entry = await validate(worktree, true)
  return serial(entry.commonDir, () => removeManaged(worktree))
}
