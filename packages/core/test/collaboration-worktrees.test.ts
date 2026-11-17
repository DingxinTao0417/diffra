import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { CollaborationWorktree } from '../src/collaboration-types.js'
import { disposeWorkerWorktree, inspectWorkerChanges, integrateWorkerWorktree, prepareWorkerWorktree, refreshWorkerWorktree } from '../src/session/collaboration-worktrees.js'
import * as worktreeHelpers from '../src/session/worktrees.js'

const GIT_TIMEOUT_MS = 30_000
let scratch: string
let project: string
let root: string
let workers: CollaborationWorktree[]

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: project,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
  })
}

async function prepare(id: string, cwd = project): Promise<CollaborationWorktree> {
  const worker = await prepareWorkerWorktree(cwd, root, id)
  workers.push(worker)
  return worker
}

function directoryLink(target: string, link: string): void {
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

async function freshWorktrees() {
  vi.resetModules()
  return import('../src/session/collaboration-worktrees.js')
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'diffra-collaboration-worktrees-'))
  project = join(scratch, 'project')
  root = join(scratch, 'managed')
  workers = []
  mkdirSync(join(project, 'src'), { recursive: true })
  git('init', '-q')
  git('config', 'core.autocrlf', 'false')
  writeFileSync(join(project, '.gitignore'), 'node_modules/\n')
  writeFileSync(join(project, 'src', 'a.txt'), 'one\ntwo\n')
  writeFileSync(join(project, 'b.txt'), 'keep\n')
  git('add', '.')
  git('commit', '-qm', 'init')
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const worker of workers) await disposeWorkerWorktree(worker)
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('多智能体 worktree 桥接', () => {
  test('多个 worker 串行建树，各带 dirty baseline 和子目录，但不改项目或主索引', async () => {
    writeFileSync(join(project, 'src', 'a.txt'), 'one\ntwo\ndirty\n')
    git('add', 'src/a.txt')
    writeFileSync(join(project, 'src', 'a.txt'), 'one\ntwo\ndirty\nunstaged\n')
    writeFileSync(join(project, 'new.txt'), 'untracked\n')
    const index = git('diff', '--cached', '--binary')
    const worktreeList = git('branch', '--list')
    const [first, second] = await Promise.all([prepare('worker-one', join(project, 'src')), prepare('2b7ce6c1-a526-4df4-a6c4-36053d512c92', join(project, 'src'))])
    expect(first.cwd).toBe(join(first.dir, 'src'))
    expect(first.dir).not.toBe(second.dir)
    expect(first.baseTree).toBe(second.baseTree)
    expect(readFileSync(join(first.cwd, 'a.txt'), 'utf8')).toBe('one\ntwo\ndirty\nunstaged\n')
    expect(readFileSync(join(first.dir, 'new.txt'), 'utf8')).toBe('untracked\n')
    writeFileSync(join(first.cwd, 'a.txt'), 'worker one\n')
    writeFileSync(join(second.cwd, 'a.txt'), 'worker two\n')
    expect((await inspectWorkerChanges(first)).paths).toEqual(['src/a.txt'])
    expect(readFileSync(join(project, 'src', 'a.txt'), 'utf8')).toBe('one\ntwo\ndirty\nunstaged\n')
    expect(git('diff', '--cached', '--binary')).toBe(index)
    expect(git('branch', '--list')).toBe(worktreeList)
  })

  test('按 scope 整合 dirty baseline 的增量；返回完整 paths 与 UI 正文，重复整合不重放旧补丁', async () => {
    writeFileSync(join(project, 'src', 'a.txt'), 'one\ntwo\ndirty\n')
    const worker = await prepare('worker')
    writeFileSync(join(worker.dir, 'src', 'a.txt'), 'one\nTWO\ndirty\n')
    writeFileSync(join(worker.dir, 'src', 'new.txt'), 'new\n')
    const before = await inspectWorkerChanges(worker)
    expect(before.patch.toString('utf8')).toContain('+TWO')
    const result = await integrateWorkerWorktree(worker, project, ['src'])
    expect(result).toEqual({
      paths: ['src/a.txt', 'src/new.txt'],
      tree: before.tree,
      changes: [
        { path: 'src/a.txt', oldText: 'one\ntwo\ndirty\n', newText: 'one\nTWO\ndirty\n' },
        { path: 'src/new.txt', oldText: null, newText: 'new\n' },
      ],
    })
    expect(readFileSync(join(project, 'src', 'a.txt'), 'utf8')).toBe('one\nTWO\ndirty\n')
    expect(worker.integratedTree).toBe(before.tree)
    expect((await inspectWorkerChanges(worker)).paths).toEqual([])
    expect(await integrateWorkerWorktree(worker, project, ['src'])).toMatchObject({ paths: [], changes: [] })
    writeFileSync(join(worker.dir, 'src', 'new.txt'), 'newer\n')
    expect((await integrateWorkerWorktree(worker, project, ['src/new.txt'])).paths).toEqual(['src/new.txt'])
    expect(readFileSync(join(project, 'src', 'new.txt'), 'utf8')).toBe('newer\n')
  })

  test('子项目 scope 相对 projectCwd，不能借整合修改仓库的其它目录', async () => {
    const worker = await prepare('worker', join(project, 'src'))
    writeFileSync(join(worker.cwd, 'a.txt'), 'changed\n')
    expect((await integrateWorkerWorktree(worker, join(project, 'src'), ['a.txt'])).paths).toEqual(['src/a.txt'])
    writeFileSync(join(worker.dir, 'b.txt'), 'outside subproject\n')
    await expect(integrateWorkerWorktree(worker, join(project, 'src'), ['.'])).rejects.toThrow('超出允许的写入范围')
    expect(readFileSync(join(project, 'b.txt'), 'utf8')).toBe('keep\n')
  })

  test('UI 返回实际整合后的正文，保留主项目同文件可兼容的其它修改', async () => {
    const baseline = Array.from({ length: 20 }, (_, index) => `line ${index + 1}\n`).join('')
    writeFileSync(join(project, 'b.txt'), baseline)
    const worker = await prepare('worker')
    writeFileSync(join(worker.dir, 'b.txt'), baseline.replace('line 2\n', 'worker line 2\n'))
    const mainText = baseline.replace('line 19\n', 'user line 19\n')
    writeFileSync(join(project, 'b.txt'), mainText)
    const result = await integrateWorkerWorktree(worker, project, ['b.txt'])
    const integratedText = mainText.replace('line 2\n', 'worker line 2\n')
    expect(result.changes).toEqual([{ path: 'b.txt', oldText: mainText, newText: integratedText }])
    expect(readFileSync(join(project, 'b.txt'), 'utf8')).toBe(integratedText)
  })

  test('超范围变更整批拒绝，不会只合一部分；禁写路径也整批拒绝', async () => {
    const worker = await prepare('worker')
    writeFileSync(join(worker.dir, 'src', 'a.txt'), 'changed\n')
    writeFileSync(join(worker.dir, 'b.txt'), 'out of scope\n')
    await expect(integrateWorkerWorktree(worker, project, ['src'])).rejects.toThrow('超出允许的写入范围')
    await expect(integrateWorkerWorktree(worker, project, ['.'], undefined, ['b.txt'])).rejects.toThrow('禁写路径')
    expect(readFileSync(join(project, 'src', 'a.txt'), 'utf8')).toBe('one\ntwo\n')
    expect(readFileSync(join(project, 'b.txt'), 'utf8')).toBe('keep\n')
    expect(worker.integratedTree).toBeNull()
  })

  test('冲突检查无写入、无丢弃，另一个 worker 的无冲突变更仍可整合', async () => {
    const [first, second] = await Promise.all([prepare('first'), prepare('second')])
    writeFileSync(join(first.dir, 'src', 'a.txt'), 'worker\n')
    writeFileSync(join(first.dir, 'added.txt'), 'not applied\n')
    writeFileSync(join(second.dir, 'b.txt'), 'from second\n')
    writeFileSync(join(project, 'src', 'a.txt'), 'user edit\n')
    await expect(integrateWorkerWorktree(first, project, ['.'])).rejects.toThrow('冲突')
    expect(readFileSync(join(project, 'src', 'a.txt'), 'utf8')).toBe('user edit\n')
    expect(existsSync(join(project, 'added.txt'))).toBe(false)
    expect(first.integratedTree).toBeNull()
    expect((await inspectWorkerChanges(first)).paths).toEqual(['added.txt', 'src/a.txt'])
    await integrateWorkerWorktree(second, project, ['b.txt'])
    expect(readFileSync(join(project, 'b.txt'), 'utf8')).toBe('from second\n')
  })

  test('同仓库并发整合串行执行；同一处冲突的 worker 不会覆盖已整合结果', async () => {
    const [first, second] = await Promise.all([prepare('first'), prepare('second')])
    writeFileSync(join(first.dir, 'b.txt'), 'first\n')
    writeFileSync(join(second.dir, 'b.txt'), 'second\n')
    const results = await Promise.allSettled([integrateWorkerWorktree(first, project, ['b.txt']), integrateWorkerWorktree(second, project, ['b.txt'])])
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    const content = readFileSync(join(project, 'b.txt'), 'utf8')
    expect(['first\n', 'second\n']).toContain(content)
    expect([first, second].filter((worker) => worker.integratedTree !== null)).toHaveLength(1)
  })

  test.each(['.env', '.npmrc', 'src/private.key', 'src/.env.local', '.gitmodules', 'src/.git/config', 'src/node_modules/a.txt'])('拒绝敏感或内部路径 %s，项目不写入', async (path) => {
    const worker = await prepare('worker')
    mkdirSync(dirname(join(worker.dir, path)), { recursive: true })
    writeFileSync(join(worker.dir, path), 'worker content\n')
    if (path === 'src/.git/config') {
      // Git 的索引不收 .git，直接构造真实树对象，验证来自补丁的管理目录路径同样会被拒绝。
      const object = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: worker.dir, input: 'worker content\n', encoding: 'utf8', timeout: GIT_TIMEOUT_MS }).trim()
      const makeTree = (input: string) => execFileSync('git', ['mktree'], { cwd: worker.dir, input, encoding: 'utf8', timeout: GIT_TIMEOUT_MS }).trim()
      const gitTree = makeTree(`100644 blob ${object}\tconfig\n`)
      const sourceTree = makeTree(`040000 tree ${gitTree}\t.git\n`)
      const tree = makeTree(`040000 tree ${sourceTree}\tsrc\n`)
      vi.spyOn(worktreeHelpers, 'treeOf').mockResolvedValueOnce(tree)
    }
    if (path.includes('/node_modules/')) execFileSync('git', ['add', '-f', '--', path], { cwd: worker.dir, timeout: GIT_TIMEOUT_MS })
    await expect(integrateWorkerWorktree(worker, project, ['.'])).rejects.toThrow(/受保护|禁写|不安全/)
    expect(existsSync(join(project, path))).toBe(false)
  })

  test('示例环境配置可以整合；大文件和二进制保留路径但不返回大正文，删除返回 null', async () => {
    const worker = await prepare('worker')
    writeFileSync(join(worker.dir, '.env.example'), 'PUBLIC_NAME=example\n')
    writeFileSync(join(worker.dir, 'image.bin'), Buffer.from([0, 1, 2, 255]))
    writeFileSync(join(worker.dir, 'large.txt'), 'x'.repeat(210_000))
    unlinkSync(join(worker.dir, 'b.txt'))
    const result = await integrateWorkerWorktree(worker, project, ['.'])
    expect(result.paths).toEqual(['.env.example', 'b.txt', 'image.bin', 'large.txt'])
    expect(result.changes).toEqual([
      { path: '.env.example', oldText: null, newText: 'PUBLIC_NAME=example\n' },
      { path: 'b.txt', oldText: 'keep\n', newText: null },
      { path: 'image.bin', oldText: null, newText: undefined },
      { path: 'large.txt', oldText: null, newText: undefined },
    ])
    expect(readFileSync(join(project, 'image.bin'))).toEqual(Buffer.from([0, 1, 2, 255]))
  })

  test('目标必须是原实际仓库和原项目目录，不能拿其它仓库或 worker 目录来整合', async () => {
    const worker = await prepare('worker')
    writeFileSync(join(worker.dir, 'b.txt'), 'changed\n')
    await expect(integrateWorkerWorktree(worker, worker.dir, ['.'])).rejects.toThrow('不匹配')
    await expect(integrateWorkerWorktree(worker, join(project, 'src'), ['.'])).rejects.toThrow('不匹配')
    const other = join(scratch, 'other')
    mkdirSync(other)
    execFileSync('git', ['init', '-q'], { cwd: other, timeout: GIT_TIMEOUT_MS })
    await expect(integrateWorkerWorktree(worker, other, ['.'])).rejects.toThrow('不匹配')
    expect(readFileSync(join(project, 'b.txt'), 'utf8')).toBe('keep\n')
  })

  test.each(['../escape', 'a/b', 'a\\b', '.', '..', 'worker.lock:stream', 'CON', '-option'])('workerId %s 在创建前被拒绝', async (id) => {
    await expect(prepareWorkerWorktree(project, root, id)).rejects.toThrow('workerId')
    expect(existsSync(root)).toBe(false)
  })

  test('受控 root 不能是项目内、祖先、相对路径或符号链接；失败不退回主项目', async () => {
    await expect(prepareWorkerWorktree(project, join(project, 'workers'), 'worker')).rejects.toThrow('分离')
    await expect(prepareWorkerWorktree(project, scratch, 'worker')).rejects.toThrow('分离')
    await expect(prepareWorkerWorktree(project, 'relative-root', 'worker')).rejects.toThrow('绝对路径')
    const target = join(scratch, 'target')
    mkdirSync(target)
    directoryLink(target, root)
    await expect(prepareWorkerWorktree(project, root, 'worker')).rejects.toThrow('符号链接')
    expect(readdirSync(target)).toEqual([])
    expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
  })

  test('目录冲突和非 Git 项目报错，不切换到共享写入', async () => {
    const worker = await prepare('worker')
    await expect(prepareWorkerWorktree(project, root, 'worker')).rejects.toThrow('已存在')
    const plain = join(scratch, 'plain')
    mkdirSync(plain)
    await expect(prepareWorkerWorktree(plain, root, 'other')).rejects.toThrow('不能降级')
    expect(existsSync(worker.dir)).toBe(true)
    expect(existsSync(join(root, 'collaboration', 'other'))).toBe(false)
  })

  test('拒绝目标内部链接：即使链接指回项目内，也不能借目录别名写入', async () => {
    const worker = await prepare('worker')
    mkdirSync(join(worker.dir, 'alias'))
    writeFileSync(join(worker.dir, 'alias', 'new.txt'), 'worker\n')
    directoryLink(join(project, 'src'), join(project, 'alias'))
    await expect(integrateWorkerWorktree(worker, project, ['alias'])).rejects.toThrow('符号链接')
    expect(existsSync(join(project, 'src', 'new.txt'))).toBe(false)
  })

  test('checkApply 后目标目录换成外部链接，也会在真正应用前再次拒绝', async () => {
    const worker = await prepare('worker')
    writeFileSync(join(worker.dir, 'src', 'new.txt'), 'worker\n')
    const external = join(scratch, 'external')
    mkdirSync(external)
    writeFileSync(join(external, 'sentinel.txt'), 'untouched\n')
    const original = worktreeHelpers.checkApply
    vi.spyOn(worktreeHelpers, 'checkApply').mockImplementationOnce(async (...args) => {
      const result = await original(...args)
      renameSync(join(project, 'src'), join(project, 'old-src'))
      directoryLink(external, join(project, 'src'))
      return result
    })
    await expect(integrateWorkerWorktree(worker, project, ['src'])).rejects.toThrow('符号链接')
    expect(readdirSync(external)).toEqual(['sentinel.txt'])
    expect(readFileSync(join(external, 'sentinel.txt'), 'utf8')).toBe('untouched\n')
    expect(worker.integratedTree).toBeNull()
  })

  test('Git 符号链接对象不能整合成主项目文件', async () => {
    git('config', 'core.symlinks', 'true')
    const worker = await prepare('worker')
    // 直接造 Git 对象，不依赖 Windows 的文件符号链接权限。
    const object = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: worker.dir, input: 'b.txt', encoding: 'utf8', timeout: GIT_TIMEOUT_MS }).trim()
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `120000,${object},alias`], { cwd: worker.dir, timeout: GIT_TIMEOUT_MS })
    // treeOf 会按磁盘内容更新索引，所以在写树阶段注入这个链接条目。
    const original = worktreeHelpers.treeOf
    vi.spyOn(worktreeHelpers, 'treeOf').mockImplementationOnce(async (...args) => {
      await original(...args)
      execFileSync('git', ['update-index', '--add', '--cacheinfo', `120000,${object},alias`], { cwd: worker.dir, timeout: GIT_TIMEOUT_MS })
      return execFileSync('git', ['write-tree'], { cwd: worker.dir, encoding: 'utf8', timeout: GIT_TIMEOUT_MS }).trim()
    })
    await expect(integrateWorkerWorktree(worker, project, ['.'])).rejects.toThrow('符号链接或子模块')
    expect(existsSync(join(project, 'alias'))).toBe(false)
  })

  test('刷新拒绝未整合修改；已整合后带上其它 worker 和主项目 dirty 改动，仍可继续整合', { timeout: GIT_TIMEOUT_MS }, async () => {
    const [worker, other] = await Promise.all([prepare('worker'), prepare('other')])
    writeFileSync(join(worker.dir, 'src', 'a.txt'), 'worker\n')
    const oldDir = worker.dir
    await expect(refreshWorkerWorktree(worker, project)).rejects.toThrow('未整合')
    expect(worker.dir).toBe(oldDir)
    expect(readFileSync(join(worker.dir, 'src', 'a.txt'), 'utf8')).toBe('worker\n')
    await integrateWorkerWorktree(worker, project, ['src'])
    writeFileSync(join(other.dir, 'b.txt'), 'other worker\n')
    await integrateWorkerWorktree(other, project, ['b.txt'])
    writeFileSync(join(project, 'main-new.txt'), 'main untracked\n')
    expect(await refreshWorkerWorktree(worker, project)).toBe(worker)
    expect(worker.dir).not.toBe(oldDir)
    expect(existsSync(oldDir)).toBe(false)
    expect(readFileSync(join(worker.dir, 'b.txt'), 'utf8')).toBe('other worker\n')
    expect(readFileSync(join(worker.dir, 'main-new.txt'), 'utf8')).toBe('main untracked\n')
    expect((await inspectWorkerChanges(worker)).paths).toEqual([])
    writeFileSync(join(worker.dir, 'b.txt'), 'continued\n')
    await integrateWorkerWorktree(worker, project, ['b.txt'])
    expect(readFileSync(join(project, 'b.txt'), 'utf8')).toBe('continued\n')
  })

  test('取消的整合和刷新不写项目，也不销毁原 worktree', async () => {
    const worker = await prepare('worker')
    const signal = AbortSignal.abort()
    await expect(refreshWorkerWorktree(worker, project, signal)).rejects.toThrow()
    writeFileSync(join(worker.dir, 'b.txt'), 'worker\n')
    await expect(integrateWorkerWorktree(worker, project, ['b.txt'], signal)).rejects.toThrow()
    expect(readFileSync(join(project, 'b.txt'), 'utf8')).toBe('keep\n')
    expect(existsSync(worker.dir)).toBe(true)
    expect(worker.integratedTree).toBeNull()
  })

  test('刷新时创建替代目录失败，原目录和基线都保留', async () => {
    const worker = await prepare('worker')
    const before = { ...worker }
    vi.spyOn(worktreeHelpers, 'createWorktree').mockRejectedValueOnce(new Error('scratch creation failed'))
    await expect(refreshWorkerWorktree(worker, project)).rejects.toThrow('scratch creation failed')
    expect(worker).toEqual(before)
    expect(readFileSync(join(worker.dir, 'b.txt'), 'utf8')).toBe('keep\n')
    expect(readdirSync(join(root, 'collaboration'))).toEqual(['worker'])
  })

  test('刷新建替代目录期间旧 worker 又有修改，就保留旧目录并安全移除替代目录', async () => {
    const worker = await prepare('worker')
    const before = worker.dir
    const original = worktreeHelpers.createWorktree
    vi.spyOn(worktreeHelpers, 'createWorktree').mockImplementationOnce(async (...args) => {
      const replacement = await original(...args)
      writeFileSync(join(worker.dir, 'b.txt'), 'late edit\n')
      return replacement
    })
    await expect(refreshWorkerWorktree(worker, project)).rejects.toThrow('刷新期间出现了未整合')
    expect(worker.dir).toBe(before)
    expect(readFileSync(join(worker.dir, 'b.txt'), 'utf8')).toBe('late edit\n')
    expect(readdirSync(join(root, 'collaboration'))).toEqual(['worker'])
    expect(readFileSync(join(project, 'b.txt'), 'utf8')).toBe('keep\n')
  })

  test('清理只断开共享依赖和其它目录链接，不伤项目依赖和外部目标', async () => {
    mkdirSync(join(project, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(project, 'node_modules', 'pkg', 'index.js'), 'dependency\n')
    const worker = await prepare('worker')
    expect(worker.links).toEqual(['node_modules'])
    expect(lstatSync(join(worker.dir, 'node_modules')).isSymbolicLink()).toBe(true)
    expect((await inspectWorkerChanges(worker)).paths).toEqual([])
    const external = join(scratch, 'external')
    mkdirSync(external)
    writeFileSync(join(external, 'sentinel.txt'), 'external\n')
    directoryLink(external, join(worker.dir, 'extra-link'))
    await disposeWorkerWorktree(worker)
    workers = []
    expect(existsSync(worker.dir)).toBe(false)
    expect(readFileSync(join(project, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('dependency\n')
    expect(readFileSync(join(external, 'sentinel.txt'), 'utf8')).toBe('external\n')
    expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
  })

  test('清理不能伪造管理目录或仓库；目录被换成链接时保留其目标', async () => {
    const worker = await prepare('worker')
    await expect(disposeWorkerWorktree({ ...worker, dir: project })).rejects.toThrow('不是当前进程管理')
    await expect(disposeWorkerWorktree({ ...worker, repoRoot: scratch })).rejects.toThrow('不是当前进程管理')
    await expect(disposeWorkerWorktree({ ...worker, links: ['../project'] })).rejects.toThrow('不是当前进程管理')
    const old = `${worker.dir}-saved`
    renameSync(worker.dir, old)
    directoryLink(project, worker.dir)
    await expect(disposeWorkerWorktree(worker)).rejects.toThrow('符号链接')
    expect(readFileSync(join(project, 'b.txt'), 'utf8')).toBe('keep\n')
    unlinkSync(worker.dir)
    renameSync(old, worker.dir)
  })

  test('worktree 目录已手动移除时仅清理对应 Git 记录', async () => {
    const worker = await prepare('worker')
    rmSync(worker.dir, { recursive: true, force: true })
    await disposeWorkerWorktree(worker)
    workers = []
    expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
    expect(readFileSync(join(project, 'b.txt'), 'utf8')).toBe('keep\n')
  })

  test('共享依赖链接变成真实目录时拒绝清理，不递归误删', async () => {
    mkdirSync(join(project, 'node_modules'), { recursive: true })
    writeFileSync(join(project, 'node_modules', 'sentinel.js'), 'dependency\n')
    const worker = await prepare('worker')
    const dependency = join(worker.dir, 'node_modules')
    unlinkSync(dependency)
    mkdirSync(dependency)
    writeFileSync(join(dependency, 'local.js'), 'local\n')
    await expect(disposeWorkerWorktree(worker)).rejects.toThrow('依赖链接被替换')
    expect(readFileSync(join(dependency, 'local.js'), 'utf8')).toBe('local\n')
    expect(readFileSync(join(project, 'node_modules', 'sentinel.js'), 'utf8')).toBe('dependency\n')
    // 只删除测试刚创建的实际目录，再恢复原链接以验证正常清理路径。
    rmSync(dependency, { recursive: true, force: true })
    directoryLink(join(project, 'node_modules'), dependency)
  })

  test('新 core 模块未经恢复仍拒绝操作，恢复后可检查、整合子项目并清理', async () => {
    mkdirSync(join(project, 'src', 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(project, 'src', 'node_modules', 'pkg', 'index.js'), 'dependency\n')
    const worker = await prepare('worker', join(project, 'src'))
    writeFileSync(join(worker.cwd, 'a.txt'), 'restored worker\n')
    worker.currentTree = (await inspectWorkerChanges(worker)).tree
    const saved = structuredClone(worker)
    const restored = await freshWorktrees()
    await expect(restored.inspectWorkerChanges(saved)).rejects.toThrow('不是当前进程管理')
    await expect(restored.refreshWorkerWorktree(saved, join(project, 'src'))).rejects.toThrow('不是当前进程管理')
    await expect(restored.disposeWorkerWorktree(saved)).rejects.toThrow('不是当前进程管理')
    await restored.restoreWorkerWorktree(saved, join(project, 'src'), root)
    expect(saved).toEqual(worker)
    expect((await restored.inspectWorkerChanges(saved)).paths).toEqual(['src/a.txt'])
    expect((await restored.integrateWorkerWorktree(saved, join(project, 'src'), ['a.txt'])).paths).toEqual(['src/a.txt'])
    expect(readFileSync(join(project, 'src', 'a.txt'), 'utf8')).toBe('restored worker\n')
    await restored.disposeWorkerWorktree(saved)
    workers = []
    expect(existsSync(saved.dir)).toBe(false)
    expect(readFileSync(join(project, 'src', 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('dependency\n')
    expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
  })

  test('恢复已部分整合的快照不会重放旧补丁，可以刷新后继续工作', { timeout: GIT_TIMEOUT_MS }, async () => {
    const worker = await prepare('worker')
    writeFileSync(join(worker.dir, 'b.txt'), 'first integration\n')
    await integrateWorkerWorktree(worker, project, ['b.txt'])
    writeFileSync(join(worker.dir, 'src', 'a.txt'), 'pending integration\n')
    worker.currentTree = (await inspectWorkerChanges(worker)).tree
    const saved = structuredClone(worker)
    const restored = await freshWorktrees()
    await restored.restoreWorkerWorktree(saved, project, root)
    expect((await restored.inspectWorkerChanges(saved)).paths).toEqual(['src/a.txt'])
    await restored.integrateWorkerWorktree(saved, project, ['src'])
    writeFileSync(join(project, 'new.txt'), 'main changes\n')
    const oldDir = saved.dir
    await restored.refreshWorkerWorktree(saved, project)
    expect(saved.dir).not.toBe(oldDir)
    expect(saved.currentTree).toBe(saved.baseTree)
    expect(existsSync(oldDir)).toBe(false)
    expect((await restored.inspectWorkerChanges(saved)).paths).toEqual([])
    expect(readFileSync(join(saved.dir, 'new.txt'), 'utf8')).toBe('main changes\n')
    await restored.disposeWorkerWorktree(saved)
    workers = []
  })

  test('恢复只接受宿主 root/collaboration 下安全单段目录及匹配的项目子目录', async () => {
    const worker = await prepare('worker', join(project, 'src'))
    const restored = await freshWorktrees()
    const wrongRoot = join(scratch, 'wrong-root')
    mkdirSync(join(wrongRoot, 'collaboration'), { recursive: true })
    await expect(restored.restoreWorkerWorktree(worker, join(project, 'src'), wrongRoot)).rejects.toThrow('受控目录')
    await expect(restored.restoreWorkerWorktree(worker, project, root)).rejects.toThrow('子目录不匹配')
    await expect(restored.restoreWorkerWorktree({ ...worker, cwd: worker.dir }, join(project, 'src'), root)).rejects.toThrow('子目录不匹配')
    await expect(restored.restoreWorkerWorktree({ ...worker, repoRoot: scratch }, join(project, 'src'), root)).rejects.toThrow('仓库不匹配')
    await expect(restored.restoreWorkerWorktree(worker, join(project, 'src'), scratch)).rejects.toThrow('分离')
    await expect(restored.restoreWorkerWorktree(worker, join(project, 'src'), 'relative-root')).rejects.toThrow('绝对路径')
    for (const path of [project, join(root, 'collaboration', 'nested', 'worker'), join(root, 'collaboration', 'CON'), join(root, 'collaboration', 'worker.lock:stream')]) {
      await expect(restored.restoreWorkerWorktree({ ...worker, dir: path }, join(project, 'src'), root)).rejects.toThrow('受控目录')
    }
    await expect(restored.disposeWorkerWorktree(worker)).rejects.toThrow('不是当前进程管理')
    expect(existsSync(worker.dir)).toBe(true)
  })

  test('持久路径不能靠折叠点段隐藏祖先链接，也不接受相对路径', async () => {
    const worker = await prepare('worker')
    const restored = await freshWorktrees()
    const alias = join(root, 'collaboration', 'alias')
    directoryLink(project, alias)
    const hidden = `${alias}/../worker`
    for (const saved of [
      { ...worker, dir: hidden, cwd: hidden },
      { ...worker, cwd: `${worker.dir}/.` },
      { ...worker, repoRoot: `${project}/src/..` },
      { ...worker, dir: 'worker' },
    ]) {
      await expect(restored.restoreWorkerWorktree(saved, project, root)).rejects.toThrow('规范的绝对路径')
    }
    await expect(restored.disposeWorkerWorktree(worker)).rejects.toThrow('不是当前进程管理')
    expect(readFileSync(join(project, 'b.txt'), 'utf8')).toBe('keep\n')
    unlinkSync(alias)
  })

  test('恢复拒绝 root、worktree 和项目祖先链接，不跟进链接操作', async () => {
    const worker = await prepare('worker')
    const restored = await freshWorktrees()
    const alias = join(scratch, 'root-alias')
    directoryLink(root, alias)
    await expect(restored.restoreWorkerWorktree(worker, project, alias)).rejects.toThrow('符号链接')
    const projectAlias = join(scratch, 'project-alias')
    directoryLink(project, projectAlias)
    await expect(restored.restoreWorkerWorktree(worker, projectAlias, root)).rejects.toThrow('符号链接')
    const old = `${worker.dir}-saved`
    renameSync(worker.dir, old)
    directoryLink(project, worker.dir)
    await expect(restored.restoreWorkerWorktree(worker, project, root)).rejects.toThrow('符号链接')
    expect(readFileSync(join(project, 'b.txt'), 'utf8')).toBe('keep\n')
    unlinkSync(worker.dir)
    renameSync(old, worker.dir)
  })

  test('复制合法 gitfile 的伪造目录不能恢复；Git 双向登记必须指向本目录', async () => {
    const worker = await prepare('worker')
    const forgedDir = join(root, 'collaboration', 'forged')
    mkdirSync(forgedDir)
    writeFileSync(join(forgedDir, '.git'), readFileSync(join(worker.dir, '.git')))
    writeFileSync(join(forgedDir, 'sentinel.txt'), 'preserved\n')
    const forged = { ...worker, dir: forgedDir, cwd: forgedDir }
    const restored = await freshWorktrees()
    await expect(restored.restoreWorkerWorktree(forged, project, root)).rejects.toThrow('双向登记')
    await expect(restored.disposeWorkerWorktree(forged)).rejects.toThrow('不是当前进程管理')
    expect(readFileSync(join(forgedDir, 'sentinel.txt'), 'utf8')).toBe('preserved\n')
    const gitDir = git('rev-parse', '--git-common-dir').trim()
    const registration = join(project, gitDir, 'worktrees', 'worker', 'gitdir')
    const backlink = readFileSync(registration, 'utf8')
    writeFileSync(registration, `${join(forgedDir, '.git')}\n`)
    await expect(restored.restoreWorkerWorktree(worker, project, root)).rejects.toThrow('双向登记')
    writeFileSync(registration, backlink)
  })

  test('gitfile 必须是普通文件且属于原仓库的 linked worktree，不能指向其它仓库或主 Git 目录', async () => {
    const worker = await prepare('worker')
    const restored = await freshWorktrees()
    const gitFile = join(worker.dir, '.git')
    const original = readFileSync(gitFile)
    unlinkSync(gitFile)
    directoryLink(join(project, '.git'), gitFile)
    await expect(restored.restoreWorkerWorktree(worker, project, root)).rejects.toThrow('Git 管理文件不安全')
    unlinkSync(gitFile)
    writeFileSync(gitFile, `gitdir: ${join(project, '.git')}\n`)
    await expect(restored.restoreWorkerWorktree(worker, project, root)).rejects.toThrow('管理目录不在原仓库')
    const other = join(scratch, 'other')
    mkdirSync(other)
    execFileSync('git', ['init', '-q'], { cwd: other, timeout: GIT_TIMEOUT_MS })
    writeFileSync(gitFile, `gitdir: ${join(other, '.git')}\n`)
    await expect(restored.restoreWorkerWorktree(worker, project, root)).rejects.toThrow('Git 仓库不匹配')
    await expect(restored.disposeWorkerWorktree(worker)).rejects.toThrow('不是当前进程管理')
    expect(existsSync(worker.dir)).toBe(true)
    writeFileSync(gitFile, original)
  })

  test('恢复要求 baseTree、integratedTree 和 currentTree 都是存在的 Git tree 对象', async () => {
    const worker = await prepare('worker')
    const restored = await freshWorktrees()
    const commit = git('rev-parse', 'HEAD').trim()
    const blob = git('rev-parse', 'HEAD:b.txt').trim()
    for (const field of ['baseTree', 'integratedTree', 'currentTree'] as const) {
      for (const tree of ['not-a-tree', '0'.repeat(40), commit, blob]) {
        await expect(restored.restoreWorkerWorktree({ ...worker, [field]: tree }, project, root)).rejects.toThrow()
        await expect(restored.inspectWorkerChanges(worker)).rejects.toThrow('不是当前进程管理')
      }
    }
    expect(existsSync(worker.dir)).toBe(true)
    await restored.restoreWorkerWorktree(worker, project, root)
    expect((await restored.inspectWorkerChanges(worker)).paths).toEqual([])
  })

  test('恢复不能用 links 注入任意路径、跳过真实文件或重复声明依赖', async () => {
    mkdirSync(join(project, 'node_modules'), { recursive: true })
    const worker = await prepare('worker')
    const restored = await freshWorktrees()
    for (const links of [['../project'], ['b.txt'], ['node_modules', 'node_modules'], ['missing/node_modules'], ['node_modules/../b.txt']]) {
      await expect(restored.restoreWorkerWorktree({ ...worker, links }, project, root)).rejects.toThrow(/依赖链接|路径不安全/)
      await expect(restored.disposeWorkerWorktree(worker)).rejects.toThrow('不是当前进程管理')
    }
    await expect(restored.restoreWorkerWorktree({ ...worker, links: [] }, project, root)).rejects.toThrow('未经验证的外部链接')
    expect(readFileSync(join(worker.dir, 'b.txt'), 'utf8')).toBe('keep\n')
  })

  test('依赖链接只允许原项目相同路径，替换为外部、其它依赖或真实目录都拒绝恢复', async () => {
    mkdirSync(join(project, 'node_modules'), { recursive: true })
    mkdirSync(join(project, '.venv'))
    const external = join(scratch, 'external')
    mkdirSync(external)
    writeFileSync(join(external, 'sentinel.txt'), 'untouched\n')
    const worker = await prepare('worker')
    const dependency = join(worker.dir, 'node_modules')
    const restored = await freshWorktrees()
    for (const target of [external, join(project, '.venv')]) {
      unlinkSync(dependency)
      directoryLink(target, dependency)
      await expect(restored.restoreWorkerWorktree(worker, project, root)).rejects.toThrow('原项目的相同路径')
    }
    unlinkSync(dependency)
    mkdirSync(dependency)
    await expect(restored.restoreWorkerWorktree(worker, project, root)).rejects.toThrow('依赖链接无效')
    expect(readFileSync(join(external, 'sentinel.txt'), 'utf8')).toBe('untouched\n')
    rmSync(dependency, { recursive: true })
    directoryLink(join(project, 'node_modules'), dependency)
  })

  test('恢复拒绝未声明的 outside 链接，失败保留 worktree 与外部目标', async () => {
    const worker = await prepare('worker')
    const external = join(scratch, 'external')
    mkdirSync(external)
    writeFileSync(join(external, 'sentinel.txt'), 'untouched\n')
    directoryLink(external, join(worker.dir, 'extra-link'))
    const restored = await freshWorktrees()
    await expect(restored.restoreWorkerWorktree(worker, project, root)).rejects.toThrow('未经验证的外部链接')
    await expect(restored.disposeWorkerWorktree(worker)).rejects.toThrow('不是当前进程管理')
    expect(existsSync(worker.dir)).toBe(true)
    expect(readFileSync(join(external, 'sentinel.txt'), 'utf8')).toBe('untouched\n')
  })

  test('跨进程恢复时原路径已换成新仓库，不能只凭同名 commonDir 登记为可信', async () => {
    const worker = await prepare('worker')
    const savedProject = join(scratch, 'saved-project')
    renameSync(project, savedProject)
    mkdirSync(project)
    execFileSync('git', ['init', '-q'], { cwd: project, timeout: GIT_TIMEOUT_MS })
    writeFileSync(join(project, 'sentinel.txt'), 'new project\n')
    const restored = await freshWorktrees()
    await expect(restored.restoreWorkerWorktree(worker, project, root)).rejects.toThrow()
    await expect(restored.disposeWorkerWorktree(worker)).rejects.toThrow('不是当前进程管理')
    expect(existsSync(worker.dir)).toBe(true)
    expect(readFileSync(join(project, 'sentinel.txt'), 'utf8')).toBe('new project\n')
    rmSync(project, { recursive: true, force: true })
    renameSync(savedProject, project)
  })

  test('原项目替换成其它仓库时不对新仓库运行清理', async () => {
    const worker = await prepare('worker')
    const saved = join(scratch, 'saved-project')
    renameSync(project, saved)
    mkdirSync(project)
    execFileSync('git', ['init', '-q'], { cwd: project, timeout: GIT_TIMEOUT_MS })
    writeFileSync(join(project, 'sentinel.txt'), 'new project\n')
    // 相同路径下的独立 .git 也应按目录身份识别为不同仓库。
    await expect(disposeWorkerWorktree(worker)).rejects.toThrow('Git 管理目录已被替换')
    expect(readFileSync(join(project, 'sentinel.txt'), 'utf8')).toBe('new project\n')
    expect(existsSync(worker.dir)).toBe(true)
    rmSync(project, { recursive: true, force: true })
    renameSync(saved, project)
  })
})
