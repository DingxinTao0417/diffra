import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { answerOpenDialog } from './flows'
import { launchApp, makeUserDataDir } from './launch'

// 架构定义放进仓库、和团队共享（v2 · M9）：一台电脑导出到 .diffra/，另一台打开同一个项目时提示、导入
async function openProject(app: ElectronApplication, window: Page, project: string): Promise<void> {
  await window.getByTestId('sidebar').getByRole('button', { name: '架构', exact: true }).click()
  await answerOpenDialog(app, project)
  await window.getByRole('button', { name: '选择文件夹', exact: true }).click()
  const card = window.getByTestId('architecture-card')
  await expect(card).toContainText('2文件', { timeout: 60_000 })
  await card.click()
}

test('架构定义导出到仓库：确认后写 .diffra/ 下的 JSON 和 Markdown；同事打开同一个项目看到仓库里的不一样，用仓库里的后目标架构也过来了', async () => {
  test.setTimeout(150_000)
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-arch-share-'))
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'shared-shop' }))
  writeFileSync(join(project, 'a.ts'), "import { b } from './b'\nexport const a = b\n")
  writeFileSync(join(project, 'b.ts'), 'export const b = 1\n')
  const mine = makeUserDataDir()
  const theirs = makeUserDataDir()
  let app = await launchApp(mine)
  try {
    let window = await app.firstWindow()
    await openProject(app, window, project)
    // 先有一份目标架构，再导出
    await window.getByRole('radio', { name: '目标架构', exact: true }).click()
    await window.getByRole('button', { name: /从应用架构图复制/ }).click()
    await expect(window.getByTestId('architecture-target')).toContainText('没有违规')
    await window.getByRole('button', { name: '更多操作', exact: true }).click()
    await window.getByRole('menuitem', { name: '导出到仓库（.diffra/）…' }).click()
    const dialog = window.getByRole('alertdialog')
    await expect(dialog).toContainText('.diffra/architecture.json')
    await dialog.getByRole('button', { name: '导出' }).click()
    await expect(window.getByText(/已导出到 \.diffra\/architecture\.json/)).toBeVisible()
    const shared = JSON.parse(readFileSync(join(project, '.diffra', 'architecture.json'), 'utf8')) as { format: string; target: unknown }
    expect(shared.format).toBe('diffra-architecture')
    expect(shared.target).not.toBeNull()
    expect(readFileSync(join(project, '.diffra', 'architecture.md'), 'utf8')).toContain('```mermaid')
    // 和本机的一样：不提示
    await expect(window.getByTestId('architecture-shared')).toHaveCount(0)
    await app.close()

    // 同事的电脑：同一个项目，自己分析出来的没有目标架构
    app = await launchApp(theirs)
    window = await app.firstWindow()
    await openProject(app, window, project)
    const banner = window.getByTestId('architecture-shared')
    await expect(banner).toContainText('仓库里有共享的架构定义')
    await expect(banner).toContainText('含目标架构')
    await window.screenshot({ path: 'test-results/architecture-share.png' })
    await banner.getByRole('button', { name: '用仓库里的' }).click()
    await window.getByRole('alertdialog').getByRole('button', { name: '用仓库里的' }).click()
    await expect(window.getByText('已换成仓库里的架构定义，本机原来的留了备份')).toBeVisible()
    await expect(banner).toHaveCount(0)
    await window.getByRole('radio', { name: '目标架构', exact: true }).click()
    await expect(window.getByTestId('architecture-target')).toContainText('没有违规')
    expect(existsSync(join(theirs, 'architecture'))).toBe(true)
  } finally {
    await app.close().catch(() => {})
    rmSync(project, { recursive: true, force: true })
    rmSync(mine, { recursive: true, force: true })
    rmSync(theirs, { recursive: true, force: true })
  }
})
