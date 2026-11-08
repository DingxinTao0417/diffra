import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { cards, chooseProject, startTask, taskInput, waitTaskDone, waitTaskStatus } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

test('任务页：工具分组、检查、监控和审阅面板、上下文明细、排队、时间线、重新生成、撤销、权限模式', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-flow-'))
  writeFileSync(join(project, 'hello.txt'), 'hello world\n')
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'list_files', input: { path: '.' } }] },
    { toolCalls: [{ name: 'read_file', input: { path: 'hello.txt' } }] },
    {
      text: '开始改：\n\n- 把 **hello world** 改成 `hello diffra`',
      toolCalls: [{ name: 'edit_file', input: { path: 'hello.txt', old_string: 'hello world', new_string: 'hello diffra' } }],
    },
    { toolCalls: [{ name: 'edit_file', input: { path: 'greet.js', old_string: '', new_string: 'export const greet = () => "hi"\n' } }] },
    { toolCalls: [{ name: 'finish', input: { summary: '改好了，新增 **greet**。' } }] },
    // 第二轮慢一点，期间发的消息排队
    { text: '第二轮的回答', delayMs: 2500 },
    { text: '排队消息的回答' },
    { text: '重新生成的回答' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await window.getByRole('button', { name: '未配置检查' }).click()
    await window.getByLabel('快速检查', { exact: true }).fill('echo check-ok')
    await window.getByRole('button', { name: '保存项目设置' }).click()
    await expect(window.getByRole('button', { name: '检查：echo check-ok' })).toBeVisible()

    await startTask(window, '改问候语')
    await waitTaskDone(window)

    // 对话流：读文件收成一组，Markdown 渲染，两张改动卡片，每次改动后跑了快速检查，监控开着时完成卡片点开计数列出改动的文件
    await expect(window.getByRole('button', { name: '执行工具 2 次' })).toBeVisible()
    await expect(window.getByTestId('agent-message').locator('strong')).toHaveText('hello world')
    await expect(window.getByTestId('diff-view')).toHaveCount(0)
    await expect(window.getByRole('button', { name: '查看改动 hello.txt', exact: true })).toHaveAttribute('aria-expanded', 'false')
    await expect(window.getByRole('button', { name: '查看改动 greet.js', exact: true })).toHaveAttribute('aria-expanded', 'false')
    await window.getByRole('button', { name: '展开代码详情', exact: true }).click()
    await expect(cards(window, 'edit')).toHaveCount(2)
    await expect(window.getByTestId('diff-view')).toHaveCount(2)
    await expect(cards(window, 'check')).toHaveCount(3)
    await expect(cards(window, 'check').first()).toContainText('通过')
    await cards(window, 'finish').getByTestId('finish-counts').click()
    await expect(cards(window, 'finish').getByText('greet.js')).toBeVisible()

    // 任务监控和审阅面板列出两个改动文件
    await expect(window.getByTestId('monitor-file')).toHaveCount(2)
    await window.locator('header').getByRole('button', { name: '审阅改动', exact: true }).click()
    await expect(window.getByTestId('review-file')).toHaveCount(2)
    await expect(window.getByTestId('review-file').filter({ hasText: 'greet.js' })).toContainText('新文件')
    await window.getByRole('button', { name: '任务监控' }).click()

    // 上下文明细
    await window.getByTestId('context-usage').click()
    await expect(window.getByText('对话和工具结果')).toBeVisible()
    await expect(window.getByText('系统提示词')).toBeVisible()
    await window.keyboard.press('Escape')

    // 运行中发的消息排队，这一轮结束后自动发出；排队的可以撤回
    await taskInput(window).fill('第二轮')
    await window.keyboard.press('Control+Enter')
    await expect(window.getByRole('button', { name: '停止' })).toBeVisible()
    await taskInput(window).fill('会被撤回的消息')
    await window.getByRole('button', { name: '排队发送' }).click()
    await taskInput(window).fill('排队的消息')
    await window.getByRole('button', { name: '排队发送' }).click()
    await expect(window.getByTestId('queued-message')).toHaveCount(2)
    await window.getByTestId('queued-message').filter({ hasText: '会被撤回的消息' }).getByRole('button', { name: '撤回' }).click()
    await expect(window.getByTestId('queued-message')).toHaveCount(1)
    await expect(window.getByText('排队消息的回答')).toBeVisible({ timeout: 15_000 })
    await waitTaskDone(window)
    await expect(window.getByTestId('turn')).toHaveCount(3)
    await expect(window.getByText('会被撤回的消息')).toHaveCount(0)
    await expect(window.getByRole('navigation', { name: '对话时间线' }).getByRole('button')).toHaveCount(3)

    // 重新生成最后一轮
    await window.getByTestId('turn').last().getByRole('button', { name: '重新生成' }).click()
    await expect(window.getByText('重新生成的回答')).toBeVisible({ timeout: 15_000 })
    await expect(window.getByText('排队消息的回答')).toHaveCount(0)
    await expect(window.getByTestId('turn')).toHaveCount(3)
    expect(model.requests()).toBe(8)

    // 撤销到第一轮之前：文件恢复，新建的文件删掉
    await window.getByTestId('turn').first().getByRole('button', { name: '撤销改动', exact: true }).click()
    await expect(window.getByTestId('restore-list')).toContainText('greet.js')
    await expect(window.getByTestId('restore-confirm')).toHaveText('撤销 2 个文件')
    await window.getByTestId('restore-confirm').click()
    await expect(window.getByTestId('notice').filter({ hasText: '已撤销 2 个文件的改动' })).toBeVisible()
    await waitTaskStatus(window, 'unfinished')
    expect(readFileSync(join(project, 'hello.txt'), 'utf8')).toBe('hello world\n')
    expect(existsSync(join(project, 'greet.js'))).toBe(false)
    await expect(window.getByTestId('monitor-panel')).toContainText('还没有改动文件')

    // 任务里换权限模式，同时记成新任务的默认值
    await window.getByTestId('permission-mode').click()
    await window.getByRole('menuitemradio', { name: /自动审批/ }).click()
    await expect(window.getByTestId('permission-mode')).toContainText('自动审批')
    await window.screenshot({ path: 'test-results/task-flow.png' })
    await window.getByTestId('sidebar').getByRole('button', { name: '新任务' }).click()
    await expect(window.getByTestId('permission-mode')).toContainText('自动审批')
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test('流式输出时点时间线跳到前面一轮，不会被贴底拉回底部', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-timeline-'))
  for (let index = 0; index < 90; index++) writeFileSync(join(project, `f-${index}.txt`), `${index}\n`)
  const model = await startScriptedModel([
    // 一大段回答，第一轮的开头离底部很远
    { text: Array.from({ length: 80 }, (_, index) => `第 ${index + 1} 段说明`).join('\n\n') },
    // 第二轮每隔几十毫秒来一批更新。每步读不同的文件，不算原地打转；加上最后一步共 91 步，在默认的 100 步上限以内。
    // 每步先说一句，读文件就不收成一组：组只在有工具在跑时展开，两步之间会收起，对话高度会来回跳
    ...Array.from({ length: 90 }, (_, index) => ({ text: `读第 ${index} 个文件`, toolCalls: [{ name: 'read_file', input: { path: `f-${index}.txt` } }], delayMs: 20 })),
    { text: '都读完了' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '第一轮')
    await waitTaskDone(window)

    await taskInput(window).fill('第二轮')
    await window.keyboard.press('Control+Enter')
    // 第二轮已经在持续更新，对话贴着底部
    await expect.poll(() => model.requests()).toBeGreaterThan(3)
    const firstPrompt = window.getByTestId('turn').first().getByTestId('user-message')
    await expect(firstPrompt).not.toBeInViewport()
    await window.getByRole('navigation', { name: '对话时间线' }).getByRole('button', { name: '跳到：第一轮', exact: true }).click()
    const jumpedAt = model.requests()
    await expect(firstPrompt).toBeInViewport()
    // 跳过去之后又来了几批更新，仍停在第一轮
    await expect.poll(() => model.requests()).toBeGreaterThan(jumpedAt + 5)
    await expect(firstPrompt).toBeInViewport()
    await expect(window.getByRole('button', { name: '回到底部' })).toBeVisible()
    await waitTaskDone(window)
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})
