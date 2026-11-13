import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { addFile, exec, read, startScriptedModel } from './scripted-model'

test('任务监控的产出默认十条，可展开全部和收起；点改动统计打开审阅，审阅仍保留完整列表', async () => {
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
    await expect(panel.getByTestId('monitor-changes')).toContainText('12 个文件')
    await expect(panel.getByTestId('monitor-file')).toHaveCount(10)
    await panel.getByRole('button', { name: '展开全部（剩余 2 个）', exact: true }).click()
    await expect(panel.getByTestId('monitor-file')).toHaveCount(12)
    await panel.getByRole('button', { name: '收起', exact: true }).click()
    await expect(panel.getByTestId('monitor-file')).toHaveCount(10)
    await panel.getByTestId('monitor-changes').click()
    await expect(window.getByTestId('review-file')).toHaveCount(12)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

// 第 529 步：任务监控顶上的摘要卡代替「本轮结论」和失败命令列表
test('摘要卡写着最近一条回复的开头和更新时间，点一下跳回那条回复的开头', async () => {
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-monitor-summary-'))
  writeFileSync(join(project, 'notes.txt'), 'hello\n')
  const model = await startScriptedModel([
    { toolCalls: [exec('ls'), read('notes.txt')] },
    // 一大段回复，开头被挤出视口
    { text: Array.from({ length: 80 }, (_, index) => `第 ${index + 1} 段说明`).join('\n\n') },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '监控测试', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '跑一下命令')
    await waitTaskDone(window)
    const summary = window.getByTestId('monitor-panel').getByTestId('monitor-summary')
    await expect(summary).toContainText('更新于')
    await expect(summary).toContainText('第 1 段说明 第 2 段说明')
    const first = window.getByTestId('agent-message').getByText('第 1 段说明', { exact: true })
    await expect(first).not.toBeInViewport()
    await summary.click()
    await expect(first).toBeInViewport()
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
