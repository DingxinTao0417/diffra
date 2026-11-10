import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, waitTaskDone, waitTaskStatus } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

// 第一次检查还在跑，第二次成功
const CHECK = 'n=$(cat count 2>/dev/null || echo 0); n=$((n+1)); echo $n > count; if [ $n -ge 2 ]; then echo "conclusion: success"; else echo "status: in_progress"; fi'

test('等 CI：卡片上能看到第几次检查、还在等；等到了这一轮接着做；等的时候能停', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-wait-'))
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'wait_command', input: { command: CHECK, success: 'success', failure: 'failure', interval_seconds: 10 } }] },
    { text: 'CI 过了，可以发布' },
    { toolCalls: [{ name: 'wait_command', input: { command: 'echo "status: in_progress"', success: 'success', interval_seconds: 10 } }] },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '推送后等 CI')
    // 检查命令和 run_command 一样按权限模式确认，确认一次后整个等待期间不再问
    await window.getByTestId('permission-card').getByRole('button', { name: '允许一次' }).click()
    const card = window.getByTestId('tool-call').filter({ hasText: '等待' }).first()
    // 等待期间没有再调模型
    await expect(card).toContainText('第 1 次检查还没好', { timeout: 15_000 })
    expect(model.requests()).toBe(1)
    await waitTaskDone(window, 30_000)
    await expect(window.getByText('CI 过了，可以发布')).toBeVisible()
    expect(model.requests()).toBe(2)

    // 第二轮：一直没好，用户停下
    await window.getByLabel('任务', { exact: true }).fill('再等一次')
    await window.getByLabel('任务', { exact: true }).press('Enter')
    await expect(window.getByTestId('turn').last()).toContainText('第 1 次检查还没好', { timeout: 15_000 })
    await window.getByRole('button', { name: '停止', exact: true }).click()
    await waitTaskStatus(window, 'stopped')
    expect(model.requests()).toBe(3)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
