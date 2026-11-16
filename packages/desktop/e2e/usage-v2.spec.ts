import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { settingsNav } from './flows'
import { launchApp, makeUserDataDir } from './launch'

// 用量的 v2 部分（M11）：单价和费用、每月预算提醒、无项目任务合成一行、导出 CSV、清理旧记录
test('用量：填单价后显示估算费用、按模型和项目的费用；无项目任务合成一行；超过每月预算提醒一次；导出 CSV；清理旧月份', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const usageDir = join(userDataDir, 'usage')
  mkdirSync(usageDir, { recursive: true })
  const now = new Date()
  const at = new Date(now.getTime() - 3_600_000).toISOString()
  const record = (sessionId: string, cwd: string, modelId: string, input: number, output: number) =>
    JSON.stringify({ v: 1, at, sessionId, cwd, providerId: 'p1', providerName: '供应商', modelId, role: 'coder', input, cacheRead: 0, cacheWrite: 0, output, reasoning: 0 })
  const workspace = join(userDataDir, 'workspace')
  const month = at.slice(0, 7)
  writeFileSync(
    join(usageDir, `${month}.jsonl`),
    [
      record('a', join(workspace, '写周报'), 'paid-model', 1_000_000, 500_000),
      record('b', join(workspace, '查资料'), 'paid-model', 1_000_000, 0),
      record('c', 'D:\\work\\shop', 'free-model', 2_000_000, 100_000),
    ].join('\n') + '\n',
  )
  // 一个很早的月份，用来清理
  writeFileSync(join(usageDir, '2025-01.jsonl'), `${JSON.stringify({ v: 1, at: '2025-01-15T00:00:00.000Z', sessionId: 'old', cwd: 'D:\\old', providerId: 'p1', providerName: '供应商', modelId: 'paid-model', role: 'coder', input: 10, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0 })}\n`)
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await window.getByTestId('sidebar').getByRole('button', { name: '设置', exact: true }).click()
    await settingsNav(window).getByRole('button', { name: '用量' }).click()
    const summary = window.getByTestId('usage-summary')
    await expect(summary).toBeVisible()
    // 无项目任务合成一行
    await expect(window.getByTestId('usage-row').filter({ hasText: '无项目（2 个任务）' })).toHaveCount(1)
    await expect(window.getByTestId('usage-tile').filter({ hasText: '估算费用' })).toHaveCount(0)

    // 单价：paid-model 输入 2 元、输出 8 元每百万；预算 5 元
    await window.getByRole('button', { name: '单价和预算' }).click()
    const prices = window.getByTestId('usage-prices')
    await expect(prices.getByTestId('usage-price-row')).toHaveCount(2)
    await prices.getByLabel('paid-model 的输入单价').fill('2')
    await prices.getByLabel('paid-model 的输出单价').fill('8')
    await prices.getByLabel('每月预算').fill('5')
    await prices.getByRole('button', { name: '保存' }).click()
    // 2×2 + 0.5×8 = 8 元，超过预算 5 元：提醒一次
    await expect(window.getByTestId('usage-tile').filter({ hasText: '估算费用' })).toContainText('¥8.00')
    await expect(window.getByTestId('usage-tile').filter({ hasText: '估算费用' })).toContainText('1 次调用没有单价')
    await expect(window.getByText(/本月用量费用 ¥8\.00，已经超过每月预算 ¥5\.00 的 100%/)).toBeVisible()
    await expect(window.getByTestId('usage-budget')).toContainText('本月 ¥8.00 / ¥5.00')
    await expect(window.getByTestId('usage-row').filter({ hasText: '无项目（2 个任务）' })).toContainText('¥8.00')
    await expect(window.getByTestId('usage-row').filter({ hasText: 'free-model' })).toContainText('—')
    const settings = JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')) as { usage: { prices: unknown[]; monthlyBudget: string; budgetNotice: { level: number } } }
    expect(settings.usage.monthlyBudget).toBe('5')
    expect(settings.usage.budgetNotice.level).toBe(100)
    await window.screenshot({ path: 'test-results/usage-v2.png' })

    // 导出 CSV：保存对话框选好位置
    const csv = join(userDataDir, 'export.csv')
    await app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: target })) as typeof dialog.showSaveDialog
    }, csv)
    await window.getByRole('button', { name: '导出 CSV' }).click()
    await expect(window.getByText(/导出了 3 条记录/)).toBeVisible()
    const lines = readFileSync(csv, 'utf8').trim().split('\r\n')
    expect(lines).toHaveLength(4)
    expect(lines.some((line) => line.includes('paid-model') && line.endsWith(',8.000000'))).toBe(false)
    expect(lines.filter((line) => line.includes('paid-model')).map((line) => line.split(',').at(-1))).toEqual(['6.000000', '2.000000'])

    // 清理：删掉 2025-01
    await window.getByRole('button', { name: '清理旧记录' }).click()
    const cleanup = window.getByTestId('usage-cleanup')
    await cleanup.getByRole('radio', { name: `从 ${month} 起` }).click()
    await expect(cleanup.getByTestId('usage-cleanup-preview')).toContainText('会删掉 2025-01')
    await cleanup.getByRole('button', { name: '删除' }).click()
    await expect(window.getByText('删掉了 1 个月的用量记录')).toBeVisible()
    expect(existsSync(join(usageDir, '2025-01.jsonl'))).toBe(false)
    expect(existsSync(join(usageDir, `${month}.jsonl`))).toBe(true)
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
