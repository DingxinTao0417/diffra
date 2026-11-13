import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { cards, chooseProject, startTask, taskInput, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

test('/compact 手动压缩未达阈值的会话，保留草稿及历史，重启后按摘要继续', async () => {
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-manual-compact-'))
  const model = await startScriptedModel([
    { text: `第一轮已记录 ${'回复细节'.repeat(1500)}`, promptTokens: 60_000, cacheReadTokens: 30_000 },
    { text: '第二轮已记录', promptTokens: 60_000, cacheReadTokens: 30_000 },
    { text: '摘要：用户希望中文答复，保留项目约束。', delayMs: 1500 },
    { text: '按摘要继续了' },
  ])
  let app = await launchApp(userDataDir)
  try {
    let window = await app.firstWindow()
    await configureCoderModel(window, { name: '压缩模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '早期需求：用中文写')
    await waitTaskDone(window)
    await taskInput(window).fill('继续，使用中文回复')
    await taskInput(window).press('Enter')
    await expect(window.getByTestId('turn')).toHaveCount(2)
    await waitTaskDone(window)
    // 上下文和缓存命中率都跟着模型返回的用量显示
    const contextUsage = window.getByTestId('context-usage')
    await expect(window.getByTestId('cache-usage')).toContainText('缓存 50%')
    const beforePercent = Number((await contextUsage.textContent())?.match(/(\d+)%/)?.[1] ?? NaN)
    expect(beforePercent).toBeGreaterThan(10)
    await taskInput(window).fill('待发送的草稿 /compact')
    const option = window.getByRole('listbox', { name: '命令和 Skill' }).getByRole('option').filter({ hasText: 'compact' })
    await expect(option).toBeVisible()
    await taskInput(window).press('Enter')
    await expect(window.getByTestId('turn')).toHaveCount(3)
    await expect(taskInput(window)).toHaveValue('待发送的草稿 ')
    await taskInput(window).fill('/compact')
    await expect(window.getByRole('listbox', { name: '命令和 Skill' }).getByRole('option').filter({ hasText: 'compact' })).toHaveCount(0)
    await expect(cards(window, 'compaction')).toContainText('已手动压缩', { timeout: 15_000 })
    await waitTaskDone(window)
    // 手动压缩后界面上的上下文百分比马上变小，不用等下一次模型调用
    await expect.poll(async () => Number((await contextUsage.textContent())?.match(/(\d+)%/)?.[1] ?? beforePercent)).toBeLessThan(beforePercent)
    await expect(window.getByTestId('cache-usage')).toContainText('缓存 50%')
    expect(model.requests()).toBe(3)
    expect(model.bodies()[2]).toContain('CONTEXT CHECKPOINT COMPACTION')
    // 写摘要时看得到模型以前的回复原文；界面上的历史不受影响
    expect(model.bodies()[2]).toContain('回复细节')
    await expect(window.getByTestId('agent-message').first()).toContainText('回复细节')
    await expect(window.getByTestId('turn').last().getByRole('button', { name: '重新生成', exact: true })).toHaveCount(0)
    await expect(window.getByTestId('turn').last().getByRole('button', { name: '撤销这一轮及之后的改动', exact: true })).toHaveCount(0)
    await app.close()
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await window.getByTestId('sidebar-task').click()
    await expect(cards(window, 'compaction')).toContainText('已手动压缩')
    await taskInput(window).fill('继续')
    await taskInput(window).press('Enter')
    await expect(window.getByTestId('agent-message').last()).toContainText('按摘要继续了')
    await waitTaskDone(window)
    // 压缩后发给模型的是用户每轮的原话和交接摘要，模型以前的回复不再发
    expect(model.bodies()[3]).toContain('摘要：用户希望中文答复')
    expect(model.bodies()[3]).not.toContain('回复细节')
    expect(model.bodies()[3]).toContain('早期需求：用中文写')
    expect(model.bodies()[3]).toContain('继续，使用中文回复')
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
