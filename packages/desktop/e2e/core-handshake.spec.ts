import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

const desktopDir = resolve(import.meta.dirname, '..')
const { version } = JSON.parse(readFileSync(resolve(desktopDir, 'package.json'), 'utf8')) as { version: string }

test('窗口显示版本号、core 的 ACP 握手结果和更新状态', async () => {
  const app = await electron.launch({ args: ['.'], cwd: desktopDir })
  try {
    const window = await app.firstWindow()
    await expect(window.getByTestId('app-version')).toHaveText(`版本 ${version}`)
    await expect(window.getByTestId('core-status')).toHaveText(/^Core 已连接：diffra-core \S+ · ACP 协议 v\d+$/)
    // e2e 跑的是未打包的应用，electron-updater 不工作
    await expect(window.getByTestId('update-status')).toHaveText('开发模式不检查更新')
    await window.screenshot({ path: 'test-results/core-handshake.png' })
  } finally {
    await app.close()
  }
})
