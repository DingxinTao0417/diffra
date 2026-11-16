// 任务监控的工作区 Git 状态：node --test scripts/git-state.test.ts
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { countUntracked, parseAheadBehind, parseNumstat, projectGitState } from '../src/main/git-state.ts'

test('numstat：普通、二进制、子目录前缀和目录外路径', () => {
  const output = ['3\t1\tsrc/a.ts\0', '-\t-\tsrc/image.png\0', '5\t0\tother/b.ts\0'].join('')
  assert.deepEqual(parseNumstat(output, 'src/'), [
    { path: 'a.ts', added: 3, removed: 1, binary: false },
    { path: 'image.png', added: 0, removed: 0, binary: true },
  ])
  assert.deepEqual(parseNumstat(output, ''), [
    { path: 'src/a.ts', added: 3, removed: 1, binary: false },
    { path: 'src/image.png', added: 0, removed: 0, binary: true },
    { path: 'other/b.ts', added: 5, removed: 0, binary: false },
  ])
})

test('ahead/behind：先是落后，再是领先', () => {
  assert.deepEqual(parseAheadBehind('2\t3\n'), { ahead: 3, behind: 2 })
  assert.deepEqual(parseAheadBehind(''), { ahead: 0, behind: 0 })
})

test('未跟踪文件：行数、末尾没有换行、二进制', () => {
  assert.deepEqual(countUntracked(Buffer.from('a\nb\n')), { added: 2, binary: false })
  assert.deepEqual(countUntracked(Buffer.from('a\nb')), { added: 2, binary: false })
  assert.deepEqual(countUntracked(Buffer.from('')), { added: 0, binary: false })
  assert.deepEqual(countUntracked(Buffer.from([0x61, 0, 0x62])), { added: 0, binary: true })
})

test('projectGitState：未提交和未跟踪都算，提交后清零；不是 Git 仓库时 repo 为 false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'diffra-git-state-'))
  const run = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  try {
    assert.equal((await projectGitState(dir)).repo, false)
    run(['init', '-q'])
    run(['config', 'user.email', 'test@diffra.local'])
    run(['config', 'user.name', 'Diffra Test'])
    writeFileSync(join(dir, 'tracked.txt'), 'one\n')
    run(['add', '.'])
    run(['commit', '-q', '-m', 'init'])
    writeFileSync(join(dir, 'tracked.txt'), 'one\ntwo\n')
    writeFileSync(join(dir, 'new.txt'), 'a\nb\n')
    const dirty = await projectGitState(dir)
    assert.equal(dirty.repo, true)
    assert.ok(dirty.branch)
    assert.deepEqual(
      dirty.files.map((file) => [file.path, file.added, file.removed]),
      [
        ['new.txt', 2, 0],
        ['tracked.txt', 1, 0],
      ],
    )
    run(['add', '.'])
    run(['commit', '-q', '-m', 'change'])
    assert.deepEqual((await projectGitState(dir)).files, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
