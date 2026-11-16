// 项目身份（同一个仓库在两台电脑上的不同检出）：node --test scripts/repo-identity.test.ts
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { repoIdentity } from '../src/main/git-state.ts'
import { normalizeRepoOrigin, normalizeRepoSubpath, projectIdentityKey, sameProjectIdentity } from '../src/shared/repo-identity.ts'

test('仓库地址的几种写法认成同一个仓库', () => {
  const expected = 'github.com/dingxintao0417/diffra'
  for (const raw of [
    'https://github.com/DingxinTao0417/diffra.git',
    'git@github.com:DingxinTao0417/diffra.git',
    'ssh://git@github.com/DingxinTao0417/diffra',
    'https://github.com/DingxinTao0417/diffra/',
    'https://token@github.com/DingxinTao0417/diffra.git',
  ]) {
    assert.equal(normalizeRepoOrigin(raw), expected, raw)
  }
  assert.equal(normalizeRepoOrigin(''), null)
  assert.equal(normalizeRepoOrigin('diffra'), null)
})

test('相对路径：反斜杠、开头结尾的分隔符和大小写都不影响', () => {
  assert.equal(normalizeRepoSubpath('packages\\Core\\'), 'packages/core')
  assert.equal(normalizeRepoSubpath(''), '')
})

test('同一个仓库、同一个相对路径才算同一个项目；不同仓库、不同子目录都不算', () => {
  const root = { origin: 'https://github.com/o/r.git', subpath: '' }
  assert.equal(sameProjectIdentity(root, { origin: 'git@github.com:o/r', subpath: '' }), true)
  assert.equal(sameProjectIdentity(root, { origin: 'https://github.com/o/r', subpath: 'packages/core' }), false)
  assert.equal(sameProjectIdentity(root, { origin: 'https://github.com/o/other', subpath: '' }), false)
  assert.equal(sameProjectIdentity(root, null), false)
  assert.equal(projectIdentityKey('D:\\Workspace\\Diffra\\'), 'd:/workspace/diffra')
})

test('读本机项目的仓库身份：读得到 origin 和相对路径；不是仓库、没有 origin 的是 null', async () => {
  const plain = mkdtempSync(join(tmpdir(), 'diffra-repo-plain-'))
  const bare = mkdtempSync(join(tmpdir(), 'diffra-repo-bare-'))
  const repo = mkdtempSync(join(tmpdir(), 'diffra-repo-origin-'))
  const run = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' })
  try {
    assert.equal(await repoIdentity(plain), null)
    run(bare, ['init', '-q'])
    // 是本机的新仓库，但还没有远程地址，认不出是哪里的项目
    assert.equal(await repoIdentity(bare), null)
    run(repo, ['init', '-q'])
    run(repo, ['remote', 'add', 'origin', 'git@github.com:o/r.git'])
    // 归一化后记下来：地址里的用户名和令牌不进结果，发给别的设备时就不会带出去
    assert.deepEqual(await repoIdentity(repo), { origin: 'github.com/o/r', subpath: '' })
    mkdirSync(join(repo, 'packages', 'core'), { recursive: true })
    assert.deepEqual(await repoIdentity(join(repo, 'packages', 'core')), { origin: 'github.com/o/r', subpath: 'packages/core' })
  } finally {
    for (const dir of [plain, bare, repo]) rmSync(dir, { recursive: true, force: true })
  }
})
