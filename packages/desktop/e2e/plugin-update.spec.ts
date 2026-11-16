import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'
import { openExtensions } from './flows'
import { launchApp, makeUserDataDir } from './launch'

function write(path: string, content: string) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...args], { cwd: dir })
const commit = (dir: string, message: string) => {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', message)
}
const manifest = (version: string, name = 'demo') => JSON.stringify({ name, version })
const hooks = (text: string) => JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `echo ${text}` }] }] } })

test('扩展：从 Git 装的插件检查更新，看过改了哪些文件再更新；钩子变了要重新允许，没变的照旧允许；新版本坏了或改了名不换、原来的照常用；没网时说没查成', async () => {
  test.setTimeout(150_000)
  const userDataDir = makeUserDataDir()
  const workspace = mkdtempSync(join(tmpdir(), 'diffra-e2e-plugin-update-'))
  const repo = join(workspace, 'market')
  const demo = join(repo, 'plugins', 'demo')
  write(join(demo, '.claude-plugin', 'plugin.json'), manifest('1.0.0'))
  write(join(demo, 'commands', 'hello.md'), '打个招呼')
  write(join(demo, 'commands', 'old.md'), '旧命令')
  write(join(demo, 'hooks', 'hooks.json'), hooks('HOOK-V1'))
  write(join(repo, 'README.md'), '市场')
  git(repo, 'init', '-q')
  commit(repo, 'v1')
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await openExtensions(window, '已安装')
    await window.getByRole('button', { name: '从 Git 安装' }).click()
    const dialog = window.getByRole('dialog')
    await dialog.getByLabel('仓库地址').fill(pathToFileURL(repo).href)
    await dialog.getByLabel('子目录（可选）').fill('plugins/demo')
    await dialog.getByRole('button', { name: '安装' }).click()
    // 带钩子的先给看，允许后装
    const review = dialog.getByTestId('plugin-review')
    await expect(review).toContainText('HOOK-V1', { timeout: 30_000 })
    await review.getByRole('checkbox').click()
    await review.getByRole('button', { name: '安装', exact: true }).click()
    await expect(dialog).toBeHidden({ timeout: 30_000 })
    const card = window.getByTestId('plugin-card').filter({ hasText: 'demo' })
    await expect(card).toContainText('v1.0.0')
    await expect(card.getByTestId('plugin-contents')).toContainText('钩子已允许')

    // 没有新版本
    const check = window.getByRole('button', { name: '检查更新' })
    await check.click()
    await expect(window.getByTestId('plugin-update-summary')).toHaveText('从 Git 装的插件都是最新的')
    await expect(card.getByTestId('plugin-update-available')).toHaveCount(0)

    // 新版本：加了一个命令、删了一个、改了一个，钩子没变
    write(join(demo, '.claude-plugin', 'plugin.json'), manifest('1.1.0'))
    write(join(demo, 'commands', 'hello.md'), '打个招呼（新版）')
    rmSync(join(demo, 'commands', 'old.md'))
    write(join(demo, 'commands', 'bye.md'), '说再见')
    commit(repo, 'v1.1')
    await check.click()
    await expect(window.getByTestId('plugin-update-summary')).toHaveText('1 个插件有新版本')
    await expect(card.getByTestId('plugin-update-available')).toBeVisible()
    await card.getByRole('button', { name: '更新', exact: true }).click()
    const update = card.getByTestId('plugin-update')
    await expect(update).toContainText('v1.0.0 → v1.1.0', { timeout: 30_000 })
    const files = update.getByTestId('plugin-update-files')
    await expect(files).toContainText('新加：commands/bye.md')
    await expect(files).toContainText('删掉：commands/old.md')
    await expect(files).toContainText('改了：.claude-plugin/plugin.json、commands/hello.md')
    await expect(update).toContainText('钩子没变，照旧允许')
    await window.screenshot({ path: 'test-results/plugin-update-review.png' })

    // 先取消：还是旧的，暂存的克隆删掉
    await update.getByRole('button', { name: '取消' }).click()
    await expect(update).toHaveCount(0)
    await expect(card).toContainText('v1.0.0')
    const staging = join(userDataDir, 'plugins', '.staging')
    await expect.poll(() => (existsSync(staging) ? readdirSync(staging) : [])).toEqual([])

    // 再来，这回更新：版本、内容换了，钩子照旧允许，备份不留
    await card.getByRole('button', { name: '更新', exact: true }).click()
    await update.getByRole('button', { name: '更新', exact: true }).click()
    await expect(update).toHaveCount(0, { timeout: 30_000 })
    await expect(card).toContainText('v1.1.0')
    await expect(card.getByTestId('plugin-update-available')).toHaveCount(0)
    await expect(card.getByTestId('plugin-contents')).toContainText('钩子已允许')
    const clone = readdirSync(join(userDataDir, 'plugins')).find((name) => !name.startsWith('.'))!
    expect(readFileSync(join(userDataDir, 'plugins', clone, 'plugins', 'demo', 'commands', 'bye.md'), 'utf8')).toBe('说再见')
    expect(existsSync(join(userDataDir, 'plugins', clone, 'plugins', 'demo', 'commands', 'old.md'))).toBe(false)
    expect(readdirSync(join(userDataDir, 'plugins', '.backup'))).toEqual([])

    // 钩子变了：列出新命令，不勾就更新，钩子变成没允许
    write(join(demo, '.claude-plugin', 'plugin.json'), manifest('1.2.0'))
    write(join(demo, 'hooks', 'hooks.json'), hooks('HOOK-V2'))
    commit(repo, 'v1.2')
    await check.click()
    await card.getByRole('button', { name: '更新', exact: true }).click()
    await expect(update).toContainText('钩子变了', { timeout: 30_000 })
    await expect(update.getByTestId('plugin-hooks')).toContainText('HOOK-V2')
    await update.getByRole('button', { name: '更新', exact: true }).click()
    await expect(card).toContainText('v1.2.0', { timeout: 30_000 })
    await expect(card.getByTestId('plugin-contents')).toContainText('钩子没允许，不会运行')

    // 新版本的清单坏了：取回时就读不出来，不换，原来的照常
    write(join(demo, '.claude-plugin', 'plugin.json'), '{坏了')
    commit(repo, 'broken')
    await check.click()
    await card.getByRole('button', { name: '更新', exact: true }).click()
    await expect(card.getByTestId('plugin-update-error')).toBeVisible({ timeout: 30_000 })
    await expect(card).toContainText('v1.2.0')
    await expect(card.getByTestId('plugin-contents')).toContainText('2 个命令')

    // 新版本改了名：不当成更新
    write(join(demo, '.claude-plugin', 'plugin.json'), manifest('2.0.0', 'renamed'))
    commit(repo, 'rename')
    await card.getByRole('button', { name: '更新', exact: true }).click()
    await expect(card.getByTestId('plugin-update-error')).toContainText('和装着的「demo」不一样', { timeout: 30_000 })
    await expect(card).toContainText('v1.2.0')

    // 仓库没了（像断网）：说没查成，插件照常
    rmSync(repo, { recursive: true, force: true })
    await check.click()
    await expect(window.getByTestId('plugin-update-summary')).toContainText('1 个没查成')
    await expect(card).toContainText('检查新版本失败')
    await expect(card).toContainText('v1.2.0')
    await expect(card.getByRole('button', { name: '更新', exact: true })).toHaveCount(0)
  } finally {
    await app.close()
    rmSync(workspace, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
