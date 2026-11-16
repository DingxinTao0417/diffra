import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { applyPatch, captureBaseline, checkApply, createWorktree, dependencyDirs, diffStats, diffText, patchOf, removeWorktree, repoRootOf, treeOf } from '../src/session/worktrees.js'

let repo: string
let data: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'diffra-worktrees-repo-'))
  data = mkdtempSync(join(tmpdir(), 'diffra-worktrees-data-'))
  git('init', '-q')
  git('config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
  writeFileSync(join(repo, 'b.txt'), 'keep\n')
  git('add', '.')
  git('commit', '-qm', 'init')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

describe('候选方案的 worktree', () => {
  test('不是 git 仓库、还没有提交时说明原因', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'diffra-worktrees-plain-'))
    try {
      expect(await repoRootOf(plain)).toBeNull()
      await expect(captureBaseline(plain)).rejects.toThrow('要在 Git 仓库里用')
      execFileSync('git', ['init', '-q'], { cwd: plain })
      await expect(captureBaseline(plain)).rejects.toThrow('还没有提交')
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  test('起点带着没提交的改动和没跟踪的新文件；候选里的改动不影响项目，统计、diff 都对', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
    writeFileSync(join(repo, 'new.txt'), 'untracked\n')
    const baseline = await captureBaseline(repo)
    const worktree = await createWorktree(baseline, join(data, 'wt', 'a'))
    expect(readFileSync(join(worktree.dir, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n')
    expect(readFileSync(join(worktree.dir, 'new.txt'), 'utf8')).toBe('untracked\n')
    // 不建分支
    expect(git('branch', '--list')).not.toContain('diffra')

    writeFileSync(join(worktree.dir, 'a.txt'), 'one\nTWO\nthree\n')
    writeFileSync(join(worktree.dir, 'c.txt'), 'added\n')
    const tree = await treeOf(worktree.dir, worktree.links)
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n')
    expect(existsSync(join(repo, 'c.txt'))).toBe(false)
    expect(await diffStats(worktree.dir, worktree.baseTree, tree)).toEqual({ files: 2, added: 2, removed: 1, paths: ['a.txt', 'c.txt'] })
    expect(await diffText(worktree.dir, worktree.baseTree, tree)).toContain('+TWO')

    await removeWorktree(baseline.repoRoot, worktree)
    expect(existsSync(worktree.dir)).toBe(false)
    expect(git('worktree', 'list')).not.toContain('wt')
  })

  test('应用：项目没再改过时合回去；之后项目改了同一处就报冲突，不动文件', async () => {
    const baseline = await captureBaseline(repo)
    const worktree = await createWorktree(baseline, join(data, 'wt', 'a'))
    writeFileSync(join(worktree.dir, 'a.txt'), 'one\nTWO\n')
    writeFileSync(join(worktree.dir, 'img.bin'), Buffer.from([0, 1, 2, 255]))
    const patch = await patchOf(worktree.dir, worktree.baseTree, await treeOf(worktree.dir, worktree.links))

    // 项目又改了同一行：冲突，文件不变
    writeFileSync(join(repo, 'a.txt'), 'one\nzwei\n')
    const conflict = await checkApply(baseline.repoRoot, patch)
    expect(conflict).toMatchObject({ ok: false, conflicts: ['a.txt'] })
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\nzwei\n')
    expect(existsSync(join(repo, 'img.bin'))).toBe(false)

    // 改回去再应用：文本和二进制都合回来
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
    expect(await checkApply(baseline.repoRoot, patch)).toEqual({ ok: true })
    await applyPatch(baseline.repoRoot, patch)
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\nTWO\n')
    expect([...readFileSync(join(repo, 'img.bin'))]).toEqual([0, 1, 2, 255])
    await removeWorktree(baseline.repoRoot, worktree)
  })

  test('依赖目录链到项目里的那一份；删掉 worktree 只断开链接，项目里的依赖还在', async () => {
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
    mkdirSync(join(repo, 'packages', 'app', 'node_modules'), { recursive: true })
    writeFileSync(join(repo, 'packages', 'app', 'node_modules', 'x.js'), 'x\n')
    expect((await dependencyDirs(repo)).sort()).toEqual(['node_modules', 'packages/app/node_modules'])

    const baseline = await captureBaseline(repo)
    const worktree = await createWorktree(baseline, join(data, 'wt', 'a'))
    expect(worktree.links.sort()).toEqual(['node_modules', 'packages/app/node_modules'])
    expect(readFileSync(join(worktree.dir, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('module.exports = 1\n')
    // 链进来的依赖不算候选的改动
    expect((await diffStats(worktree.dir, worktree.baseTree, await treeOf(worktree.dir, worktree.links))).files).toBe(0)

    await removeWorktree(baseline.repoRoot, worktree)
    expect(existsSync(worktree.dir)).toBe(false)
    expect(readFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('module.exports = 1\n')
    expect(readFileSync(join(repo, 'packages', 'app', 'node_modules', 'x.js'), 'utf8')).toBe('x\n')
  })

  test('目录已经被删掉时清理照样不报错，git 的记录也 prune 掉', async () => {
    const baseline = await captureBaseline(repo)
    const worktree = await createWorktree(baseline, join(data, 'wt', 'a'))
    rmSync(worktree.dir, { recursive: true, force: true })
    await removeWorktree(baseline.repoRoot, worktree)
    expect(git('worktree', 'list').trim().split('\n')).toHaveLength(1)
  })

  test('任务目录在仓库的子目录里：记下相对位置', async () => {
    mkdirSync(join(repo, 'pkg'), { recursive: true })
    const baseline = await captureBaseline(join(repo, 'pkg'))
    expect(baseline.subdir).toBe('pkg')
  })
})
