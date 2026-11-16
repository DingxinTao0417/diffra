// 插件更新换目录、失败回滚、启动时恢复、比文件（src/main/plugin-swap.ts）：node --test scripts/plugin-swap.test.ts
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { diffDirs, recoverBackups, swapDir } from '../src/main/plugin-swap.ts'

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'diffra-plugin-swap-'))
  const write = (path: string, text: string) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }
  write(join(root, 'plugins', 'p1', 'plugin.json'), 'old')
  write(join(root, 'plugins', 'p1', '.git', 'HEAD'), 'old-head')
  write(join(root, 'staging', 'new', 'plugin.json'), 'new')
  return { root, write, target: join(root, 'plugins', 'p1'), replacement: join(root, 'staging', 'new'), backup: join(root, 'plugins', '.backup', 'p1') }
}

test('换成功：新的在原位置，备份删掉', async () => {
  const { root, target, replacement, backup } = workspace()
  try {
    let verified = ''
    await swapDir(target, replacement, backup, async () => {
      verified = readFileSync(join(target, 'plugin.json'), 'utf8')
    })
    assert.equal(verified, 'new')
    assert.equal(readFileSync(join(target, 'plugin.json'), 'utf8'), 'new')
    assert.equal(existsSync(backup), false)
    assert.equal(existsSync(replacement), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('验证失败：旧的原样挪回来（连 .git），新的删掉，错误照抛', async () => {
  const { root, target, replacement, backup } = workspace()
  try {
    await assert.rejects(
      swapDir(target, replacement, backup, async () => {
        throw new Error('新版本读不出来')
      }),
      /新版本读不出来/,
    )
    assert.equal(readFileSync(join(target, 'plugin.json'), 'utf8'), 'old')
    assert.equal(readFileSync(join(target, '.git', 'HEAD'), 'utf8'), 'old-head')
    assert.equal(existsSync(backup), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('新的挪不过去（暂存目录没了）：旧的挪回来', async () => {
  const { root, target, replacement, backup } = workspace()
  try {
    rmSync(replacement, { recursive: true })
    await assert.rejects(swapDir(target, replacement, backup, async () => undefined))
    assert.equal(readFileSync(join(target, 'plugin.json'), 'utf8'), 'old')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('启动时恢复：原位置没了的挪回去，原位置在的删掉备份', async () => {
  const { root, write } = workspace()
  try {
    const plugins = join(root, 'plugins')
    write(join(plugins, '.backup', 'lost', 'plugin.json'), 'lost')
    write(join(plugins, '.backup', 'p1', 'plugin.json'), 'stale')
    assert.deepEqual(await recoverBackups(plugins, join(plugins, '.backup')), ['lost'])
    assert.equal(readFileSync(join(plugins, 'lost', 'plugin.json'), 'utf8'), 'lost')
    assert.equal(readFileSync(join(plugins, 'p1', 'plugin.json'), 'utf8'), 'old')
    assert.equal(existsSync(join(plugins, '.backup', 'p1')), false)
    assert.deepEqual(await recoverBackups(plugins, join(root, 'no-such-dir')), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('比文件：加了、删了、改了，不看 .git；超过上限时截断', async () => {
  const { root, write } = workspace()
  try {
    const before = join(root, 'before')
    const after = join(root, 'after')
    write(join(before, 'same.md'), 'x')
    write(join(before, 'changed.md'), '1')
    write(join(before, 'gone.md'), 'bye')
    write(join(before, '.git', 'HEAD'), 'a')
    write(join(after, 'same.md'), 'x')
    write(join(after, 'changed.md'), '2')
    write(join(after, 'hooks', 'hooks.json'), '{}')
    write(join(after, '.git', 'HEAD'), 'b')
    assert.deepEqual(await diffDirs(before, after), { added: ['hooks/hooks.json'], removed: ['gone.md'], modified: ['changed.md'], truncated: false })
    for (let index = 0; index < 4; index++) write(join(after, `new-${index}.md`), String(index))
    const limited = await diffDirs(before, after, 2)
    assert.deepEqual(limited.added, ['hooks/hooks.json', 'new-0.md'])
    assert.equal(limited.truncated, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
