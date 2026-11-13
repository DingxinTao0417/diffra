import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, waitTaskDone, waitTaskStatus } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { exec, lastToolResult, type ScriptMessages, startScriptedModel } from './scripted-model'

// exec_command 到点还没结束时返回的会话号，write_stdin 用它接着等
const sessionOf = (messages: ScriptMessages) => Number(/Process running with session ID (\d+)/.exec(lastToolResult(messages))?.[1] ?? -1)

test('等 CI：命令到点没结束就在后台接着跑，卡片上能看到还在等；等到了这一轮接着做；等的时候能停', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-wait-'))
  const model = await startScriptedModel([
    { toolCalls: [exec('sleep 4; echo "conclusion: success"', { yield_time_ms: 250 })] },
    { toolCalls: [{ name: 'write_stdin', input: (messages: ScriptMessages) => ({ session_id: sessionOf(messages), yield_time_ms: 30_000 }) }] },
    { text: 'CI 过了，可以发布' },
    { toolCalls: [exec('sleep 120', { yield_time_ms: 250 })] },
    { toolCalls: [{ name: 'write_stdin', input: (messages: ScriptMessages) => ({ session_id: sessionOf(messages), yield_time_ms: 300_000 }) }] },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '推送后等 CI')
    // 命令按权限模式确认，确认一次后整个等待期间不再问
    await window.getByTestId('permission-card').getByRole('button', { name: '允许一次' }).click()
    // 第一次到点时命令还在跑，模型接着用 write_stdin 等它：过程组标题上写着正在查看命令输出，等的时候没有再调模型
    await expect(window.getByTestId('tool-group-activity')).toContainText('查看命令输出', { timeout: 15_000 })
    expect(model.requests()).toBe(2)
    // 第一张命令卡片写着运行中和会话号
    await window.getByRole('button', { name: /执行工具 2 次/ }).click()
    const started = window.locator('[data-testid="tool-call"]').filter({ hasText: /执行\s*sleep 4/ })
    await started.getByRole('button').click()
    await expect(started).toContainText('运行中（会话')
    await waitTaskDone(window, 30_000)
    await expect(window.getByText('CI 过了，可以发布')).toBeVisible()
    expect(model.requests()).toBe(3)
    // 等到的输出在 write_stdin 的卡片上，标题换成「查看 <命令>」
    const waited = window.locator('[data-testid="tool-call"]').filter({ hasText: /查看\s*sleep 4/ })
    await waited.getByRole('button').click()
    await expect(waited).toContainText('conclusion: success')
    await expect(waited).toContainText('Exit code: 0')

    // 第二轮：一直没好，用户停下
    await window.getByLabel('任务', { exact: true }).fill('再等一次')
    await window.getByLabel('任务', { exact: true }).press('Enter')
    await window.getByTestId('permission-card').getByRole('button', { name: '允许一次' }).click()
    const second = window.getByTestId('turn').last()
    await expect(second.getByTestId('tool-group-activity')).toContainText('查看命令输出', { timeout: 15_000 })
    expect(model.requests()).toBe(5)
    await window.getByRole('button', { name: '停止', exact: true }).click()
    await waitTaskStatus(window, 'stopped')
    // 等着的进程跟着结束，模型没有再被调
    await second.getByRole('button', { name: /执行工具 2 次 · 1 次失败/ }).click()
    const cancelled = second.locator('[data-testid="tool-call"][data-status="failed"]')
    await cancelled.getByRole('button').click()
    await expect(cancelled).toContainText('Cancelled by the user')
    expect(model.requests()).toBe(5)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
