import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { cards, chooseProject, settingsNav, startTask, waitTaskDone, waitTaskStatus } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { type ScriptStep, startScriptedModel } from './scripted-model'

// 搜六次，第六次报 11 万输入 token：没配窗口的模型按 12.8 万算，约 86%
const searches = (round: string): ScriptStep[] =>
  Array.from({ length: 6 }, (_, index) => ({
    toolCalls: [{ name: 'search', input: { pattern: `${round}-${index}` } }],
    promptTokens: index === 5 ? 110_000 : 1200,
  }))

async function openExecutionSettings(window: Page) {
  await window.keyboard.press('Control+,')
  await settingsNav(window).getByRole('button', { name: '任务执行' }).click()
}

const executionSettings = (userDataDir: string) => JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')).execution

test('任务执行设置：触发点 90% 时不压缩；改成 70% 后新任务压缩成摘要接着做，卡片能展开看摘要', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-execution-'))
  const model = await startScriptedModel([
    ...searches('first'),
    { text: '第一轮查完了' },
    ...searches('second'),
    // 写摘要的请求
    { text: '用户要找 TODO；搜了六种写法都没找到。' },
    { text: '第二轮查完了' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })

    // 默认 70%、100 步；改成 90%、无上限会存下来
    await openExecutionSettings(window)
    const compactAt = window.getByRole('radiogroup', { name: '上下文压缩' })
    const maxSteps = window.getByRole('radiogroup', { name: '单次任务步数上限' })
    await expect(compactAt.getByRole('radio', { name: '70%' })).toHaveAttribute('aria-checked', 'true')
    await expect(maxSteps.getByRole('radio', { name: '100 步' })).toHaveAttribute('aria-checked', 'true')
    await compactAt.getByRole('radio', { name: '90%' }).click()
    await maxSteps.getByRole('radio', { name: '无上限' }).click()
    await expect(maxSteps.getByRole('radio', { name: '无上限' })).toHaveAttribute('aria-checked', 'true')
    await expect.poll(() => executionSettings(userDataDir)).toEqual({ compactAtPercent: 90, maxSteps: null, goalMaxRounds: 5 })
    await window.screenshot({ path: 'test-results/execution-settings.png' })
    await window.getByRole('button', { name: '返回' }).click()

    await chooseProject(app, window, project)
    await startTask(window, '找一找 TODO 在哪')
    await waitTaskDone(window)
    await expect(window.getByTestId('agent-message').last()).toContainText('第一轮查完了')
    await expect(cards(window, 'compaction')).toHaveCount(0)

    // 改回 70%：新任务按新设置运行
    await openExecutionSettings(window)
    await compactAt.getByRole('radio', { name: '70%' }).click()
    await expect.poll(() => executionSettings(userDataDir)).toEqual({ compactAtPercent: 70, maxSteps: null, goalMaxRounds: 5 })
    await window.getByRole('button', { name: '返回' }).click()
    await window.getByTestId('sidebar').getByRole('button', { name: '新任务' }).click()
    await startTask(window, '再找一找 TODO')
    await waitTaskDone(window)
    await expect(window.getByTestId('agent-message').last()).toContainText('第二轮查完了')

    const card = cards(window, 'compaction')
    await expect(card).toHaveCount(1)
    await expect(card).toHaveAttribute('data-status', 'completed')
    await expect(card).toContainText('较早的对话压缩成了下面的摘要')
    await expect(card).not.toContainText('搜了六种写法都没找到')
    await card.getByRole('button').click()
    await expect(card).toContainText('用户要找 TODO；搜了六种写法都没找到。')
    await window.screenshot({ path: 'test-results/compaction-card.png' })
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('智能体反复做同样的操作：先提醒，再重复就停下并说明', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-stuck-'))
  const same: ScriptStep = { toolCalls: [{ name: 'search', input: { pattern: 'TODO' } }] }
  const model = await startScriptedModel([same, same, same, same, same, same, { text: '不会走到这里' }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '找 TODO')
    await waitTaskStatus(window, 'stopped')

    const notice = window.getByTestId('notice').filter({ hasText: '智能体在重复同样的操作，已停止' })
    await expect(notice).toBeVisible()
    await expect(notice).toContainText('search {"pattern":"TODO"}')
    expect(model.requests()).toBe(6)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
