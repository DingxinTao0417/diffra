import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, settingsNav, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

test('用量页：每次模型调用都记上，按范围、模型、项目、任务汇总', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-usage-'))
  writeFileSync(join(project, 'a.txt'), 'hi\n')

  // 预先写 1–3 天前（本地中午）的记录，供应商没返回用量的一条，外加一行坏数据
  const usageDir = join(userDataDir, 'usage')
  mkdirSync(usageDir)
  const now = new Date()
  const line = (daysAgo: number, input: number | null, output: number | null) => {
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 12).toISOString()
    const record = { v: 1, at, sessionId: 'old-task', cwd: project, providerId: 'old', providerName: '旧供应商', modelId: 'old-model', role: 'coder', input, cacheRead: input === null ? null : 500, cacheWrite: null, output, reasoning: null }
    writeFileSync(join(usageDir, `${at.slice(0, 7)}.jsonl`), `${JSON.stringify(record)}\n`, { flag: 'a' })
  }
  line(1, 1000, 100)
  line(2, 2000, 200)
  line(3, null, null)
  writeFileSync(join(usageDir, `${now.toISOString().slice(0, 7)}.jsonl`), '{"broken\n', { flag: 'a' })

  const model = await startScriptedModel([{ toolCalls: [{ name: 'read_file', input: { path: 'a.txt' } }] }, { text: '看完了' }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '看看 a.txt')
    await waitTaskDone(window)

    await window.keyboard.press('Control+,')
    await settingsNav(window).getByRole('button', { name: '用量' }).click()
    const tile = (label: string) => window.getByTestId('usage-tile').filter({ hasText: label })
    const row = (name: string) => window.getByTestId('usage-row').filter({ hasText: name })

    // 近 7 天：今天 2 次（每次输入 1200、输出 20）加上预先写的 3 次
    await expect(tile('模型调用')).toContainText('5 次')
    await expect(row('脚本模型 / scripted')).toContainText('2,400')
    await expect(row('旧供应商 / old-model')).toContainText('3,000')
    await expect(row('看看 a.txt')).toContainText('2,440')
    await expect(row('已删除的任务')).toHaveCount(1)
    await expect(window.getByText('有 1 次调用供应商没有返回用量')).toBeVisible()
    await expect(window.getByText('有 1 行读不了')).toBeVisible()
    const bars = window.locator('section[aria-label="每天的 token 用量"] .flex.h-36 > div')
    await expect(bars).toHaveCount(7)
    await bars.last().hover()
    await expect(window.getByRole('tooltip')).toContainText('2 次')
    await window.screenshot({ path: 'test-results/usage.png' })

    // 今天：只有本次任务的两次调用，不画只有一根柱子的图
    await window.getByRole('radiogroup', { name: '统计范围' }).getByRole('radio', { name: '今天' }).click()
    await expect(tile('模型调用')).toContainText('2 次')
    await expect(row('旧供应商 / old-model')).toHaveCount(0)
    await expect(window.locator('section[aria-label="每天的 token 用量"]')).toHaveCount(0)

    await window.getByRole('radiogroup', { name: '统计范围' }).getByRole('radio', { name: '近 30 天' }).click()
    await expect(bars).toHaveCount(30)
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})
