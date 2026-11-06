import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

test('agent 读文件 → 改文件 → 请求执行命令 → 完成，然后撤销这一轮', async () => {
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-project-'))
  writeFileSync(join(project, 'hello.txt'), 'hello world\n')
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'read_file', input: { path: 'hello.txt' } }] },
    { toolCalls: [{ name: 'edit_file', input: { path: 'hello.txt', old_string: 'hello world', new_string: 'hello diffra' } }] },
    { toolCalls: [{ name: 'run_command', input: { command: 'echo done > done.txt' } }] },
    { toolCalls: [{ name: 'finish', input: { summary: '改好了' } }] },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })

    // 选择项目：系统文件夹对话框在测试里替换成直接返回临时目录
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog
    }, project)
    await window.getByRole('navigation').getByRole('button', { name: '会话' }).click()
    await window.getByRole('button', { name: '选择项目文件夹' }).click()
    await expect(window.getByTestId('project-path')).toHaveText(project)
    await expect(window.getByTestId('session-info')).toContainText('模型：脚本模型 / scripted')

    await window.getByLabel('任务').fill('把 hello world 改成 hello diffra，再写一个 done.txt')
    await window.getByRole('button', { name: '发送' }).click()

    // 带重定向的命令需要确认
    const permission = window.getByTestId('permission-card')
    await expect(permission).toContainText('echo done > done.txt')
    await expect(window.getByTestId('diff-view')).toContainText('+hello diffra')
    await permission.getByRole('button', { name: '允许一次' }).click()

    await expect(window.getByRole('button', { name: '发送' })).toBeVisible({ timeout: 20_000 })
    await expect(window.getByTestId('tool-call').filter({ hasText: '完成' })).toContainText('未经自动验证')
    expect(readFileSync(join(project, 'hello.txt'), 'utf8')).toBe('hello diffra\n')
    expect(readFileSync(join(project, 'done.txt'), 'utf8').trim()).toBe('done')
    expect(model.requests()).toBe(4)
    await expect(window.getByTestId('context-usage')).toHaveText('上下文 1k / 128k')
    await window.screenshot({ path: 'test-results/agent-session.png' })

    // 撤销这一轮：先列出受影响的文件，确认后恢复
    await window.getByRole('button', { name: '撤销到这一轮之前' }).click()
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
