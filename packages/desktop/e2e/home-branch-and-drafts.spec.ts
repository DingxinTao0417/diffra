import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject } from './flows'
import { launchApp, makeUserDataDir } from './launch'

const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const LONG_BRANCH = 'claude/agent-design-module-research-e427b6'

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
