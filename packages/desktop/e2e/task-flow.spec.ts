import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { cards, chooseProject, startTask, taskInput, waitTaskDone, waitTaskStatus } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { addFile, exec, read, replaceLines, startScriptedModel } from './scripted-model'

// 对话的滚动容器在每一轮外面两层；SCROLLER 给在页面里求值的脚本用
const SCROLLER = `document.querySelector('[data-testid="turn"]').parentElement.parentElement`
const conversationScroller = (window: Page) => window.getByTestId('turn').first().locator('xpath=../..')

const paragraphs = (from: number, count: number) => Array.from({ length: count }, (_, index) => `第 ${from + index} 段说明`).join('\n\n')

test('任务页：工具分组、检查、监控和审阅面板、上下文明细、排队、时间线、重新生成、撤销、权限模式', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-flow-'))
  writeFileSync(join(project, 'hello.txt'), 'hello world\n')
  const model = await startScriptedModel([
    { toolCalls: [exec('ls')] },
    { toolCalls: [read('hello.txt')] },
    {
      text: '开始改：\n\n- 把 **hello world** 改成 `hello diffra`',
      toolCalls: [replaceLines('hello.txt', 'hello world', 'hello diffra')],
    },
    { toolCalls: [addFile('greet.js', 'export const greet = () => "hi"\n')] },
    // 只回文字就是想结束这一轮：结束门禁跑完成检查，出完成卡
    { text: '改好了，新增 **greet**。' },
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
    // 首页不再有检查入口；这里只关心任务页，直接按项目设置弹窗保存时走的接口配好完成检查
    await window.evaluate(`window.diffra.saveProject(${JSON.stringify(project)}, { checks: { afterEdit: null, beforeFinish: 'echo check-ok' }, readOnlyPaths: [] })`)

    await startTask(window, '改问候语')
    await waitTaskDone(window)

    // 对话流：读文件收成一组，Markdown 渲染；改的过程中不跑检查，两次改动连着收成一个改动组，完成时跑一次检查；监控开着时完成卡片点开计数列出改动的文件
    // 回复前后各一个过程组，都收着：前一个是列文件和读文件，后一个是两次改动
    await expect(window.getByRole('button', { name: '执行工具 2 次', exact: true })).toHaveAttribute('aria-expanded', 'false')
    await expect(window.getByTestId('agent-message').first().locator('strong')).toHaveText('hello world')
    await expect(window.getByTestId('diff-view')).toHaveCount(0)
    const editGroup = window.getByRole('button', { name: /执行工具 2 次\s*· 修改 2 个文件/ })
    await expect(editGroup).toHaveAttribute('aria-expanded', 'false')
    await editGroup.click()
    await expect(window.getByRole('button', { name: '查看改动 hello.txt', exact: true })).toHaveAttribute('aria-expanded', 'false')
    await expect(window.getByRole('button', { name: '查看改动 greet.js', exact: true })).toHaveAttribute('aria-expanded', 'false')
    await window.getByRole('button', { name: '展开代码详情', exact: true }).first().click()
    await expect(cards(window, 'edit')).toHaveCount(2)
    await expect(window.getByTestId('diff-view')).toHaveCount(2)
    await expect(cards(window, 'check')).toHaveCount(1)
    await expect(cards(window, 'check').first()).toContainText('完成检查')
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
  test.setTimeout(120_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-timeline-'))
  for (let index = 0; index < 90; index++) writeFileSync(join(project, `f-${index}.txt`), `${index}\n`)
  const model = await startScriptedModel([
    // 一大段回答，第一轮的开头离底部很远
    { text: Array.from({ length: 80 }, (_, index) => `第 ${index + 1} 段说明`).join('\n\n') },
    // 第二轮每隔几十毫秒来一批更新。每步读不同的文件，不算原地打转；加上最后一步共 91 步，在默认的 100 步上限以内。
    // 每步先说一句，读文件就不收成一组：组只在有工具在跑时展开，两步之间会收起，对话高度会来回跳
    ...Array.from({ length: 90 }, (_, index) => ({ text: `读第 ${index} 个文件`, toolCalls: [read(`f-${index}.txt`)], delayMs: 20 })),
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
    // 读文件现在是起 bash 跑 cat（以前在进程里直接读）：90 步在本机十几秒，CI 的机器慢两三倍
    await waitTaskDone(window, 60_000)
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test('不跟随时下面长出新内容、没有滚动事件，也会出「回到底部」', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-grow-'))
  writeFileSync(join(project, 'notes.txt'), 'hello\n')
  const model = await startScriptedModel([
    { text: paragraphs(1, 40), toolCalls: [read('notes.txt')] },
    // 慢一点回来，期间先往上翻一点；留足时间，机器慢时也要在它回来之前翻好
    { text: paragraphs(41, 40), delayMs: 8000 },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '读一下 notes')
    await expect.poll(() => model.requests()).toBe(2)
    await expect(window.locator('[data-testid="tool-call"][data-status="completed"]')).toHaveCount(1)
    await expect(window.getByText('第 40 段说明', { exact: true })).toBeVisible()

    // 往上翻 120px：离开贴底的 80px，还在「回到底部」的 200px 以内。等滚动事件处理完，再开始数之后的滚动事件
    await window.evaluate(`(async () => {
      const scroller = ${SCROLLER}
      scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight - 120
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)
      scroller.dataset.scrolls = '0'
      scroller.addEventListener('scroll', () => { scroller.dataset.scrolls = String(Number(scroller.dataset.scrolls) + 1) })
      // 从这里到断言，测试不碰这个窗口；收到真实的滚轮、按键、点击就是外面有人动了它（本机跑 e2e 时窗口开在桌面上，
      // Windows 默认让滚轮滚动鼠标下面的非活动窗口），把对话滚回底部附近就会按设计恢复跟随，滚动计数不再作数
      for (const type of ['wheel', 'keydown', 'pointerdown']) {
        window.addEventListener(type, (event) => { if (event.isTrusted) scroller.dataset.externalInput = type }, { capture: true })
      }
    })()`)
    const toBottom = window.getByRole('button', { name: '回到底部' })
    await expect(toBottom).toBeHidden()

    await waitTaskDone(window)
    await expect(window.getByText('第 80 段说明', { exact: true })).toBeAttached()
    await expect(conversationScroller(window), '测试窗口收到了外部的滚轮、按键或点击（本机跑 e2e 时有人操作了这个窗口），结果作废，请重跑').not.toHaveAttribute('data-external-input')
    // 新内容长在视口下面，对话没有跟着滚，也没有滚动事件
    await expect(conversationScroller(window)).toHaveAttribute('data-scrolls', '0')
    await expect(toBottom).toBeVisible()
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test('开了减少动态效果：跳到某一轮、回到底部、定位失败的命令都直接到位，不走平滑滚动', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-reduced-motion-'))
  writeFileSync(join(project, 'notes.txt'), 'hello\n')
  const model = await startScriptedModel([
    { text: paragraphs(1, 80) },
    // false 在只读命令名单里，直接执行，退出码 1；后面一大段回复把它挤出视口
    {
      toolCalls: [
        exec('ls'),
        exec('false'),
        read('notes.txt'),
      ],
    },
    { text: paragraphs(81, 80) },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await window.emulateMedia({ reducedMotion: 'reduce' })
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '第一轮')
    await waitTaskDone(window)
    await taskInput(window).fill('第二轮')
    await window.keyboard.press('Control+Enter')
    await expect(window.getByTestId('turn')).toHaveCount(2)
    await waitTaskDone(window)
    expect(model.requests()).toBe(3)

    // 平滑滚动要等之后的帧才动；点击返回的同一时刻就该到位
    const firstPrompt = window.getByTestId('turn').first().getByTestId('user-message')
    await expect(firstPrompt).not.toBeInViewport()
    const jumped = await window.evaluate(`(() => {
      const scroller = ${SCROLLER}
      const target = document.querySelector('[data-testid="turn"] [data-testid="user-message"]')
      document.querySelector('nav[aria-label="对话时间线"] button[aria-label="跳到：第一轮"]').click()
      const view = scroller.getBoundingClientRect()
      const box = target.getBoundingClientRect()
      return box.top >= view.top && box.bottom <= view.bottom
    })()`)
    expect(jumped).toBe(true)

    await expect(window.getByRole('button', { name: '回到底部' })).toBeVisible()
    const distance = await window.evaluate(`(() => {
      const scroller = ${SCROLLER}
      document.querySelector('button[aria-label="回到底部"]').click()
      return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
    })()`)
    expect(distance).toBeLessThan(1)

    // 定位经过状态和 effect，给一帧
    const failed = window.locator('[data-testid="tool-call"][data-succeeded="false"]')
    await expect(failed).not.toBeInViewport()
    await expect(window.getByTestId('monitor-panel').getByRole('button', { name: '跳到失败的命令：false', exact: true })).toBeVisible()
    const located = await window.evaluate(`(async () => {
      const scroller = ${SCROLLER}
      const row = document.querySelector('[data-testid="tool-call"][data-succeeded="false"]')
      document.querySelector('[data-testid="monitor-failed-command"]').click()
      await new Promise(requestAnimationFrame)
      const view = scroller.getBoundingClientRect()
      const box = row.getBoundingClientRect()
      return box.top >= view.top && box.bottom <= view.bottom
    })()`)
    expect(located).toBe(true)
    await expect(failed.getByRole('button')).toBeFocused()
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})
