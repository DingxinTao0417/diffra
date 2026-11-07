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
    await waitTaskDone(window)
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
