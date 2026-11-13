import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { cards, chooseProject, startTask, waitTaskDone, waitTaskStatus } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { exec, read, replaceLines, startScriptedModel } from './scripted-model'

const SECRET = 'sk-live-should-never-show'

test('agent 读 .env 要确认（拒绝后读不到）、改不了禁写目录；读文件 → 改文件 → 请求执行命令 → 完成，然后撤销这一轮', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-project-'))
  writeFileSync(join(project, 'hello.txt'), 'hello world\n')
  writeFileSync(join(project, '.env'), `API_KEY=${SECRET}\n`)
  mkdirSync(join(project, 'data'))
  writeFileSync(join(project, 'data', 'db.json'), '{"users":[]}\n')
  const model = await startScriptedModel([
    { toolCalls: [read('.env')] },
    { toolCalls: [replaceLines('data/db.json', '{"users":[]}', '{"users":[1]}')] },
    { toolCalls: [read('hello.txt')] },
    { toolCalls: [replaceLines('hello.txt', 'hello world', 'hello diffra')] },
    { toolCalls: [exec('echo done > done.txt', { justification: '按要求写一个 done.txt' })] },
    { text: '改好了' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await expect(window.getByTestId('model-menu').locator('span.truncate')).toHaveText('scripted')

    // 把 data 设为禁写目录；新任务按新设置运行。首页不再有项目设置入口，走项目设置弹窗保存时的同一个接口
    await window.evaluate(`window.diffra.saveProject(${JSON.stringify(project)}, { checks: { afterEdit: null, beforeFinish: null }, readOnlyPaths: ['data'] })`)

    await startTask(window, '把 hello world 改成 hello diffra，再写一个 done.txt')

    // 读 .env 的命令要用户确认，拒绝后智能体读不到
    const permission = window.getByTestId('permission-card')
    await expect(permission).toContainText('cat .env', { timeout: 20_000 })
    await expect(permission.getByTestId('permission-justification')).toHaveCount(0)
    await permission.getByRole('button', { name: '拒绝' }).click()

    // 带重定向的命令需要确认
    await expect(permission).toContainText('echo done > done.txt', { timeout: 20_000 })
    await expect(permission.getByTestId('permission-justification')).toHaveText('按要求写一个 done.txt')
    await expect(window.getByTestId('diff-view')).toHaveCount(0)
    // 过程组默认收着，运行中也是：先点开再看改动
    await window.getByRole('button', { name: /执行工具 4 次 · 2 次失败/ }).click()
    await window.getByRole('button', { name: '查看改动 hello.txt', exact: true }).click()
    await expect(window.getByTestId('diff-view')).toContainText('+hello diffra')
    await permission.getByRole('button', { name: '允许一次' }).click()

    await waitTaskDone(window)
    // 没配检查：结论就是「已完成」，对话里没有完成卡、也不提醒没配检查（第 526 步）；这一轮改的文件写在底部
    await expect(window.getByTestId('task-status')).toContainText('已完成')
    await expect(window.getByTestId('task-status')).not.toContainText('验证')
    await expect(cards(window, 'finish')).toHaveCount(0)
    await expect(window.getByTestId('turn-files')).toHaveText('1 个文件 +1 −1')
    expect(readFileSync(join(project, 'hello.txt'), 'utf8')).toBe('hello diffra\n')
    expect(readFileSync(join(project, 'done.txt'), 'utf8').trim()).toBe('done')
    expect(model.requests()).toBe(6)

    // 读 .env（用户拒绝）、改禁写目录的两次调用都失败了：和别的调用收在同一个过程组里（上面已经点开），标题上写着失败次数
    await expect(window.getByRole('button', { name: /执行工具 5 次 · 2 次失败/ })).toHaveAttribute('aria-expanded', 'true')
    const failed = window.locator('[data-testid="tool-call"][data-status="failed"]')
    await expect(failed).toHaveCount(2)
    await failed.nth(0).getByRole('button').click()
    await failed.nth(1).getByRole('button').click()
    await expect(failed.nth(0)).toContainText('rejected')
    await expect(failed.nth(1)).toContainText('read-only')
    expect(await window.locator('body').innerText()).not.toContain(SECRET)
    expect(readFileSync(join(project, 'data', 'db.json'), 'utf8')).toBe('{"users":[]}\n')

    // 上下文占用：底部显示百分比，点开看总数
    await expect(window.getByTestId('context-usage')).toHaveText('上下文 1%')
    await window.getByTestId('context-usage').click()
    await expect(window.getByText('1k / 128k · 1%')).toBeVisible()
    await window.keyboard.press('Escape')
    await window.screenshot({ path: 'test-results/agent-session.png' })

    // 撤销这一轮：按钮在这一轮底部的操作栏里；先列出受影响的文件，确认后恢复
    await window.getByTestId('turn-actions').getByRole('button', { name: '撤销这一轮及之后的改动' }).click()
    const list = window.getByTestId('restore-list')
    await expect(list).toContainText('hello.txt')
    await expect(list).toContainText('done.txt')
    await expect(window.getByTestId('restore-confirm')).toHaveText('撤销 2 个文件')
    await expect(window.getByRole('dialog')).toContainText('不只是智能体改的')
    await window.getByTestId('restore-confirm').click()
    await expect(window.getByTestId('notice').filter({ hasText: '已撤销 2 个文件的改动' })).toBeVisible()
    await waitTaskStatus(window, 'unfinished')
    // 撤销过的这一轮底部不再写改了哪些文件
    await expect(window.getByTestId('turn-files')).toHaveCount(0)
    expect(readFileSync(join(project, 'hello.txt'), 'utf8')).toBe('hello world\n')
    expect(existsSync(join(project, 'done.txt'))).toBe(false)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
