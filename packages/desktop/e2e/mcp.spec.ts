import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, settingsNav, startTask, taskInput, waitTaskDone } from './flows'
import { desktopDir, launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startHttpMcpServer } from '../../core/test/fixtures/mcp-http-server.ts'
import { startScriptedModel } from './scripted-model'

// core 单测也用的测试服务器：echo / write_note / whoami / fail 四个工具，一个 review prompt
const MCP_SERVER = resolve(desktopDir, '../core/test/fixtures/mcp-server.mjs')
// 运行时拼出来，仓库里不出现完整的值
const TOKEN = ['e2e', 'mcp', 'token', '42'].join('-')

test('MCP：设置里添加服务器看到连接状态；任务里模型调它的工具，只读的不问、其他的问；斜杠菜单展开 prompt；停用后新任务不带它的工具', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-mcp-'))
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'mcp__demo__whoami', input: {} }] },
    { toolCalls: [{ name: 'mcp__demo__write_note', input: { text: 'from mcp' } }] },
    { text: '记好了' },
    { text: '这次没有 MCP 工具' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })

    // 添加服务器：用跑测试的这个 Node 启动，环境变量的值加密保存
    await window.keyboard.press('ControlOrMeta+,')
    await settingsNav(window).getByRole('button', { name: 'MCP 服务器' }).click()
    await window.getByRole('button', { name: '添加服务器' }).click()
    const dialog = window.getByRole('dialog')
    await dialog.getByLabel('名称').fill('demo')
    await dialog.getByLabel('命令').fill(process.execPath)
    await dialog.getByLabel('参数').fill(MCP_SERVER)
    await dialog.getByRole('button', { name: '添加环境变量' }).click()
    await dialog.getByLabel('环境变量名称').fill('DIFFRA_TEST_TOKEN')
    await dialog.getByLabel('环境变量的值').fill(TOKEN)
    await dialog.getByRole('button', { name: '保存' }).click()
    await expect(dialog).toBeHidden()
    const card = window.getByTestId('mcp-server-card')
    await expect(card.getByTestId('mcp-status')).toHaveText('已连接', { timeout: 30_000 })
    await expect(card.getByTestId('mcp-tools')).toHaveText('4 个工具 · 1 个提示词模板')
    await card.getByRole('button', { name: '查看' }).click()
    await expect(card.getByTestId('mcp-tool-list')).toContainText('whoami')
    await expect(card).toContainText('DIFFRA_TEST_TOKEN')
    await window.screenshot({ path: 'test-results/mcp-settings.png' })
    expect(readFileSync(join(userDataDir, 'settings.json'), 'utf8')).not.toContain(TOKEN)
    expect(readFileSync(join(userDataDir, 'secrets.json'), 'utf8')).not.toContain(TOKEN)

    // 编辑时值不回显，只显示已保存和「更换」；不改值保存，连接照旧
    await card.getByRole('button', { name: 'demo 服务器操作' }).click()
    await window.getByRole('menuitem', { name: '编辑' }).click()
    await expect(dialog.getByTestId('mcp-value-row')).toContainText('已保存')
    await expect(dialog.getByLabel('环境变量的值')).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: '更换环境变量 DIFFRA_TEST_TOKEN 的值' })).toBeVisible()
    await dialog.getByRole('button', { name: '保存' }).click()
    await expect(dialog).toBeHidden()
    await expect(card.getByTestId('mcp-status')).toContainText('已连接', { timeout: 30_000 })
    await window.getByRole('button', { name: '返回' }).click()

    await chooseProject(app, window, project)
    await startTask(window, '用 MCP 记一下')
    // whoami 声明了只读，直接调；write_note 要确认
    const permission = window.getByTestId('permission-card')
    await expect(permission).toContainText('调用 MCP demo · write_note', { timeout: 20_000 })
    await permission.getByRole('button', { name: '允许一次' }).click()
    await waitTaskDone(window)
    expect(readFileSync(join(project, 'note.txt'), 'utf8')).toBe('from mcp\n')
    expect(model.bodies()[0]).toContain('mcp__demo__whoami')

    await window.getByRole('button', { name: /执行工具 2 次/ }).click()
    const whoami = window.locator('[data-testid="tool-call"]').filter({ hasText: 'whoami' })
    await whoami.getByRole('button').click()
    await expect(whoami).toContainText(`token=${TOKEN}`)
    await expect(window.getByTestId('monitor-panel')).toContainText('4 个工具')
    await window.screenshot({ path: 'test-results/mcp-task.png' })

    // 斜杠菜单里的 MCP prompt：填参数后展开到输入框
    const input = taskInput(window)
    // 本机用户目录里也可能有叫 review 的 Skill，带上服务器名
    await input.pressSequentially('/demo:review')
    const option = window.getByRole('listbox', { name: '命令和 Skill' }).getByRole('option').filter({ hasText: 'demo:review' })
    await expect(option).toContainText('Review a file')
    await input.press('Enter')
    const promptDialog = window.getByRole('dialog')
    await expect(promptDialog).toContainText('demo:review')
    await promptDialog.getByLabel('file').fill('a.ts')
    await promptDialog.getByRole('button', { name: '放进输入框' }).click()
    await expect(input).toHaveValue('Please review a.ts')
    await input.fill('')

    // 停用后新任务不带它的工具
    await window.keyboard.press('ControlOrMeta+,')
    await settingsNav(window).getByRole('button', { name: 'MCP 服务器' }).click()
    await window.getByRole('switch', { name: '启用 demo' }).click()
    await expect(card.getByTestId('mcp-status')).toHaveText('已停用')
    await window.getByRole('button', { name: '返回' }).click()
    await window.getByTestId('sidebar').getByRole('button', { name: '新任务' }).click()
    await startTask(window, '再问一下')
    await waitTaskDone(window)
    expect(model.bodies()[3]).not.toContain('mcp__demo')
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('MCP 远程 HTTP：请求头的值加密保存；密钥不对时显示原因，改对后连上；任务里用它的工具，斜杠菜单展开它的 prompt', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-mcp-http-'))
  const httpToken = ['e2e', 'http', 'token', '7'].join('-')
  const remote = await startHttpMcpServer(httpToken)
  const model = await startScriptedModel([{ toolCalls: [{ name: 'mcp__remote__echo', input: { text: 'hi' } }] }, { text: '远程工具用过了' }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })

    // 先填错密钥：卡片上说明是 401
    await window.keyboard.press('ControlOrMeta+,')
    await settingsNav(window).getByRole('button', { name: 'MCP 服务器' }).click()
    await window.getByRole('button', { name: '添加服务器' }).click()
    const dialog = window.getByRole('dialog')
    await dialog.getByLabel('名称').fill('remote')
    await dialog.getByRole('radio', { name: '远程 HTTP' }).click()
    await dialog.getByLabel('地址').fill(remote.url)
    await dialog.getByRole('button', { name: '添加请求头' }).click()
    await dialog.getByLabel('请求头名称').fill('Authorization')
    await dialog.getByLabel('请求头的值').fill('Bearer wrong-token')
    await dialog.getByRole('button', { name: '保存' }).click()
    await expect(dialog).toBeHidden()
    const card = window.getByTestId('mcp-server-card')
    await expect(card).toContainText('HTTP')
    await expect(card.getByTestId('mcp-status')).toHaveText('连接失败', { timeout: 30_000 })
    await expect(card.getByTestId('mcp-error')).toContainText('HTTP 401，检查请求头里的密钥')
    await expect(card.getByTestId('mcp-error').getByRole('button', { name: '重试' })).toBeVisible()
    await window.screenshot({ path: 'test-results/mcp-http-failed.png' })

    // 改成对的密钥
    await card.getByRole('button', { name: 'remote 服务器操作' }).click()
    await window.getByRole('menuitem', { name: '编辑' }).click()
    await expect(dialog.getByRole('radio', { name: '远程 HTTP' })).toHaveAttribute('aria-checked', 'true')
    await expect(dialog.getByLabel('地址')).toHaveValue(remote.url)
    await dialog.getByRole('button', { name: '更换请求头 Authorization 的值' }).click()
    await dialog.getByLabel('请求头的值').fill(`Bearer ${httpToken}`)
    await dialog.getByRole('button', { name: '保存' }).click()
    await expect(dialog).toBeHidden()
    await expect(card.getByTestId('mcp-status')).toHaveText('已连接', { timeout: 30_000 })
    await expect(card.getByTestId('mcp-tools')).toHaveText('1 个工具 · 1 个提示词模板')
    await expect(card).toContainText('请求头：Authorization')
    expect(readFileSync(join(userDataDir, 'settings.json'), 'utf8')).not.toContain(httpToken)
    expect(readFileSync(join(userDataDir, 'secrets.json'), 'utf8')).not.toContain(httpToken)
    await window.getByRole('button', { name: '返回' }).click()

    // 声明只读的远程工具直接调
    await chooseProject(app, window, project)
    await startTask(window, '用一下远程工具')
    await waitTaskDone(window)
    await expect(window.getByTestId('permission-card')).toHaveCount(0)
    expect(model.bodies()[0]).toContain('mcp__remote__echo')
    expect(model.bodies()[1]).toContain('remote echo: hi')
    expect(remote.authorizations().at(-1)).toBe(`Bearer ${httpToken}`)

    const input = taskInput(window)
    await input.pressSequentially('/remote:summarize')
    await input.press('Enter')
    const promptDialog = window.getByRole('dialog')
    await promptDialog.getByLabel('topic').fill('MCP')
    await promptDialog.getByRole('button', { name: '放进输入框' }).click()
    await expect(input).toHaveValue('Summarize MCP')
  } finally {
    await app.close()
    await model.close()
    await remote.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
