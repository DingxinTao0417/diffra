import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { cards, chooseProject, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

const SECRET = 'sk-live-should-never-show'

test('agent 读不到 .env、改不了禁写目录；读文件 → 改文件 → 请求执行命令 → 完成，然后撤销这一轮', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-project-'))
  writeFileSync(join(project, 'hello.txt'), 'hello world\n')
  writeFileSync(join(project, '.env'), `API_KEY=${SECRET}\n`)
  mkdirSync(join(project, 'data'))
  writeFileSync(join(project, 'data', 'db.json'), '{"users":[]}\n')
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'read_file', input: { path: '.env' } }] },
    { toolCalls: [{ name: 'edit_file', input: { path: 'data/db.json', old_string: '[]', new_string: '[1]' } }] },
    { toolCalls: [{ name: 'read_file', input: { path: 'hello.txt' } }] },
    { toolCalls: [{ name: 'edit_file', input: { path: 'hello.txt', old_string: 'hello world', new_string: 'hello diffra' } }] },
    { toolCalls: [{ name: 'run_command', input: { command: 'echo done > done.txt' } }] },
    { toolCalls: [{ name: 'finish', input: { summary: '改好了' } }] },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await expect(window.getByTestId('model-menu')).toHaveText('scripted')

    // 把 data 设为禁写目录；新任务按新设置运行
    await window.getByRole('button', { name: '未配置检查' }).click()
    await window.getByLabel('禁止修改的目录').fill('data')
    await window.getByRole('button', { name: '保存项目设置' }).click()
    await expect(window.getByRole('dialog')).toBeHidden()

    await startTask(window, '把 hello world 改成 hello diffra，再写一个 done.txt')

    // 带重定向的命令需要确认
    const permission = window.getByTestId('permission-card')
    await expect(permission).toContainText('echo done > done.txt', { timeout: 20_000 })
    await expect(window.getByTestId('diff-view')).toHaveCount(0)
    await window.getByRole('button', { name: '查看改动 hello.txt', exact: true }).click()
    await expect(window.getByTestId('diff-view')).toContainText('+hello diffra')
    await permission.getByRole('button', { name: '允许一次' }).click()

    await waitTaskDone(window)
    await expect(cards(window, 'finish')).toContainText('未经自动验证')
    expect(readFileSync(join(project, 'hello.txt'), 'utf8')).toBe('hello diffra\n')
    expect(readFileSync(join(project, 'done.txt'), 'utf8').trim()).toBe('done')
    expect(model.requests()).toBe(6)
    await expect(window.getByTestId('monitor-panel')).toContainText('禁止修改的目录')
    await expect(window.getByTestId('monitor-panel')).toContainText('data')

    // 读 .env、改禁写目录的两次调用都失败了：收在「执行工具」组里，展开后能看到原因
    await window.getByRole('button', { name: /执行工具 3 次 · 2 次失败/ }).click()
    const failed = window.locator('[data-testid="tool-call"][data-status="failed"]')
    await expect(failed).toHaveCount(2)
    await failed.nth(0).getByRole('button').click()
    await failed.nth(1).getByRole('button').click()
    await expect(failed.nth(0)).toContainText('protected')
    await expect(failed.nth(1)).toContainText('read-only')
    expect(await window.locator('body').innerText()).not.toContain(SECRET)
    expect(readFileSync(join(project, 'data', 'db.json'), 'utf8')).toBe('{"users":[]}\n')

    // 上下文占用：底部显示百分比，点开看总数
    await expect(window.getByTestId('context-usage')).toHaveText('上下文 1%')
    await window.getByTestId('context-usage').click()
    await expect(window.getByText('1k / 128k · 1%')).toBeVisible()
    await window.keyboard.press('Escape')
    await window.screenshot({ path: 'test-results/agent-session.png' })

    // 撤销这一轮：先列出受影响的文件，确认后恢复
    await window.getByTestId('turn').getByRole('button', { name: '撤销到这一轮之前' }).click()
    const list = window.getByTestId('restore-list')
    await expect(list).toContainText('hello.txt')
    await expect(list).toContainText('done.txt')
    await window.getByRole('button', { name: '确认撤销' }).click()
    await expect(window.getByTestId('notice').filter({ hasText: '已撤销 2 个文件的改动' })).toBeVisible()
    expect(readFileSync(join(project, 'hello.txt'), 'utf8')).toBe('hello world\n')
    expect(existsSync(join(project, 'done.txt'))).toBe(false)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
