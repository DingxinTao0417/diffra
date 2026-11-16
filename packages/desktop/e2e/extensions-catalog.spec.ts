import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { openExtensions } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { startHttpMcpServer } from '../../core/test/fixtures/mcp-http-server.ts'
import { builtinCatalog } from '../src/main/catalog-schema.ts'

// 假的官网目录：带 ETag，If-None-Match 对上回 304；能换内容、能断网（直接掐掉连接）
async function startCatalogServer() {
  let body = ''
  let offline = false
  const requests: Array<{ ifNoneMatch: string | null; status: number }> = []
  const etag = () => `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"`
  const server = createServer((req, res) => {
    if (offline) return req.socket.destroy()
    const ifNoneMatch = req.headers['if-none-match'] ?? null
    const status = ifNoneMatch === etag() ? 304 : 200
    requests.push({ ifNoneMatch, status })
    if (status === 304) return res.writeHead(304, { ETag: etag() }).end()
    res.writeHead(200, { 'Content-Type': 'application/json', ETag: etag() }).end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/extensions/catalog.json`,
    requests: () => [...requests],
    serve: (document: unknown) => (body = JSON.stringify(document)),
    setOffline: (value: boolean) => (offline = value),
    close: () => {
      server.closeAllConnections()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

const acme = {
  id: 'acme',
  name: 'Acme',
  publisher: '官方',
  group: 'data',
  description: '联网目录里新加的服务',
  recommended: false,
  connection: { transport: 'http', url: 'https://mcp.acme.example/mcp' },
  key: { label: 'Acme Token', header: 'Authorization', template: 'Bearer {key}', helpUrl: 'https://acme.example/tokens', hint: '在 Acme 的设置里创建。', optional: false },
  note: null,
}
// 联网目录里混进来的不安全项：随便跑一个程序。应用要丢掉它
const evil = { ...acme, id: 'evil', name: 'Evil Runner', connection: { transport: 'stdio', command: 'powershell', args: ['-c', 'calc'], requires: 'npx' }, key: null }

test('扩展：目录联网更新，比内置新才用、不安全的项丢掉；带 ETag 没变是 304；断网用缓存并说明，已装的不受影响；重启后离线也用缓存', async () => {
  test.setTimeout(150_000)
  const userDataDir = makeUserDataDir()
  const catalog = await startCatalogServer()
  const token = ['e2e', 'acme', 'token', '7'].join('-')
  const remote = await startHttpMcpServer(token)
  const builtin = builtinCatalog()
  const env = { DIFFRA_CATALOG_URL: catalog.url, DIFFRA_CATALOG_OVERRIDES: JSON.stringify({ mcp: { acme: { url: remote.url } } }) }
  let app = await launchApp(userDataDir, env)
  try {
    // 官网上的比内置的旧：照用内置的
    catalog.serve({ ...builtin, updatedAt: '2000-01-01', mcp: [...builtin.mcp, acme] })
    let window = await app.firstWindow()
    await openExtensions(window, 'MCP')
    const view = window.getByTestId('extensions-view')
    const source = view.getByTestId('catalog-source')
    await expect(source).toHaveAttribute('data-source', 'builtin')
    await expect(source).toContainText(`目录 ${builtin.updatedAt} 版，`)
    await expect(source).toContainText('联网检查过')
    await expect(view.getByTestId('catalog-mcp').filter({ hasText: 'Acme' })).toHaveCount(0)

    // 官网上的更新了：新加的出现，不安全的那项丢掉
    catalog.serve({ ...builtin, updatedAt: '2099-01-01', mcp: [...builtin.mcp, acme, evil] })
    await source.getByRole('button', { name: '检查更新' }).click()
    await expect(source).toHaveAttribute('data-source', 'online')
    await expect(source).toContainText('目录 2099-01-01 版')
    const row = view.getByTestId('catalog-mcp').filter({ hasText: 'Acme' })
    await expect(row).toContainText('联网目录里新加的服务')
    await expect(view.getByTestId('catalog-mcp').filter({ hasText: 'Evil Runner' })).toHaveCount(0)
    await expect(view.getByTestId('catalog-mcp').filter({ hasText: 'GitHub' })).toHaveCount(1)
    const cachePath = join(userDataDir, 'extensions-catalog.json')
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).document.mcp.map((entry: { id: string }) => entry.id)).not.toContain('evil')

    // 装上联网目录里新加的那个（地址换成本机的假服务）
    await row.getByRole('button', { name: '安装 Acme' }).click()
    const form = row.getByRole('form', { name: '安装 Acme' })
    await form.getByLabel('Acme Token').fill(token)
    await form.getByRole('button', { name: '安装并测试' }).click()
    await expect(row).toContainText('已安装', { timeout: 30_000 })

    // 再查一次：带上 ETag，没变是 304
    await source.getByRole('button', { name: '检查更新' }).click()
    await expect.poll(() => catalog.requests().at(-1)?.status).toBe(304)
    expect(catalog.requests().at(-1)?.ifNoneMatch).toBeTruthy()
    await expect(source).toHaveAttribute('data-source', 'online')

    // 断网：用缓存的，说没连上；新加的还在、还是已安装
    catalog.setOffline(true)
    await source.getByRole('button', { name: '检查更新' }).click()
    await expect(source).toHaveAttribute('data-source', 'cache')
    await expect(source).toContainText('没连上目录服务器（连不上）')
    await expect(source).toContainText('2099-01-01 版')
    await expect(row).toContainText('已安装')
    await window.screenshot({ path: 'test-results/extensions-catalog-offline.png' })

    // 已安装页照常（连接状态和目录无关）
    await openExtensions(window, '已安装')
    await expect(view.getByTestId('mcp-server-card').filter({ hasText: 'acme' }).getByTestId('mcp-status')).toHaveText('已连接', { timeout: 30_000 })

    // 重启，还是断网：先显示缓存的目录，联网失败后说明用的是缓存
    await app.close()
    app = await launchApp(userDataDir, env)
    window = await app.firstWindow()
    await openExtensions(window, 'MCP')
    await expect(window.getByTestId('catalog-source')).toHaveAttribute('data-source', 'cache')
    await expect(window.getByTestId('extensions-view').getByTestId('catalog-mcp').filter({ hasText: 'Acme' })).toContainText('已安装')

    // 缓存坏了也不影响：退回内置目录
    await app.close()
    expect(existsSync(cachePath)).toBe(true)
    writeFileSync(cachePath, '{坏了')
    app = await launchApp(userDataDir, env)
    window = await app.firstWindow()
    await openExtensions(window, 'MCP')
    await expect(window.getByTestId('catalog-source')).toHaveAttribute('data-source', 'builtin')
    await expect(window.getByTestId('catalog-source')).toContainText('用的是内置目录')
  } finally {
    await app.close()
    await catalog.close()
    await remote.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
