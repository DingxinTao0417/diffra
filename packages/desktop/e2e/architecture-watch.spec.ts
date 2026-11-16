import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { answerOpenDialog } from './flows'
import { launchApp, makeUserDataDir } from './launch'

// 架构：打开着项目时监听文件变化（v2 · M9）
test('架构监听文件变化：代码改了标过期；打开自动更新后改动停下就重新分析，开关记在项目上', async () => {
  test.setTimeout(120_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-arch-watch-'))
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'watch-me' }))
  writeFileSync(join(project, 'a.ts'), "import { b } from './b'\nexport const a = b\n")
  writeFileSync(join(project, 'b.ts'), 'export const b = 1\n')
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await window.getByTestId('sidebar').getByRole('button', { name: '架构', exact: true }).click()
    await answerOpenDialog(app, project)
    await window.getByRole('button', { name: '选择文件夹', exact: true }).click()
    const card = window.getByTestId('architecture-card')
    await expect(card).toContainText('2文件', { timeout: 60_000 })
    await card.click()
    await window.getByRole('radio', { name: '概览', exact: true }).click()
    const stale = window.getByTestId('architecture-stale')
    await expect(stale).toHaveCount(0)

    // 没开自动更新：改了代码只标过期（依赖目录里的改动不算，见 core 的 architecture-watch.test.ts）
    writeFileSync(join(project, 'b.ts'), 'export const b = 2\n')
    await expect(stale).toHaveText('代码已变，建议重新分析', { timeout: 15_000 })
    await window.getByRole('button', { name: '重新分析' }).click()
    await expect(stale).toHaveCount(0, { timeout: 30_000 })

    // 打开自动更新：新加一个文件，分析自己跑完，概览里多了一个文件
    const auto = window.getByRole('switch', { name: '代码改了自动重新分析' })
    await auto.click()
    await expect(auto).toBeChecked()
    writeFileSync(join(project, 'c.ts'), "import { a } from './a'\nexport const c = a\n")
    await expect(window.getByTestId('architecture-overview')).toContainText('深度解析了 3 个文件', { timeout: 30_000 })
    await expect(stale).toHaveCount(0)
    const projects = JSON.parse(readFileSync(join(userDataDir, 'architecture', 'projects.json'), 'utf8')) as { projects: Array<{ autoRefresh?: boolean }> }
    expect(projects.projects[0]?.autoRefresh).toBe(true)
    await window.screenshot({ path: 'test-results/architecture-watch.png' })

    // 回到卡片页再进来：开关还开着
    await window.getByRole('button', { name: '架构', exact: true }).first().click()
    await window.getByTestId('architecture-card').click()
    await expect(window.getByRole('switch', { name: '代码改了自动重新分析' })).toBeChecked()
  } finally {
    await app.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
