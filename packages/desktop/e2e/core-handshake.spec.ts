import { resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('窗口显示 core 的 ACP 握手结果', async () => {
  const app = await electron.launch({ args: ['.'], cwd: resolve(import.meta.dirname, '..') })
  try {
    const window = await app.firstWindow()
    await expect(window.getByTestId('core-status')).toHaveText(/^Core 已连接：diffra-core \S+ · ACP 协议 v\d+$/)
    await window.screenshot({ path: 'test-results/core-handshake.png' })
  } finally {
    await app.close()
  }
})
