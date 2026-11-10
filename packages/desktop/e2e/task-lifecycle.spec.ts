import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

test('中间验证后继续；发布未完成显示等待及清单，重启恢复不冒充完成', async () => {
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-lifecycle-'))
  const requirements = [
    { id: 'commit', title: '提交 SHA', commandIncludes: 'git rev-parse HEAD', outputIncludes: 'target-sha' },
    { id: 'push', title: '推送远端', commandIncludes: 'git ls-remote', outputIncludes: 'target-sha' },
    { id: 'ci', title: 'CI 成功', commandIncludes: 'gh run view', outputIncludes: 'success' },
    { id: 'publish', title: '更新源发布', commandIncludes: 'pnpm publish:release', outputIncludes: '已发布 0.1.2' },
  ]
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'task_progress', input: { action: 'define', requirements } }] },
    { toolCalls: [{ name: 'verify_changes', input: { summary: '仅验证' } }] },
    { toolCalls: [{ name: 'finish', input: { summary: '还未发布，先完成' } }] },
    { toolCalls: [{ name: 'pause_task', input: { status: 'waiting', reason: '等待云端 CI，尚未发布' } }] },
  ])
  let app = await launchApp(userDataDir)
  try {
    let window = await app.firstWindow()
    await configureCoderModel(window, { name: '生命周期', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '提交推送打包发布 0.1.2')
    // 主动暂停等待的任务顶栏和任务监控都写「等待中」，不冒充已完成
    await expect(window.getByTestId('task-status')).toContainText('等待中', { timeout: 20_000 })
    const panel = window.getByTestId('monitor-panel')
    await expect(panel).toContainText('等待中')
    await expect(panel).toContainText('尚未发布')
    await expect(panel).toContainText('CI 成功')
    await expect(panel).toContainText('待完成')
    expect(model.requests()).toBe(4)
    await app.close()
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await window.getByTestId('sidebar').getByRole('button', { name: '提交推送打包发布 0.1.2', exact: true }).click()
    await expect(window.getByTestId('monitor-panel')).toContainText('等待中')
    await expect(window.getByTestId('monitor-panel')).toContainText('更新源发布')
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

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
