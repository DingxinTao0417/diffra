import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { answerOpenDialog, settingsNav } from './flows'
import { launchApp, makeUserDataDir } from './launch'

// 在桌面端里看评测结果（v2 · M11）
const task = (id: string, passed: boolean, extra: Record<string, unknown> = {}) => ({ id, category: 'feature', model: 'flash', passed, durationMs: 60_000, usage: { inputTokens: 9000, outputTokens: 1000, cost: '0.020000' }, ...extra })

test('评测结果：打开 results.json 看通过率区间、费用、按难度和每道题；再选一份旧结果按题比较', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const dir = mkdtempSync(join(tmpdir(), 'diffra-e2e-eval-'))
  const ids = ['t1', 't2', 't3', 't4', 't5', 't6']
  const newer = join(dir, 'new.json')
  const older = join(dir, 'old.json')
  writeFileSync(newer, JSON.stringify({ startedAt: '2026-11-15T08:00:00.000Z', tasks: ids.flatMap((id) => [task(id, true, { difficulty: id === 't1' ? 'hard' : null }), task(id, id !== 't6', { difficulty: id === 't1' ? 'hard' : null })]) }))
  writeFileSync(older, JSON.stringify({ tasks: ids.flatMap((id) => [task(id, false), task(id, id === 't1')]) }))
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await window.getByTestId('sidebar').getByRole('button', { name: '设置', exact: true }).click()
    await settingsNav(window).getByRole('button', { name: '评测结果' }).click()
    await answerOpenDialog(app, newer)
    await window.getByRole('button', { name: '打开 results.json' }).click()
    const model = window.getByTestId('eval-model')
    await expect(model).toContainText('通过 11/12（92%，95% 区间')
    await expect(model).toContainText('费用 0.240000')
    await expect(model.getByTestId('eval-difficulty')).toContainText('按实际难度：易 10/10，中 1/2；按标的难度：难 2/2')
    await expect(window.getByTestId('eval-task')).toHaveCount(6)
    await expect(window.getByTestId('eval-task').filter({ hasText: 't1' })).toContainText('（标的难）')

    await answerOpenDialog(app, older)
    await window.getByRole('button', { name: '和另一份比较' }).click()
    const compare = window.getByTestId('eval-compare')
    await expect(compare).toContainText('新的更好')
    await expect(compare).toContainText('6 道题：A 8% → B 92%')
    await expect(compare).toContainText('p = 0.0313')
    await window.screenshot({ path: 'test-results/eval-results.png' })
  } finally {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
