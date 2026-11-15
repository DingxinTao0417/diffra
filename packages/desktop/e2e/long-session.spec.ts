import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { SessionStore } from '../../core/src/session/store.ts'
import { chooseProject } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

const TURNS = 150
const fence = '```'

// 每一轮的回答：一段代码、一张表，长任务里常见的样子
const answer = (index: number) =>
  [
    `第 ${index + 1} 轮改好了。`,
    '',
    `${fence}ts`,
    ...Array.from({ length: 30 }, (_, line) => `export const value${index}_${line} = compute(${line}, '第 ${index + 1} 轮')`),
    fence,
    '',
    '| 文件 | 改动 |',
    '| --- | ---: |',
    ...Array.from({ length: 8 }, (_, row) => `| src/module-${row}.ts | +${row * 3} |`),
  ].join('\n')

// 启动前直接写一个很长的会话记录（和 core 存盘同一份代码），不用一轮轮跑模型
async function seedLongSession(userDataDir: string, project: string): Promise<void> {
  const start = Date.parse('2026-11-01T08:00:00.000Z')
  const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString()
  await new SessionStore(join(userDataDir, 'sessions')).save({
    version: 1,
    id: randomUUID(),
    cwd: project,
    title: '很长的任务',
    createdAt: at(0),
    updatedAt: at(TURNS),
    archived: false,
    turns: Array.from({ length: TURNS }, (_, index) => ({
      id: `turn-${index + 1}`,
      kind: 'prompt' as const,
      prompt: `第 ${index + 1} 轮的问题`,
      startedAt: at(index),
      endedAt: at(index + 0.5),
      stopReason: 'end_turn' as const,
      updates: [{ sessionUpdate: 'agent_message_chunk' as const, content: { type: 'text' as const, text: answer(index) } }],
      skills: [],
      images: [],
      checkpoint: null,
      messageStart: null,
    })),
    messages: [],
    compaction: null,
  })
}

// 屏幕外被跳过渲染的轮次有几轮（content-visibility 跳过的内容 checkVisibility 返回 false）
const skippedTurns = (window: Page) =>
  window.evaluate(`[...document.querySelectorAll('[data-testid="turn"]')].filter((turn) => { const text = turn.querySelector('.markdown'); return text && !text.checkVisibility({ contentVisibilityAuto: true }) }).length`)

async function setWidth(app: ElectronApplication, width: number) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size, 820), width)
}

// 第 672 步：长会话按需渲染（不在视口附近的轮次跳过排版和绘制）和性能预算
test('长会话：150 轮打开、滚到最早一轮、改窗口宽度都在预算内；屏幕外的轮次不画，滚过去才画；页面里的文字照样找得到', async () => {
  test.setTimeout(120_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-long-'))
  await seedLongSession(userDataDir, project)
  const model = await startScriptedModel([])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    const opened = Date.now()
    await window.getByTestId('sidebar').getByRole('button', { name: '很长的任务' }).click()
    await expect(window.getByTestId('turn')).toHaveCount(TURNS, { timeout: 30_000 })
    await expect(window.getByTestId('turn').last()).toContainText(`第 ${TURNS} 轮改好了`)
    const openMs = Date.now() - opened
    console.log(`长会话 ${TURNS} 轮：打开 ${openMs}ms`)

    // 停在底部：前面的轮次大多没画
    const skipped = (await skippedTurns(window)) as number
    expect(skipped).toBeGreaterThan(TURNS - 20)

    // 滚到最早一轮：画出来了，看得到它的代码
    const first = window.getByTestId('turn').first()
    const scrolled = Date.now()
    await first.scrollIntoViewIfNeeded()
    await expect(first.locator('[data-testid="code-block"]')).toBeVisible()
    await expect.poll(() => first.locator('.markdown').evaluate((text) => (text as unknown as { checkVisibility(options: object): boolean }).checkVisibility({ contentVisibilityAuto: true }))).toBe(true)
    const scrollMs = Date.now() - scrolled

    // 改窗口宽度：重新排版的时间
    const resized = await window.evaluate(`new Promise((resolve) => { const started = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - started))) })`)
    await setWidth(app, 900)
    const relayoutMs = (await window.evaluate(`(() => { const started = performance.now(); document.body.getBoundingClientRect(); document.querySelector('[data-testid="turn"]').parentElement.scrollHeight; return performance.now() - started })()`)) as number
    await setWidth(app, 1200)

    // 没画的轮次里的字照样在 DOM 里（复制、定位、页面内搜索用得到）
    expect(await window.evaluate(`document.body.textContent.includes('第 75 轮改好了')`)).toBe(true)

    console.log(`长会话 ${TURNS} 轮：打开 ${openMs}ms，滚到最早一轮 ${scrollMs}ms，改宽度重排 ${Math.round(relayoutMs)}ms，两帧 ${Math.round(resized as number)}ms`)
    expect(openMs).toBeLessThan(8_000)
    expect(scrollMs).toBeLessThan(3_000)
    expect(relayoutMs).toBeLessThan(500)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

// 第 675 步：回答内搜索
test('回答内搜索：Ctrl+F 在长对话里找字，能跳到屏幕外没画的轮次；回车、Shift+回车上下跳；太多时写 1000+；Esc 关掉、高亮清掉', async () => {
  test.setTimeout(120_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-long-search-'))
  await seedLongSession(userDataDir, project)
  const model = await startScriptedModel([])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await window.getByTestId('sidebar').getByRole('button', { name: '很长的任务' }).click()
    await expect(window.getByTestId('turn')).toHaveCount(TURNS, { timeout: 30_000 })

    await window.keyboard.press('Control+f')
    const bar = window.getByTestId('conversation-search')
    const input = bar.getByLabel('在对话里搜索')
    const count = bar.getByTestId('conversation-search-count')
    await expect(input).toBeFocused()
    // 第 3 轮在最上面，停在底部时它没画
    await input.fill('第 3 轮改好了')
    await expect(count).toHaveText('1/1')
    await expect(window.getByTestId('turn').nth(2).getByText('第 3 轮改好了')).toBeInViewport()
    expect(await window.evaluate(`CSS.highlights.has('diffra-search-current')`)).toBe(true)
    await bar.screenshot({ path: 'test-results/conversation-search.png' })
    await window.getByTestId('turn').nth(2).locator('.markdown p').first().screenshot({ path: 'test-results/conversation-search-hit.png' })

    await input.fill('改好了')
    await expect(count).toHaveText(`1/${TURNS}`)
    await input.press('Enter')
    await expect(count).toHaveText(`2/${TURNS}`)
    await input.press('Shift+Enter')
    await input.press('Shift+Enter')
    await expect(count).toHaveText(`${TURNS}/${TURNS}`)
    await expect(window.getByTestId('turn').last().getByText(`第 ${TURNS} 轮改好了`)).toBeInViewport()

    await input.fill('compute(')
    await expect(count).toHaveText('1/1000+')
    await input.fill('没有这个词')
    await expect(count).toHaveText('没有找到')
    await input.press('Escape')
    await expect(bar).toHaveCount(0)
    expect(await window.evaluate(`CSS.highlights.has('diffra-search') || CSS.highlights.has('diffra-search-current')`)).toBe(false)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
