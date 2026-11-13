import { basename } from 'node:path'
import { type ElectronApplication, expect, type Page } from '@playwright/test'

// 系统文件和文件夹对话框在测试里替换成直接返回指定路径
export function answerOpenDialog(app: ElectronApplication, path: string): Promise<void> {
  return app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [target] })) as typeof dialog.showOpenDialog
  }, path)
}

// 直接点应用菜单项，不靠键盘触发菜单快捷键
export function clickMenuItem(app: ElectronApplication, id: string): Promise<void> {
  return app.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu()?.getMenuItemById(itemId)?.click(), id)
}

// 在首页通过项目下拉选择文件夹
export async function chooseProject(app: ElectronApplication, window: Page, dir: string): Promise<void> {
  await answerOpenDialog(app, dir)
  await window.getByTestId('project-path').click()
  await window.getByRole('menuitem', { name: '选择文件夹…' }).click()
  await expect(window.getByTestId('project-path')).toContainText(basename(dir))
}

export function taskInput(window: Page) {
  return window.getByLabel('任务', { exact: true })
}

// 在首页发出一个新任务，等跳到任务页
export async function startTask(window: Page, text: string): Promise<void> {
  await taskInput(window).fill(text)
  await window.getByRole('button', { name: '发送', exact: true }).click()
  await expect(window.getByTestId('task-title')).toBeVisible()
}

// 从侧栏进设计首页，发出一个设计任务；之前选过的项目沿用
export async function startDesignTask(window: Page, text: string): Promise<void> {
  await window.getByTestId('sidebar').getByRole('button', { name: '设计', exact: true }).click()
  await expect(window.getByRole('heading', { name: '要设计什么？' })).toBeVisible()
  await startTask(window, text)
}

export async function waitTaskDone(window: Page, timeout = 20_000): Promise<void> {
  await expect(window.getByTestId('task-status')).toContainText('已完成', { timeout })
}

// 按顶栏结论的 data-tone 等：停止、未完成这类结论不带「已完成」，或者要断言具体是哪一种完成
export async function waitTaskStatus(window: Page, tone: string, timeout = 20_000): Promise<void> {
  await expect(window.getByTestId('task-status')).toHaveAttribute('data-tone', tone, { timeout })
}

// 对话里某一类卡片：tool（普通工具）、edit（改动）、check（检查）、review（规范审查）、security（静态检查和轻量扫描）、
// deep-scan（深度扫描报告）、compaction（上下文压缩）、plan（计划）、finish（完成）
export function cards(window: Page, kind: 'tool' | 'edit' | 'check' | 'review' | 'security' | 'deep-scan' | 'compaction' | 'plan' | 'finish') {
  return window.locator(`[data-testid="tool-call"][data-kind="${kind}"]`)
}

// 侧栏「扩展」的某一栏；分栏名带数字（已安装 3），按开头认
export async function openExtensions(window: Page, tab: '推荐' | 'MCP' | '插件' | '已安装'): Promise<void> {
  await window.getByTestId('sidebar').getByRole('button', { name: '扩展', exact: true }).click()
  await window.getByRole('radiogroup', { name: '扩展分类' }).getByRole('radio', { name: new RegExp(`^${tab}`) }).click()
}

export function settingsNav(window: Page) {
  return window.getByRole('navigation', { name: '设置分区' })
}

// 底部终端里敲的命令：Windows 是 PowerShell；Mac 是用户的登录 shell（zsh、bash 都认这两条）
export const TERMINAL_ECHO = process.platform === 'win32' ? "Write-Output ('term' + '-ok-' + (6*7))" : 'echo "term-ok-$((6*7))"'
export const TERMINAL_PWD = process.platform === 'win32' ? '(Get-Location).Path' : 'pwd'
// 应用的后退快捷键：Windows 是 Alt+←，Mac 是 ⌘[
export const BACK_KEY = process.platform === 'darwin' ? 'Meta+BracketLeft' : 'Alt+ArrowLeft'
