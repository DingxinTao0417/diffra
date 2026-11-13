import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, taskInput, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { exec, startScriptedModel } from './scripted-model'

const plan = (statuses: string[]) => ({
  name: 'update_plan',
  input: { plan: ['看项目', '改代码', '跑测试'].map((step, index) => ({ step, status: statuses[index] })) },
})

// 第 542 步：智能体列的步骤在输入框上方的步骤条里，默认收起成一行、跟着更新，点开看全部；对话里不再画步骤卡。
// 这一轮做完后还留着，下一轮没列步骤就没了
test('步骤条：在输入框上方，默认收起只写进度和正在做的一步，点开看全部；对话里没有步骤卡；下一轮没列步骤就消失', async () => {
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-steps-bar-'))
  const model = await startScriptedModel([
    { toolCalls: [plan(['in_progress', 'pending', 'pending'])] },
    { toolCalls: [exec('ls')], delayMs: 1500 },
    { toolCalls: [plan(['completed', 'completed', 'completed'])] },
    { text: '做完了' },
    { text: '好的' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '分几步做')
    const bar = window.getByTestId('steps-bar')
    // 进行中：一行，写着第几步和正在做的
    await expect(bar).toContainText('步骤 0/3')
    await expect(bar).toContainText('看项目')
    await expect(bar.getByTestId('step')).toHaveCount(0)
    await waitTaskDone(window)
    await expect(bar).toContainText('步骤 3/3')
    await expect(bar).toContainText('已完成')
    await expect(window.locator('[data-testid="tool-call"][data-kind="steps"]')).toHaveCount(0)
    // 点开：全部步骤
    await bar.getByRole('button', { name: /^步骤 3\/3/ }).click()
    await expect(bar.getByTestId('step')).toHaveText(['看项目', '改代码', '跑测试'])
    await expect(bar.getByTestId('step').first()).toHaveAttribute('data-status', 'completed')
    // 下一轮没列步骤：步骤条没了
    await taskInput(window).fill('谢谢')
    await window.keyboard.press('Control+Enter')
    await expect(window.getByTestId('agent-message').last()).toContainText('好的')
    await expect(bar).toHaveCount(0)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
