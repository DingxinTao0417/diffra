import { basename } from 'node:path'
import { type ElectronApplication, expect, type Page } from '@playwright/test'

// 系统文件和文件夹对话框在测试里替换成直接返回指定路径
export function answerOpenDialog(app: ElectronApplication, path: string): Promise<void> {
  return app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [target] })) as typeof dialog.showOpenDialog
  }, path)
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

export async function waitTaskDone(window: Page, timeout = 20_000): Promise<void> {
  await expect(window.getByTestId('task-status')).toContainText('已完成', { timeout })
}

// 对话里某一类卡片：tool（普通工具）、edit（改动）、check（检查）、review（规范审查）、security（静态检查和轻量扫描）、
// deep-scan（深度扫描报告）、compaction（上下文压缩）、plan（计划）、finish（完成）
export function cards(window: Page, kind: 'tool' | 'edit' | 'check' | 'review' | 'security' | 'deep-scan' | 'compaction' | 'plan' | 'finish') {
  return window.locator(`[data-testid="tool-call"][data-kind="${kind}"]`)
}

export function settingsNav(window: Page) {
  return window.getByRole('navigation', { name: '设置分区' })
}
