import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { cards, chooseProject, startTask, waitTaskDone, waitTaskStatus } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

test('在任务监控里自动检测完成检查，确认、试运行后保存，新任务完成时按它检查', async () => {
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
    // 只有一栏完成检查；自动检测后下面列出建议的命令、每条的来源和脚本的实际内容
    await startTask(window, '先看看')
    await waitTaskDone(window)
    await window.getByTestId('monitor-panel').getByRole('button', { name: '编辑检查命令' }).click()
    await expect(window.getByLabel('快速检查', { exact: true })).toHaveCount(0)
    await window.getByRole('button', { name: '自动检测' }).click()
    const suggestion = window.getByTestId('check-before-finish-suggestion')
    await expect(suggestion).toContainText('npm run typecheck && npm run test')
    await expect(suggestion).toContainText("console.log('types-ok')")
    await expect(suggestion).toContainText('process.exit(1)')
    await expect(window.getByTestId('check-detection')).toContainText('脚本 lint 会改文件')
    await window.getByRole('button', { name: '填入完成检查' }).click()
    await expect(window.getByLabel('完成检查', { exact: true })).toHaveValue('npm run typecheck && npm run test')

    // 试运行：里面的测试失败
    await window.getByRole('button', { name: '试运行' }).click()
    await expect(window.getByTestId('check-before-finish-result')).toContainText('没通过', { timeout: 30_000 })
    await window.getByTestId('check-before-finish-result').getByRole('button').click()
    await expect(window.getByTestId('check-before-finish-result')).toContainText('Exit code: 1')
    await window.screenshot({ path: 'test-results/checks-detect.png' })

    // 换成只有类型检查的命令，试运行通过后保存
    await window.getByLabel('完成检查', { exact: true }).fill('npm run typecheck')
    await window.getByRole('button', { name: '试运行' }).click()
    await expect(window.getByTestId('check-before-finish-result')).toContainText('通过', { timeout: 30_000 })
    await window.getByRole('button', { name: '保存项目设置' }).click()
    await expect(window.getByRole('dialog')).toBeHidden()

    // 改动对新任务生效：改的过程中不跑检查，完成时跑一次
    await window.getByTestId('sidebar').getByRole('button', { name: '新任务' }).click()
    await startTask(window, '把 old 改成 new')
    await waitTaskDone(window)
    const checks = cards(window, 'check')
    await expect(checks).toHaveCount(1)
    await expect(checks.nth(0)).toContainText('完成检查')
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
