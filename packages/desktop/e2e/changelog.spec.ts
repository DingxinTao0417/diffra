import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { ChangelogRelease } from '../src/shared/changelog'
import { APP_VERSION, desktopDir, launchApp, makeUserDataDir } from './launch'

// 构建时生成的日志（pnpm test 在跑 e2e 前生成）
const releases = JSON.parse(readFileSync(join(desktopDir, 'out', 'changelog.json'), 'utf8')) as ChangelogRelease[]

const settingsOf = (userDataDir: string) => JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')) as Record<string, unknown>

test('更新日志：全新安装不提示，只记下版本；升级后第一次启动弹出这次带来的改动，能跳到「更新与关于」看全部；再启动不再提示', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const current = releases.find((release) => release.version === APP_VERSION)
  const previous = releases.find((release) => release.version !== APP_VERSION)
  expect(current, `out/changelog.json 里要有 ${APP_VERSION}`).toBeTruthy()
  expect(previous, 'out/changelog.json 里要有更早的版本').toBeTruthy()
  try {
    // 全新安装：不提示，记下当前版本
    let app = await launchApp(userDataDir)
    let window = await app.firstWindow()
    await expect(window.getByTestId('sidebar')).toBeVisible()
    await expect.poll(() => settingsOf(userDataDir).lastSeenVersion).toBe(APP_VERSION)
    await expect(window.getByTestId('update-notice')).toHaveCount(0)
    await app.close()

    // 从更早的版本升上来：列出它之后的版本，不列它自己
    writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ ...settingsOf(userDataDir), lastSeenVersion: previous!.version }))
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    const notice = window.getByTestId('update-notice')
    await expect(notice).toBeVisible({ timeout: 15_000 })
    await expect(notice.getByRole('heading', { name: `已更新到 ${APP_VERSION}` })).toBeVisible()
    const firstItem = [...current!.added, ...current!.fixed][0]!
    await expect(notice).toContainText(firstItem)
    await expect(notice.getByRole('region', { name: `版本 ${previous!.version}` })).toHaveCount(0)
    await window.screenshot({ path: 'test-results/changelog-notice.png' })
    expect(settingsOf(userDataDir).lastSeenVersion).toBe(APP_VERSION)

    // 跳到「更新与关于」：按版本列出全部，当前版本标「当前」
    await notice.getByRole('button', { name: '查看全部更新日志' }).click()
    await expect(notice).toHaveCount(0)
    const changelog = window.getByTestId('changelog')
    await expect(changelog).toBeVisible()
    await expect(changelog.getByRole('region')).toHaveCount(releases.length)
    const currentSection = changelog.getByRole('region', { name: `版本 ${APP_VERSION}` })
    await expect(currentSection).toContainText('当前')
    await expect(currentSection).toContainText(firstItem)
    await expect(changelog.getByRole('region', { name: `版本 ${previous!.version}` })).not.toContainText('当前')
    await window.screenshot({ path: 'test-results/changelog-about.png', fullPage: true })
    await app.close()

    // 再启动：不再提示
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await expect(window.getByTestId('sidebar')).toBeVisible()
    await window.waitForTimeout(1500)
    await expect(window.getByTestId('update-notice')).toHaveCount(0)
    await app.close()
  } finally {
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
