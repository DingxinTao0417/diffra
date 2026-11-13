import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { cards, chooseProject, settingsNav, startTask, taskInput, waitTaskDone, waitTaskStatus } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { addFile, exec, read, replaceLines, type ScriptStep, startScriptedModel } from './scripted-model'

// 搜六次，第六次报 11 万输入 token：没配窗口的模型按 12.8 万算，约 86%
const searches = (round: string): ScriptStep[] =>
  Array.from({ length: 6 }, (_, index) => ({
    toolCalls: [exec(`grep -rn "${round}-${index}" .`)],
    promptTokens: index === 5 ? 110_000 : 1200,
  }))

async function openExecutionSettings(window: Page) {
  await window.keyboard.press('ControlOrMeta+,')
  await settingsNav(window).getByRole('button', { name: '任务执行' }).click()
}

const executionSettings = (userDataDir: string) => JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')).execution

// 每次结果都一样的失败调用：改一个不存在的文件
const stuckPatch: ScriptStep = { toolCalls: [replaceLines('missing.txt', 'TODO', 'DONE')] }

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
    await expect.poll(() => executionSettings(userDataDir)).toEqual({ compactAtPercent: 90, maxSteps: null, goalMaxRounds: 5, autoMemory: false })
    await expect(window.getByRole('status').filter({ hasText: '已保存' })).toHaveText('已保存，新任务生效')
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
    await expect.poll(() => executionSettings(userDataDir)).toEqual({ compactAtPercent: 70, maxSteps: null, goalMaxRounds: 5, autoMemory: false })
    await window.getByRole('button', { name: '返回' }).click()
    await window.getByTestId('sidebar').getByRole('button', { name: '新任务' }).click()
    await startTask(window, '再找一找 TODO')
    await waitTaskDone(window)
    await expect(window.getByTestId('agent-message').last()).toContainText('第二轮查完了')

    const card = cards(window, 'compaction')
    await expect(card).toHaveCount(1)
    await expect(card).toHaveAttribute('data-status', 'completed')
    await expect(card).toContainText('之前的对话压缩成了下面的交接摘要')
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
  // 同一条命令、同样的输出（结果里的 Wall time 每次不同，不该让它们算成不同的结果）
  const same: ScriptStep = { toolCalls: [exec('ls')] }
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
    await expect(notice).toContainText('exec_command {"cmd":"ls"}')
    expect(model.requests()).toBe(6)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('改了文件后卡住停下，撤销这一轮：结论改成未完成，重启后仍是未完成', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-stuck-restore-'))
  writeFileSync(join(project, 'hello.txt'), 'hello world\n')
  const model = await startScriptedModel([
    { toolCalls: [read('hello.txt')] },
    { toolCalls: [replaceLines('hello.txt', 'hello world', 'hello diffra')] },
    stuckPatch,
    stuckPatch,
    stuckPatch,
    stuckPatch,
    stuckPatch,
    stuckPatch,
    { text: '不会走到这里' },
  ])
  let app = await launchApp(userDataDir)
  try {
    let window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '改一下 hello')
    await waitTaskStatus(window, 'stopped')
    expect(readFileSync(join(project, 'hello.txt'), 'utf8')).toBe('hello diffra\n')
    expect(model.requests()).toBe(8)

    await window.getByTestId('turn').getByRole('button', { name: '撤销这一轮及之后的改动' }).click()
    await expect(window.getByTestId('restore-confirm')).toHaveText('撤销 1 个文件')
    await window.getByTestId('restore-confirm').click()
    await expect(window.getByTestId('notice').filter({ hasText: '已撤销 1 个文件的改动' })).toBeVisible()
    await waitTaskStatus(window, 'unfinished')
    // 撤到的是第一轮，开始时没有待验证的改动，也没有完成条件
    await expect(window.getByTestId('task-status')).toHaveAttribute('title', '文件已撤销，原来的结论不再算数。')
    expect(readFileSync(join(project, 'hello.txt'), 'utf8')).toBe('hello world\n')

    // 撤销记在会话里：重启后打开这个任务，结论和提示都还在
    await app.close()
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await window.getByTestId('sidebar').getByRole('button', { name: '改一下 hello', exact: true }).click()
    await waitTaskStatus(window, 'unfinished')
    await expect(window.getByTestId('task-status')).toHaveAttribute('title', '文件已撤销，原来的结论不再算数。')
    await expect(window.getByTestId('notice').filter({ hasText: '已撤销 1 个文件的改动' })).toBeVisible()
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('撤销到的那一轮开始时就有没验证的改动：撤销原因说之前轮次的改动还没验证', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-carried-restore-'))
  // 第一轮改完卡住停下，没走到结束门禁：改动还没验证，带到第二轮
  const model = await startScriptedModel([
    { toolCalls: [addFile('a.txt', 'first\n')] },
    stuckPatch,
    stuckPatch,
    stuckPatch,
    stuckPatch,
    stuckPatch,
    stuckPatch,
    { toolCalls: [addFile('b.txt', 'second\n')] },
    { text: '两个文件都改好了' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '改一下 a')
    await waitTaskStatus(window, 'stopped')
    expect(model.requests()).toBe(7)

    await taskInput(window).fill('再改一下 b')
    await window.keyboard.press('Control+Enter')
    await expect(window.getByTestId('turn')).toHaveCount(2)
    await waitTaskDone(window)
    expect(model.requests()).toBe(9)

    await cards(window, 'finish').getByRole('button', { name: '撤销改动', exact: true }).click()
    await expect(window.getByTestId('restore-list')).toContainText('b.txt')
    await expect(window.getByTestId('restore-confirm')).toHaveText('撤销 1 个文件')
    await window.getByTestId('restore-confirm').click()
    await expect(window.getByTestId('notice').filter({ hasText: '已撤销 1 个文件的改动' })).toBeVisible()
    await waitTaskStatus(window, 'unfinished')
    // 第二轮开始时第一轮的改动还没验证，原因由 core 按来源写，不是界面兜底的那句
    await expect(window.getByTestId('task-status')).toHaveAttribute('title', '文件已撤销，之前轮次的改动还没验证。')
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('first\n')
    expect(existsSync(join(project, 'b.txt'))).toBe(false)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
