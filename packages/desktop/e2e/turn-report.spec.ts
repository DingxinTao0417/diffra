import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, taskInput, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { addFile, exec, startScriptedModel } from './scripted-model'

const TEST_LOG = [' FAIL  src/math.test.ts > adds', '      Tests  1 failed | 4 passed (5)', '   Duration  0.80s'].join('\n')

// 第 661 步：每轮报告（改了什么、验证了什么、风险、下一步，能复制和导出）；时间线悬停写这一轮改了什么、结论是什么
test('本轮报告：按记录列出改动、检查、测试和风险，能复制成 Markdown；时间线悬停显示这一轮的改动和结论', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-turn-report-'))
  writeFileSync(join(project, 'test.log'), TEST_LOG)
  const model = await startScriptedModel([
    { toolCalls: [addFile('src/math.ts', 'export const add = (a: number, b: number) => a + b')] },
    { toolCalls: [exec('cat test.log')] },
    { text: '加了 add，测试还有一个没过' },
    { text: '第二轮只是回答' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '加一个 add 函数')
    await expect(window.getByTestId('agent-message').last()).toContainText('测试还有一个没过', { timeout: 30_000 })
    await expect(window.getByTestId('task-status')).not.toHaveAttribute('data-tone', 'running', { timeout: 30_000 })

    const first = window.getByTestId('turn').first()
    await first.hover()
    await first.getByTestId('turn-actions').getByRole('button', { name: '本轮报告' }).click()
    const report = first.getByTestId('turn-report')
    await expect(report).toContainText('加一个 add 函数')
    await expect(report.getByTestId('turn-report-files')).toContainText('src/math.ts')
    await expect(report.getByTestId('turn-report-checks')).toContainText('跑了 1 条命令')
    await expect(report.getByTestId('turn-report-checks')).toContainText('通过 4')
    await expect(report.getByTestId('turn-report-risks')).toContainText('有 1 个失败')
    await expect(report).toContainText('修好没通过的检查和测试')
    await report.getByRole('button', { name: '复制报告' }).click()
    await expect.poll(async () => (await app.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, '\n')).toMatch(/^# 本轮报告\n\n## 要求\n\n加一个 add 函数/)
    for (const scheme of ['light', 'dark'] as const) {
      await window.emulateMedia({ colorScheme: scheme })
      await report.screenshot({ path: `test-results/turn-report-${scheme}.png` })
    }
    await window.emulateMedia({ colorScheme: 'light' })

    // 第二轮之后有时间线：悬停第一轮写着改了一个文件
    await taskInput(window).fill('还有别的吗')
    await window.getByRole('button', { name: '发送', exact: true }).click()
    await expect(window.getByTestId('agent-message').last()).toContainText('第二轮只是回答', { timeout: 30_000 })
    await window.getByRole('navigation', { name: '对话时间线' }).getByRole('button').first().hover()
    await expect(window.getByTestId('timeline-tooltip')).toContainText('1 个文件 +1')
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})
