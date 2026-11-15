import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, taskInput, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

const fence = '```'
const chart = (title: string, values: number[]) => [`${fence}chart`, JSON.stringify({ type: 'bar', title, unit: 's', data: values.map((value, index) => ({ label: `第${index + 1}步`, value })) }), fence].join('\n')

// 第 677 步：回答里的图表、表格和过程卡片也能固定到白板，不同轮次的放在一起对比
test('白板：两轮的图表固定上去并排对比、标出来自第几轮，富块照样能交互；按钮变成「从白板取下」；过程卡片固定的是当时的样子', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-board-'))
  const model = await startScriptedModel([{ text: ['优化前：', '', chart('优化前耗时', [30, 45])].join('\n') }, { text: ['优化后：', '', chart('优化后耗时', [12, 20])].join('\n') }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '量一下耗时')
    await waitTaskDone(window)
    await taskInput(window).fill('优化以后再量')
    await window.keyboard.press('Control+Enter')
    await expect(window.getByTestId('turn')).toHaveCount(2)
    await waitTaskDone(window)

    const charts = window.getByTestId('chart-block')
    await expect(charts).toHaveCount(2)
    await charts.nth(0).getByRole('button', { name: '固定到白板' }).click()
    const board = window.getByTestId('visuals-panel')
    await expect(board).toBeVisible()
    await charts.nth(1).getByRole('button', { name: '固定到白板' }).click()
    // 已经固定的块按钮变成「从白板取下」
    await expect(charts.nth(0).getByRole('button', { name: '从白板取下' })).toBeVisible()

    const items = board.getByTestId('pinned-visual')
    await expect(items).toHaveCount(2)
    await expect(items.nth(0)).toContainText('第 1 轮')
    await expect(items.nth(1)).toContainText('第 2 轮')
    // 白板里的图表是重新画的：有图，也能切到表格看数字
    await expect(items.nth(0).getByTestId('chart-canvas').locator('svg')).toHaveCount(1)
    await expect(items.nth(1)).toContainText('优化后耗时')
    await board.screenshot({ path: 'test-results/whiteboard-blocks.png' })

    // 在对话里取下：白板里也没了
    await charts.nth(0).getByRole('button', { name: '从白板取下' }).click()
    await expect(items).toHaveCount(1)

    // 过程卡片：本轮报告固定的是当时的样子，里面没有按钮
    await window.getByTestId('turn-actions').last().getByRole('button', { name: '本轮报告' }).click()
    await window.getByTestId('turn').last().getByRole('button', { name: '固定到白板' }).last().click()
    await expect(items).toHaveCount(2)
    const card = board.locator('[data-testid="pinned-visual"][data-kind="card"]')
    await expect(card).toContainText('第 2 轮')
    await expect(card).toContainText('本轮报告')
    await expect(card.locator('section button')).toHaveCount(0)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
