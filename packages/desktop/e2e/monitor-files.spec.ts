import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

test('任务监控默认十条改动，可展开全部和收起，审阅仍保留完整列表', async () => {
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-monitor-files-'))
  const model = await startScriptedModel([
    { toolCalls: Array.from({ length: 12 }, (_, index) => ({ name: 'edit_file', input: { path: `file-${index}.txt`, old_string: '', new_string: 'content\n' } })) },
    { toolCalls: [{ name: 'finish', input: { summary: '新增十二个文件' } }] },
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
        { name: 'list_files', input: { path: '.' } },
        { name: 'run_command', input: { command: 'false' } },
        { name: 'read_file', input: { path: 'notes.txt' } },
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
    await expect(window.getByRole('button', { name: '执行工具 3 次 · 1 条命令失败', exact: true })).toHaveAttribute('aria-expanded', 'true')
    const failed = window.locator('[data-testid="tool-call"][data-succeeded="false"]')
    await expect(failed).not.toBeInViewport()
    const panel = window.getByTestId('monitor-panel')
    await expect(panel).toContainText('1 条命令失败')
    await panel.getByRole('button', { name: '跳到失败的命令：false', exact: true }).click()
    await expect(failed).toBeInViewport()
    await expect(failed.getByRole('button')).toBeFocused()
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
