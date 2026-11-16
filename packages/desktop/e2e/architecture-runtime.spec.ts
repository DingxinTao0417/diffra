import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { answerOpenDialog } from './flows'
import { launchApp, makeUserDataDir } from './launch'

// 架构：运行时追踪（v2 · M9）
test('运行时追踪：默认填测试命令；跑一条 Node.js 命令后列出最花时间的函数和调用，通过变量调的标「运行时才看到」；点函数到它的文件和调用图', async () => {
  test.setTimeout(150_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-arch-runtime-'))
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'runtime-me', scripts: { test: 'node app.js' } }))
  writeFileSync(join(project, 'app.js'), "const { work } = require('./lib')\n\nfunction main() {\n  for (let i = 0; i < 40; i++) work(300000)\n}\n\nmain()\n")
  // work 通过变量调 spin：静态分析对不上，运行时看得到
  writeFileSync(join(project, 'lib.js'), 'function spin(n) {\n  let x = 0\n  for (let i = 0; i < n; i++) x += Math.sqrt(i)\n  return x\n}\n\nfunction work(n) {\n  const steps = [spin, spin, spin]\n  return steps.map((step) => step(n)).length\n}\n\nmodule.exports = { work }\n')
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await window.getByTestId('sidebar').getByRole('button', { name: '架构', exact: true }).click()
    await answerOpenDialog(app, project)
    await window.getByRole('button', { name: '选择文件夹', exact: true }).click()
    const card = window.getByTestId('architecture-card')
    await expect(card).toContainText('2文件', { timeout: 60_000 })
    await card.click()
    await window.getByRole('radio', { name: '运行时', exact: true }).click()
    const view = window.getByTestId('architecture-runtime')
    await expect(view).toContainText('还没有运行记录')
    const command = view.getByLabel('要追踪的命令')
    await expect(command).toHaveValue('npm test')

    await command.fill('node app.js')
    await view.getByRole('button', { name: '运行并追踪' }).click()
    const functions = view.getByTestId('runtime-functions')
    await expect(functions).toContainText('spin', { timeout: 60_000 })
    await expect(functions).toContainText('main')
    await expect(view.getByTestId('runtime-summary')).toContainText('Node.js')
    await expect(view.getByTestId('runtime-summary')).toContainText('跑到 2 / 2 个文件')
    const dynamic = view.getByTestId('runtime-link').filter({ hasText: /^work→spin/ })
    await expect(dynamic).toContainText('运行时才看到')
    await expect(view.getByTestId('runtime-link').filter({ hasText: /^main→work/ })).not.toContainText('运行时才看到')
    await expect(view.getByRole('button', { name: '再跑一次' })).toBeEnabled()
    await window.screenshot({ path: 'test-results/architecture-runtime.png' })

    // 点函数：到依赖页里它的文件，调用图以它为中心
    await functions.getByRole('button', { name: /^spin/ }).click()
    await expect(window.getByTestId('architecture-file').getByRole('heading', { level: 2 })).toHaveText('lib.js')
  } finally {
    await app.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
