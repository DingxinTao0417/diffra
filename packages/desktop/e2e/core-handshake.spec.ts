import { readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { desktopDir, launchApp, makeUserDataDir } from './launch'

const { version } = JSON.parse(readFileSync(resolve(desktopDir, 'package.json'), 'utf8')) as { version: string }

test('顶栏显示版本号、core 的 ACP 握手结果和更新状态', async () => {
  const userDataDir = makeUserDataDir()
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await expect(window.getByTestId('app-version')).toHaveText(`版本 ${version}`)
    await expect(window.getByTestId('core-status')).toHaveText(/^Core 已连接：diffra-core \S+ · ACP 协议 v\d+$/)
    // e2e 跑的是未打包的应用，electron-updater 不工作
    await expect(window.getByTestId('update-status')).toHaveText('开发模式不检查更新')
    await window.screenshot({ path: 'test-results/core-handshake.png' })
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
