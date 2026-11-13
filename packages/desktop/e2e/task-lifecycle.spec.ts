import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

test('模型很久没有输出时提示可能卡住了，又有输出后提示消失，这一轮照常结束', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-silence-'))
  const model = await startScriptedModel([{ text: '想好了', delayMs: 5000 }])
  // 提示时限从 3 分钟缩到 1 秒，模型 5 秒后才回
  const app = await launchApp(userDataDir, { DIFFRA_MODEL_SILENCE_MS: '1000' })
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '慢模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '慢慢想')
    const hint = window.getByTestId('model-silence')
    await expect(hint).toContainText(/模型已 \d+ 秒没有输出，可能卡住了/)
    await expect(hint.getByRole('button', { name: '重试这一步' })).toBeVisible()
    // 不替用户停：还在进行中，等到模型回了提示就撤掉
    await expect(window.getByText('进行中…')).toBeVisible()
    await expect(hint).toBeHidden({ timeout: 15_000 })
    await waitTaskDone(window)
    await expect(window.getByText('想好了')).toBeVisible()
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
