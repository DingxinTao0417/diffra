import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { openExtensions } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { startOAuthMcpServer } from '../../core/test/fixtures/oauth-mcp-server.ts'

test('扩展：Vercel 用浏览器登录后装上并连上，令牌只加密存本机；退出登录撤销令牌，重新登录又能连上；取消登录不装', async () => {
  test.setTimeout(120_000)
  const userDataDir = makeUserDataDir()
  const remote = await startOAuthMcpServer()
  const app = await launchApp(userDataDir, { DIFFRA_CATALOG_OVERRIDES: JSON.stringify({ mcp: { vercel: { url: remote.url } } }) })
  try {
    // 系统浏览器换成直接请求授权页：假授权服务器不用人点，直接跳回本机回调；hold 为真时只记下不打开，模拟用户没去登录
    await app.evaluate(({ shell }) => {
      const record = globalThis as { oauthOpened?: string[]; oauthHold?: boolean }
      record.oauthOpened = []
      shell.openExternal = (async (url: string) => {
        record.oauthOpened!.push(url)
        if (!record.oauthHold) void fetch(url).catch(() => undefined)
      }) as typeof shell.openExternal
    })
    const opened = () => app.evaluate(() => (globalThis as { oauthOpened?: string[] }).oauthOpened?.length ?? 0)
    const hold = (value: boolean) => app.evaluate((_electron, flag) => ((globalThis as { oauthHold?: boolean }).oauthHold = flag), value)

    const window = await app.firstWindow()
    await openExtensions(window, 'MCP')
    const view = window.getByTestId('extensions-view')
    const vercel = view.getByTestId('catalog-mcp').filter({ hasText: /^Vercel/ })
    await expect(vercel).toContainText('用浏览器登录')
    await expect(view.getByTestId('catalog-mcp').filter({ hasText: 'Railway（远程版）' })).toContainText('用浏览器登录')

    // 先点登录、不去浏览器里登录，取消：不装、不留注册
    await hold(true)
    await vercel.getByRole('button', { name: '安装 Vercel' }).click()
    const form = vercel.getByRole('form', { name: '安装 Vercel' })
    await expect(form).toContainText('用浏览器登录 Vercel 账号')
    await form.getByRole('button', { name: '在浏览器里登录并安装' }).click()
    await expect(form.getByRole('button', { name: '等你在浏览器里登录…' })).toBeDisabled()
    await expect.poll(opened).toBe(1)
    await form.getByRole('button', { name: '取消登录' }).click()
    await expect(form.getByTestId('catalog-install-error')).toContainText('已取消登录')
    await expect(vercel).not.toContainText('已安装')

    // 再来一次，这回浏览器里登录了：连上才装
    await hold(false)
    await form.getByRole('button', { name: '在浏览器里登录并安装' }).click()
    await expect(vercel).toContainText('已安装', { timeout: 30_000 })
    expect(remote.tokenRequests()).toEqual(['authorization_code'])
    await window.screenshot({ path: 'test-results/mcp-oauth-installed.png' })

    await openExtensions(window, '已安装')
    const card = view.getByTestId('mcp-server-card').filter({ hasText: 'vercel' })
    await expect(card.getByTestId('mcp-status')).toHaveText('已连接', { timeout: 30_000 })
    await expect(card.getByTestId('mcp-oauth-status')).toHaveAttribute('data-status', 'signed-in')
    await expect(card.getByTestId('mcp-oauth-status')).toContainText('快到期时自动续')
    await expect(card).not.toContainText('请求头')
    const settingsText = readFileSync(join(userDataDir, 'settings.json'), 'utf8')
    expect(settingsText).toContain('"auth": "oauth"')
    const secretsText = readFileSync(join(userDataDir, 'secrets.json'), 'utf8')

    // 退出登录：令牌在授权服务器上撤销，本机删掉；任务里不再带它
    await card.getByRole('button', { name: '退出登录' }).click()
    await expect(card.getByTestId('mcp-oauth-status')).toHaveAttribute('data-status', 'signed-out')
    await expect(card.getByTestId('mcp-oauth-status')).toHaveText('还没登录，任务里用不了它')
    const revoked = remote.revoked()
    expect(revoked.length).toBeGreaterThanOrEqual(1)
    // 令牌明文从没出现在设置和密钥文件里（密钥文件里是加密的）
    for (const token of revoked) {
      expect(settingsText).not.toContain(token)
      expect(secretsText).not.toContain(token)
    }
    await window.screenshot({ path: 'test-results/mcp-oauth-signed-out.png' })

    // 重新登录：又打开一次授权页，连上
    const before = await opened()
    await card.getByRole('button', { name: '在浏览器里登录' }).click()
    await expect(card.getByTestId('mcp-oauth-status')).toHaveAttribute('data-status', 'signed-in', { timeout: 30_000 })
    expect(await opened()).toBe(before + 1)
    await expect(card.getByTestId('mcp-status')).toHaveText('已连接', { timeout: 30_000 })
  } finally {
    await app.close()
    await remote.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
