import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, taskInput } from './flows'
import { APP_VERSION, launchApp, makeUserDataDir } from './launch'

const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const LONG_BRANCH = 'claude/agent-design-module-research-e427b6'

// 输入框着色层和 textarea 的文字区（去掉左右内边距和滚动条位置）差多宽；两者不一样宽，换行就会错开
const COMPOSER_TEXT_WIDTH_GAP = `(() => {
  const textarea = document.querySelector('textarea[aria-label="任务"]')
  const highlight = document.querySelector('.composer-highlight')
  const inner = (element, gutter) => {
    const style = getComputedStyle(element)
    return element.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - gutter
  }
  return Math.abs(inner(textarea, textarea.offsetWidth - textarea.clientWidth) - inner(highlight, 0))
})()`

// 在快速记那一栏粘贴一张小图
const PASTE_IMAGE = `(async () => {
  const element = document.querySelector('input[aria-label="新待办"]')
  const canvas = document.createElement('canvas')
  canvas.width = 8
  canvas.height = 8
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  const data = new DataTransfer()
  data.items.add(new File([blob], 'shot.png', { type: 'image/png' }))
  element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
})()`

// 第 639 步：首页能先切分支再开新任务；分支名长时下拉框给够宽度、一行一个，不再一个字一个字地折行
test('首页切分支；分支下拉框不换行', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-home-branch-'))
  gitIn(project, 'init', '-b', 'main')
  gitIn(project, 'config', 'user.name', 'e2e')
  gitIn(project, 'config', 'user.email', 'e2e@example.com')
  writeFileSync(join(project, 'README.md'), '# demo\n')
  gitIn(project, 'add', '.')
  gitIn(project, 'commit', '-m', 'init')
  gitIn(project, 'branch', LONG_BRANCH)
  gitIn(project, 'branch', 'feature')
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await chooseProject(app, window, project)
    // 项目按钮只写项目名，分支单独一个菜单
    await expect(window.getByTestId('project-path')).not.toContainText('main')
    const branch = window.getByTestId('branch-menu')
    await expect(branch).toContainText('main')
    await branch.click()
    const items = window.getByRole('menuitemradio')
    await expect(items).toHaveCount(3)
    const long = items.filter({ hasText: LONG_BRANCH })
    // 一行：高度和只有几个字的 main 一样
    const [longBox, mainBox] = await Promise.all([long.boundingBox(), items.filter({ hasText: /^main$/ }).boundingBox()])
    expect(longBox?.height).toBe(mainBox?.height)
    expect(longBox?.width ?? 0).toBeGreaterThanOrEqual(192)
    await window.screenshot({ path: 'test-results/home-branch-menu-light.png' })
    await window.emulateMedia({ colorScheme: 'dark' })
    await window.waitForTimeout(500)
    await window.screenshot({ path: 'test-results/home-branch-menu-dark.png' })
    await window.emulateMedia({ colorScheme: 'light' })

    await long.click()
    await expect(branch).toHaveAttribute('aria-label', `分支 ${LONG_BRANCH}，切换分支`)
    expect(gitIn(project, 'branch', '--show-current')).toBe(LONG_BRANCH)
  } finally {
    await app.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

// 第 639 步：快速记那一栏没记下的字、附件，切到别的页面再回来还在；Ctrl+J 关掉再打开也还在；记下以后清空
test('快速记的草稿：切页面回来还在，Ctrl+J 关掉再开还在，记下以后清空', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    const todos = () => window.getByTestId('sidebar').getByRole('button', { name: /待办/ }).click()
    await todos()
    const input = window.getByLabel('新待办')
    await input.fill('p1 还没记下的点子')
    await input.click()
    await window.evaluate(PASTE_IMAGE)
    await expect(window.getByTestId('todo-image')).toHaveCount(1)
    await window.getByTestId('sidebar').getByRole('button', { name: '扩展' }).click()
    await expect(input).toHaveCount(0)
    await todos()
    await expect(input).toHaveValue('p1 还没记下的点子')
    await expect(window.getByTestId('todo-image')).toHaveCount(1)
    await input.press('Enter')
    await expect(window.getByTestId('todo-row')).toHaveCount(1)
    await window.getByTestId('sidebar').getByRole('button', { name: '新任务' }).click()
    await todos()
    await expect(input).toHaveValue('')
    await expect(window.getByTestId('todo-image')).toHaveCount(0)

    // Ctrl+J：Esc 关掉再打开，字还在；回车记下以后再打开是空的
    await window.keyboard.press('Control+j')
    const quick = window.getByLabel('快速记待办')
    await quick.fill('Ctrl+J 记了一半')
    await quick.press('Escape')
    await expect(quick).toHaveCount(0)
    await window.keyboard.press('Control+j')
    await expect(quick).toHaveValue('Ctrl+J 记了一半')
    await quick.press('Enter')
    await expect(window.getByTestId('todo-row')).toHaveCount(2)
    await window.keyboard.press('Control+j')
    await expect(quick).toHaveValue('')
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('首页选的模型、出计划和设计风格：切到别的页面再回来还在；输入框着色层和 textarea 一样宽', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const models = ['model-a', 'model-b'].map((id) => ({ id, contextWindow: 128_000, images: false }))
  const providers = [{ id: 'two', presetId: null, icon: null, name: '两个模型', protocol: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', models }]
  const roles = { coder: { providerId: 'two', modelId: 'model-a' }, planner: null, reviewer: null, fallback: null }
  // 记成已经看过这个版本：配了模型的设置文件会被当成老用户升级，弹「已更新」提示
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, providers, roles, lastSeenVersion: APP_VERSION }))
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    const sidebar = window.getByTestId('sidebar')
    const trigger = window.getByTestId('model-menu')
    // 去设置页再点「返回」：首页组件卸载后重新挂载
    const leaveAndComeBack = async () => {
      await sidebar.getByRole('button', { name: '设置' }).click()
      await expect(trigger).toHaveCount(0)
      await window.getByRole('button', { name: '返回', exact: true }).click()
    }

    await expect(trigger).toHaveAttribute('aria-label', /^模型 model-a/)
    await trigger.click()
    await window.getByRole('menuitem', { name: /^模型/ }).click()
    await window.getByTestId('model-list').getByRole('menuitem').filter({ hasText: 'model-b' }).click()
    await expect(trigger).toHaveAttribute('aria-label', /^模型 model-b/)
    const input = taskInput(window)
    await input.pressSequentially('/计划')
    await input.press('Enter')
    await expect(window.getByRole('button', { name: '移除计划', exact: true })).toBeVisible()

    // 默认字号（根字号 14px）下两层的文字区一样宽
    expect(await window.evaluate(COMPOSER_TEXT_WIDTH_GAP)).toBeLessThan(0.5)

    await leaveAndComeBack()
    await expect(trigger).toHaveAttribute('aria-label', /^模型 model-b/)
    await expect(window.getByRole('button', { name: '移除计划', exact: true })).toBeVisible()

    // 设计首页单独记：模型还是编码角色的，风格选过之后回来还在
    await sidebar.getByRole('button', { name: '设计', exact: true }).click()
    await expect(trigger).toHaveAttribute('aria-label', /^模型 model-a/)
    await window.getByTestId('design-style').click()
    await window.getByRole('menuitemradio', { name: /杂志排版/ }).click()
    await expect(window.getByTestId('design-style')).toHaveText(/风格：杂志排版/)
    await leaveAndComeBack()
    await expect(window.getByTestId('design-style')).toHaveText(/风格：杂志排版/)
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
