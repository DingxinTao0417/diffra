import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, settingsNav, taskInput, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { addFile, patch, startScriptedModel } from './scripted-model'

test('斜杠菜单：选 Skill 和目标成标签，计划和目标二选一；目标模式没达成自动跑下一轮；任务页能从菜单发起深度扫描', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-slash-'))
  mkdirSync(join(project, '.diffra', 'skills', 'diffra-e2e-style'), { recursive: true })
  writeFileSync(join(project, '.diffra', 'skills', 'diffra-e2e-style', 'SKILL.md'), '---\nname: diffra-e2e-style\ndescription: 测试用的写作风格\n---\n回答时先说 STYLE-OK\n')
  const model = await startScriptedModel([
    // 第一轮：写了文件，没标目标完成就停下
    { toolCalls: [addFile('notes.txt', 'one\n')] },
    { text: '还差第二行' },
    // 第二轮：补完，用 update_goal 标完成再停下
    { toolCalls: [patch('*** Update File: notes.txt', ' one', '+two')] },
    { toolCalls: [{ name: 'update_goal', input: { status: 'complete' } }] },
    { text: '两行都写好了' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })

    // 目标模式默认 5 轮，改成 3 轮
    await window.keyboard.press('ControlOrMeta+,')
    await settingsNav(window).getByRole('button', { name: '任务执行' }).click()
    const rounds = window.getByRole('radiogroup', { name: '目标模式轮数上限' })
    await expect(rounds.getByRole('radio', { name: '5 轮' })).toHaveAttribute('aria-checked', 'true')
    await rounds.getByRole('radio', { name: '3 轮' }).click()
    await expect.poll(() => JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')).execution.goalMaxRounds).toBe(3)
    await window.getByRole('button', { name: '返回' }).click()
    await chooseProject(app, window, project)

    const input = taskInput(window)
    const menu = window.getByRole('listbox', { name: '命令和 Skill' })
    const option = (name: string) => menu.getByRole('option').filter({ hasText: name })
    const chips = window.getByTestId('composer-chip')
    const planChip = window.getByRole('button', { name: '移除计划', exact: true })

    // 「/」打开菜单：首页有目标、计划和项目里的 Skill，没有深度扫描
    await input.pressSequentially('/')
    await expect(menu).toBeVisible()
    await expect(option('目标')).toBeVisible()
    await expect(option('计划')).toBeVisible()
    await expect(option('diffra-e2e-style')).toContainText('测试用的写作风格')
    await expect(option('diffra-e2e-style')).toContainText('项目')
    // 随 Diffra 带的 Skill 也能手动选，标成「内置」
    await expect(option('frontend-design')).toContainText('内置')
    await expect(option('深度扫描')).toHaveCount(0)
    await window.screenshot({ path: 'test-results/slash-menu.png' })

    // Esc 关掉，输入的「/」留着；删掉再打开
    await input.press('Escape')
    await expect(menu).toBeHidden()
    await expect(input).toHaveValue('/')
    await input.press('Backspace')
    await input.pressSequentially('/diffra-e2e')
    await expect(menu.getByRole('option')).toHaveCount(1)
    await input.press('Enter')
    await expect(menu).toBeHidden()
    await expect(input).toHaveValue('')
    await expect(chips).toHaveText(['diffra-e2e-style'])

    // 计划和目标二选一
    await input.pressSequentially('/计划')
    await input.press('Enter')
    await expect(planChip).toBeVisible()
    await input.pressSequentially('/goal')
    await input.press('Tab')
    await expect(planChip).toHaveCount(0)
    await expect(chips).toHaveText(['目标 · 最多 3 轮', 'diffra-e2e-style'])

    // 光标在最前面时退格删最后一个标签；× 删指定的
    await input.press('Backspace')
    await expect(chips).toHaveText(['目标 · 最多 3 轮'])
    await window.getByRole('button', { name: '移除目标' }).click()
    await expect(chips).toHaveCount(0)

    // 方向键上下移动，到头绕回；接着输入会重新从第一项开始。菜单里还会有本机用户目录里的 Skill，不按个数断言
    await input.pressSequentially('/')
    await expect(option('目标')).toHaveAttribute('aria-selected', 'true')
    await input.press('ArrowDown')
    await expect(option('计划')).toHaveAttribute('aria-selected', 'true')
    await input.press('ArrowUp')
    await input.press('ArrowUp')
    await expect(menu.getByRole('option').last()).toHaveAttribute('aria-selected', 'true')
    await input.pressSequentially('diffra-e2e')
    await expect(option('diffra-e2e-style')).toHaveAttribute('aria-selected', 'true')
    await input.press('Enter')
    await input.pressSequentially('/目标')
    await input.press('Enter')
    await window.screenshot({ path: 'test-results/slash-chips.png' })
    await input.pressSequentially('写一个两行的 notes.txt')
    await window.getByRole('button', { name: '发送', exact: true }).click()
    await expect(window.getByTestId('task-title')).toBeVisible()
    await waitTaskDone(window)

    // 两轮做完；Skill 说明和目标模式说明都发给了模型
    await expect(window.getByTestId('notice').filter({ hasText: '目标模式第 2 轮' })).toBeVisible()
    await expect(window.getByTestId('notice').filter({ hasText: '目标已完成（用了 2 轮）' })).toBeVisible()
    expect(readFileSync(join(project, 'notes.txt'), 'utf8')).toBe('one\ntwo\n')
    expect(model.requests()).toBe(5)
    const first = model.bodies()[0] ?? ''
    expect(first).toContain('回答时先说 STYLE-OK')
    expect(first).toContain('up to 3 rounds')
    await expect(window.getByTestId('message-tags')).toHaveText(/目标.*diffra-e2e-style/)
    await expect(window.getByTestId('user-message')).toHaveText('写一个两行的 notes.txt')
    // 每轮的完成卡片只列这一轮的改动
    await expect(window.locator('[data-testid="tool-call"][data-kind="finish"]')).toHaveCount(2)
    await expect(window.locator('[data-testid="tool-call"][data-kind="finish"]').first()).toContainText('+1')
    await window.getByTestId('message-tags').locator('..').screenshot({ path: 'test-results/goal-request.png' })
    await window.screenshot({ path: 'test-results/goal-turn.png' })

    // 任务页的菜单多了深度扫描，选了先弹确认
    await input.pressSequentially('/扫描')
    await expect(option('深度扫描 · 本任务改动')).toBeVisible()
    await expect(option('深度扫描 · 整个项目')).toBeVisible()
    await input.press('Enter')
    await expect(window.getByRole('dialog')).toContainText('深度扫描本任务改动？')
    await window.getByRole('button', { name: '取消' }).click()
    await expect(window.getByRole('dialog')).toBeHidden()
    expect(model.requests()).toBe(5)

    // 重新打开任务，提问气泡上的标签还在
    await window.reload()
    await window.getByTestId('sidebar-task').filter({ hasText: '写一个两行的 notes.txt' }).click()
    await expect(window.getByTestId('message-tags')).toHaveText(/目标.*diffra-e2e-style/)
    expect(existsSync(join(project, 'notes.txt'))).toBe(true)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
