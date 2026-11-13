import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { addFile, startScriptedModel } from './scripted-model'

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
