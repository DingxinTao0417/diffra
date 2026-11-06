import { readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { settingsNav } from './flows'
import { desktopDir, launchApp, makeUserDataDir } from './launch'

const { version } = JSON.parse(readFileSync(resolve(desktopDir, 'package.json'), 'utf8')) as { version: string }

test('侧栏显示版本号；设置里显示 core 的 ACP 握手结果和更新状态', async () => {
  const userDataDir = makeUserDataDir()
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await expect(window.getByTestId('app-version')).toHaveText(version)
    await window.getByTestId('sidebar').getByRole('button', { name: '设置' }).click()
    await expect(window.getByTestId('core-status')).toHaveText(/^已连接：diffra-core \S+ · ACP 协议 v\d+$/)
    await settingsNav(window).getByRole('button', { name: '更新与关于' }).click()
    // e2e 跑的是未打包的应用，electron-updater 不工作
    await expect(window.getByTestId('update-status')).toHaveText('开发模式不检查更新')
    await window.screenshot({ path: 'test-results/core-handshake.png' })
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
