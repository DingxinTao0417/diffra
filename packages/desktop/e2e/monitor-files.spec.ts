import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { addFile, exec, read, startScriptedModel } from './scripted-model'

test('任务监控默认十条改动，可展开全部和收起，审阅仍保留完整列表', async () => {
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-monitor-files-'))
  const model = await startScriptedModel([
    { toolCalls: Array.from({ length: 12 }, (_, index) => addFile(`file-${index}.txt`, 'content\n')) },
    { text: '新增十二个文件' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '监控测试', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '新增文件')
    await waitTaskDone(window)
    const panel = window.getByTestId('monitor-panel')
    await expect(panel).toContainText('本任务改动 · 12 个文件')
    await expect(panel.getByTestId('monitor-file')).toHaveCount(10)
    await panel.getByRole('button', { name: '展开全部（剩余 2 个）', exact: true }).click()
    await expect(panel.getByTestId('monitor-file')).toHaveCount(12)
    await panel.getByRole('button', { name: '收起改动列表', exact: true }).click()
    await expect(panel.getByTestId('monitor-file')).toHaveCount(10)
    await panel.getByRole('button', { name: '审阅', exact: true }).click()
    await expect(window.getByTestId('review-file')).toHaveCount(12)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('本轮结论下列出失败的命令，点一下跳到对话里那一行，焦点跟过去', async () => {
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-monitor-failed-'))
  writeFileSync(join(project, 'notes.txt'), 'hello\n')
  const model = await startScriptedModel([
    // false 在只读命令名单里，默认权限下直接执行，退出码 1；和前后两个工具收进同一个组
    {
      toolCalls: [
        exec('ls'),
        exec('false'),
        read('notes.txt'),
      ],
    },
    // 一大段回复把上面的工具组挤出视口
    { text: Array.from({ length: 80 }, (_, index) => `第 ${index + 1} 段说明`).join('\n\n') },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '监控测试', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '跑一下命令')
    await waitTaskDone(window)
    // 有失败命令的组也默认收着，标题上写着失败数；从任务监控跳过去时才展开
    const group = window.getByRole('button', { name: '执行工具 3 次 · 1 条命令失败', exact: true })
    await expect(group).toHaveAttribute('aria-expanded', 'false')
    const failed = window.locator('[data-testid="tool-call"][data-succeeded="false"]')
    await expect(failed).not.toBeInViewport()
    const panel = window.getByTestId('monitor-panel')
    await expect(panel).toContainText('1 条命令失败')
    await panel.getByRole('button', { name: '跳到失败的命令：false', exact: true }).click()
    await expect(group).toHaveAttribute('aria-expanded', 'true')
    await expect(failed).toBeInViewport()
    await expect(failed.getByRole('button')).toBeFocused()
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('同一条命令反复失败只列一行，按最近一次排序、标次数，点一下跳到最近那次', async () => {
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-monitor-repeated-'))
  const model = await startScriptedModel([
    // 都在只读命令名单里，直接执行、都会失败；false 只重复两次，不到原地打转的三次
    {
      toolCalls: [
        exec('false'),
        exec('cat a.txt'),
        exec('false'),
        exec('cat b.txt'),
        exec('ls c'),
      ],
    },
    { text: Array.from({ length: 80 }, (_, index) => `第 ${index + 1} 段说明`).join('\n\n') },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '监控测试', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '跑几条命令')
    await waitTaskDone(window)
    const panel = window.getByTestId('monitor-panel')
    await expect(panel).toContainText('5 条命令失败')
    const rows = panel.getByTestId('monitor-failed-command')
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0)).toHaveAccessibleName('跳到失败的命令：ls c')
    await expect(rows.nth(1)).toHaveAccessibleName('跳到失败的命令：cat b.txt')
    await expect(rows.nth(2)).toHaveAccessibleName('跳到失败 2 次的命令：false')
    await expect(rows.nth(2)).toContainText('2 次')
    // 没列出来的是 cat a.txt；按次数算，已显示的三行占了 4 次
    await expect(panel).toContainText('还有 1 条命令失败')

    const latest = window.locator('[data-testid="tool-call"][data-succeeded="false"]').nth(2)
    await expect(latest).not.toBeInViewport()
    await panel.getByRole('button', { name: '跳到失败 2 次的命令：false', exact: true }).click()
    await expect(latest).toBeInViewport()
    await expect(latest.getByRole('button')).toBeFocused()
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
