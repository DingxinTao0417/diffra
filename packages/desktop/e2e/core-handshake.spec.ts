import { readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { settingsNav } from './flows'
import { desktopDir, isPackagedRun, launchApp, makeUserDataDir } from './launch'

const { version } = JSON.parse(readFileSync(resolve(desktopDir, 'package.json'), 'utf8')) as { version: string }

test('设置里显示 core 的 ACP 握手结果、版本号和更新状态', async () => {
  const userDataDir = makeUserDataDir()
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await window.getByTestId('sidebar').getByRole('button', { name: '设置' }).click()
    const coreStatus = window.getByTestId('core-status')
    await expect(coreStatus.getByText('已连接', { exact: true })).toBeVisible()
    await expect(coreStatus.getByText(/^diffra-core \S+ · ACP 协议 v\d+$/)).toBeVisible()
    await settingsNav(window).getByRole('button', { name: '更新与关于' }).click()
    await expect(window.getByTestId('app-version')).toHaveText(version)
    if (isPackagedRun()) {
      // 打包版测的是 release/win-unpacked，没经过安装（目录里没有卸载程序），是免安装版，不检查更新
      await expect(window.getByTestId('update-status')).toHaveText('免安装版不检查更新，请用安装版')
    } else {
      // 未打包的应用里 electron-updater 不工作
      await expect(window.getByTestId('update-status')).toHaveText('开发模式不检查更新')
    }
    await window.screenshot({ path: 'test-results/core-handshake.png' })
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
