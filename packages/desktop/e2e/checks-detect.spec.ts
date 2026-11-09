import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { cards, chooseProject, startTask, waitTaskDone, waitTaskStatus } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

test('在任务监控里自动检测检查命令，确认、试运行后保存，新任务按它们检查', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-detect-'))
  writeFileSync(join(project, 'a.txt'), 'old\n')
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({
      scripts: {
        typecheck: 'node -e "console.log(\'types-ok\')"',
        lint: 'eslint . --fix',
        test: 'node -e "process.exit(1)"',
      },
    }),
  )
  const model = await startScriptedModel([
    { text: '看过了' },
    { toolCalls: [{ name: 'read_file', input: { path: 'a.txt' } }] },
    { toolCalls: [{ name: 'edit_file', input: { path: 'a.txt', old_string: 'old', new_string: 'new' } }] },
    { toolCalls: [{ name: 'finish', input: { summary: '改好了' } }] },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)

    // 首页没有检查入口：先开一个任务，在任务监控里编辑检查命令。
    // 自动检测后每栏下面列出建议的命令、来源和脚本的实际内容，完成检查只列快速检查没列过的
    await startTask(window, '先看看')
    await waitTaskDone(window)
    await window.getByTestId('monitor-panel').getByRole('button', { name: '编辑检查命令' }).click()
    await window.getByRole('button', { name: '自动检测' }).click()
    const quickSuggestion = window.getByTestId('check-after-edit-suggestion')
    const finishSuggestion = window.getByTestId('check-before-finish-suggestion')
    await expect(quickSuggestion).toContainText('npm run typecheck')
    await expect(quickSuggestion).toContainText("console.log('types-ok')")
    await expect(finishSuggestion).toContainText('npm run typecheck && npm run test')
    await expect(finishSuggestion).toContainText('process.exit(1)')
    await expect(finishSuggestion).not.toContainText('types-ok')
    await expect(window.getByTestId('check-detection')).toContainText('脚本 lint 会改文件')
    await window.getByRole('button', { name: '填入快速检查' }).click()
    await window.getByRole('button', { name: '填入完成检查' }).click()
    await expect(window.getByLabel('快速检查', { exact: true })).toHaveValue('npm run typecheck')
    await expect(window.getByLabel('完成检查', { exact: true })).toHaveValue('npm run typecheck && npm run test')

    // 试运行：快速检查通过，完成检查里的测试失败
    const runButtons = window.getByRole('button', { name: '试运行' })
    await runButtons.nth(0).click()
    await expect(window.getByTestId('check-after-edit-result')).toContainText('通过', { timeout: 30_000 })
    await runButtons.nth(1).click()
    await expect(window.getByTestId('check-before-finish-result')).toContainText('没通过', { timeout: 30_000 })
    await window.getByTestId('check-before-finish-result').getByRole('button').click()
    await expect(window.getByTestId('check-before-finish-result')).toContainText('Exit code: 1')
    await window.screenshot({ path: 'test-results/checks-detect.png' })

    // 去掉会失败的完成检查再保存
    await window.getByLabel('完成检查', { exact: true }).fill('')
    await window.getByRole('button', { name: '保存项目设置' }).click()
    await expect(window.getByRole('dialog')).toBeHidden()

    // 改动对新任务生效
    await window.getByTestId('sidebar').getByRole('button', { name: '新任务' }).click()
    await startTask(window, '把 old 改成 new')
    await waitTaskDone(window)
    const checks = cards(window, 'check')
    await expect(checks).toHaveCount(2)
    await expect(checks.nth(0)).toContainText('快速检查')
    await expect(checks.nth(0)).toContainText('npm run typecheck')
    await expect(checks.nth(0)).toContainText('通过')
    await expect(cards(window, 'finish')).toHaveAttribute('data-status', 'completed')
    await waitTaskStatus(window, 'verified')
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})
