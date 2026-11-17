import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { exec, replaceLines, startScriptedModel } from './scripted-model'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, timeout: 15_000, env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } })

test('持久协作：独立改动、显式整合、独立审查与测试验收，重启仍能查看结果', async () => {
  test.setTimeout(120_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-collaboration-e2e-'))
  writeFileSync(join(project, 'a.txt'), 'alpha\n')
  writeFileSync(join(project, 'content.test.cjs'), "const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');test('content',()=>assert.equal(fs.readFileSync('a.txt','utf8').trim(),'ALPHA'));\n")
  git(project, 'init', '-q')
  git(project, 'config', 'core.autocrlf', 'false')
  git(project, 'add', '.')
  git(project, 'commit', '-qm', 'init')
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'delegate', input: { name: '实现工人', task: 'WORKER-IMPLEMENT：把 a.txt 改成 ALPHA，交回报告', files: ['a.txt'], role: 'implementer', background: true } }] },
    { toolCalls: [{ name: 'wait_agents', input: { agents: ['实现工人'] } }] },
    { toolCalls: [{ name: 'integrate_agent', input: { agent: '实现工人' } }] },
    { text: '实现已整合，等待独立验收' },
    { text: '等待验收工人的结果' },
    { text: '独立审查与测试均通过，交付完成' },
    { toolCalls: [{ name: 'wait_agents', input: { agents: ['实现工人'] } }] },
    { text: '原工人已续聊复查' },
    { match: 'WORKER-IMPLEMENT', toolCalls: [replaceLines('a.txt', 'alpha', 'ALPHA')] },
    { match: 'WORKER-IMPLEMENT', toolCalls: [{ name: 'report', input: { summary: '实现完成，改动保留在独立工作区' } }] },
    { match: 'WORKER-IMPLEMENT', toolCalls: [exec('cat a.txt')] },
    { match: 'WORKER-IMPLEMENT', toolCalls: [{ name: 'report', input: { summary: '重启后的原工人已核对最终内容' } }] },
    { match: 'Independently review', toolCalls: [exec('cat a.txt')] },
    { match: 'Independently review', toolCalls: [{ name: 'report', input: { summary: '已阅读整合后的文件，符合请求', verdict: 'passed' } }] },
    { match: 'Independently verify', toolCalls: [exec('node --test')] },
    { match: 'Independently verify', toolCalls: [{ name: 'report', input: { summary: '实际执行测试，退出码为零', verdict: 'passed' } }] },
  ])
  let app = await launchApp(userDataDir)
  try {
    let window = await app.firstWindow()
    await configureCoderModel(window, { name: '协作模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '把 a.txt 的 alpha 改成 ALPHA，完成后独立审查并执行测试')
    const panel = window.getByTestId('collaboration-panel')
    await expect(panel).toBeVisible()
    await expect(panel.getByTestId('collaboration-counts')).toContainText('最多 8 个工人并行')
    // 测试命令按原权限流程确认，不在协作层绕过。
    const permission = window.getByTestId('permission-card')
    await expect(permission).toContainText('node --test', { timeout: 60_000 })
    await permission.getByRole('button', { name: '允许一次', exact: true }).click()
    await waitTaskDone(window, 60_000)
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('ALPHA\n')
    await expect(panel.getByText('验收通过', { exact: true })).toBeVisible()
    await expect(panel.getByTestId('collaboration-worker')).toHaveCount(3)
    await window.screenshot({ path: 'test-results/collaboration-light.png' })
    await window.emulateMedia({ colorScheme: 'dark' })
    await window.screenshot({ path: 'test-results/collaboration-dark.png' })
    await app.close()
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await window.getByTestId('sidebar-task').first().click()
    await expect(window.getByTestId('collaboration-panel').getByText('验收通过', { exact: true })).toBeVisible()
    await window.getByTestId('collaboration-panel').getByLabel('给这个工人发消息').fill('复查最终内容，不要修改实现。')
    await window.getByTestId('collaboration-panel').getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(window.getByTestId('collaboration-panel').getByText('重启后的原工人已核对最终内容', { exact: true })).toBeVisible({ timeout: 60_000 })
    await waitTaskDone(window)
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('ALPHA\n')
    await expect(window.getByTestId('collaboration-panel').getByTestId('collaboration-worker')).toHaveCount(3)
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test('单工人中断不会取消主任务，探索任务不需要 Git 仓库', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-collaboration-stop-'))
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'delegate', input: { name: '慢速探索', task: 'WORKER-SLOW：只读探索', role: 'explorer', background: true } }] },
    { toolCalls: [{ name: 'wait_agents', input: { agents: ['慢速探索'] } }] },
    { text: '收到工人被中断的结果，主任务仍可回复' },
    { match: 'WORKER-SLOW', delayMs: 20_000, toolCalls: [{ name: 'report', input: { summary: '慢速报告' } }] },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '协作模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '只读探索，稍后我会单独停止工人')
    const panel = window.getByTestId('collaboration-panel')
    await expect(panel.getByTestId('collaboration-worker')).toHaveAttribute('data-status', 'running')
    await panel.getByRole('button', { name: '停止工人', exact: true }).click()
    await expect(panel.getByTestId('collaboration-worker')).toHaveAttribute('data-status', 'interrupted')
    await waitTaskDone(window)
    await expect(window.getByText('收到工人被中断的结果，主任务仍可回复', { exact: true })).toBeVisible()
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})
