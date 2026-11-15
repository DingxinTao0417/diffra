import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { openExtensions } from './flows'
import { APP_VERSION, launchApp, makeUserDataDir } from './launch'

test('扩展目录的官方图标能显示，深浅主题尺寸一致', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const pluginDir = join(userDataDir, 'plugins', 'superpowers')
  mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true })
  mkdirSync(join(pluginDir, 'skills', 'using-superpowers'), { recursive: true })
  writeFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'superpowers', version: '7.0.0' }))
  writeFileSync(join(pluginDir, 'skills', 'using-superpowers', 'SKILL.md'), '---\nname: using-superpowers\ndescription: 怎么用这些 Skill\n---\n先想再做')
  writeFileSync(
    join(userDataDir, 'settings.json'),
    JSON.stringify({
      version: 1,
      providers: [],
      roles: { coder: null, planner: null, reviewer: null, fallback: null },
      lastSeenVersion: APP_VERSION,
      mcpServers: [
        {
          id: 'github',
          name: 'github',
          enabled: true,
          transport: 'http',
          command: '',
          args: [],
          envNames: [],
          url: 'https://api.githubcopilot.com/mcp/',
          headerNames: ['Authorization'],
        },
      ],
      plugins: [{ id: 'superpowers', name: 'superpowers', dir: pluginDir, source: 'folder', url: null, subdir: null, enabled: true, hooksApproved: null }],
    }),
  )
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await openExtensions(window, 'MCP')
    const view = window.getByTestId('extensions-view')
    const mcpRows = view.getByTestId('catalog-mcp')
    await expect(mcpRows).toHaveCount(13)
    const icons = view.getByTestId('brand-icon')
    await expect(icons).toHaveCount(13)
    const sizes = await icons.evaluateAll((icons) =>
      icons.map((icon) => {
        const box = icon.getBoundingClientRect()
        return { width: Math.round(box.width), height: Math.round(box.height), name: icon.closest('[data-testid="catalog-mcp"]')?.textContent?.trim().slice(0, 20) }
      }),
    )
    expect(new Set(sizes.map((size) => `${size.width}x${size.height}`)).size).toBe(1)
    expect(sizes[0]?.width).toBeGreaterThanOrEqual(18)
    expect(sizes[0]?.width).toBeLessThanOrEqual(24)
    await window.screenshot({ path: 'test-results/extension-icons-mcp-light.png' })

    await openExtensions(window, '插件')
    const pluginRows = view.getByTestId('catalog-plugin')
    await expect(pluginRows).toHaveCount(10)
    await expect(view.getByTestId('brand-icon')).toHaveCount(5)
    await expect(pluginRows.filter({ hasText: 'Superpowers' }).getByTestId('brand-icon')).toHaveCount(1)
    await expect(pluginRows.filter({ hasText: 'Feature Dev' }).getByTestId('brand-icon')).toHaveCount(0)
    await window.screenshot({ path: 'test-results/extension-icons-plugins-light.png' })

    await window.emulateMedia({ colorScheme: 'dark' })
    await window.screenshot({ path: 'test-results/extension-icons-plugins-dark.png' })
    await openExtensions(window, 'MCP')
    await window.screenshot({ path: 'test-results/extension-icons-mcp-dark.png' })

    await openExtensions(window, '已安装')
    await expect(view.getByTestId('brand-icon')).toHaveCount(2)
    await window.screenshot({ path: 'test-results/extension-icons-installed-dark.png' })
  } finally {
    await app.close()
  }
})
