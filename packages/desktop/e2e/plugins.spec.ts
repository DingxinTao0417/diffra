import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'
import { answerOpenDialog, chooseProject, settingsNav, taskInput, waitTaskDone } from './flows'
import { desktopDir, launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

const MCP_SERVER = resolve(desktopDir, '../core/test/fixtures/mcp-server.mjs')

function write(path: string, content: string) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

// Claude Code 格式的插件：命令、Skill、用插件根目录启动的 MCP 服务器，还有不支持的 agents
function makePlugin(dir: string) {
  write(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'kit', version: '1.0.0', description: '测试插件' }))
  write(join(dir, 'commands', 'greet.md'), '---\ndescription: 打招呼\nargument-hint: <名字>\n---\n跟 $ARGUMENTS 打个招呼')
  write(join(dir, 'skills', 'kit-style', 'SKILL.md'), '---\nname: kit-style\ndescription: 插件里的写作风格\n---\n回答前先说 KIT-OK')
  write(join(dir, 'agents', 'helper.md'), 'agent')
  copyFileSync(MCP_SERVER, join(dir, 'server.mjs'))
  write(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: ['${CLAUDE_PLUGIN_ROOT}/server.mjs'] } } }))
}

// 一个只有命令的插件，做成本地 git 仓库
function makeGitPlugin(dir: string) {
  write(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'git-kit' }))
  write(join(dir, 'commands', 'hello.md'), '你好')
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...args], { cwd: dir })
  git('init', '-q')
  git('add', '.')
  git('commit', '-q', '-m', 'plugin')
}

test('插件：从文件夹和 Git 安装，显示内容；删除 Git 插件连克隆一起删；斜杠菜单里的自定义命令、插件的 Skill 和 MCP 工具；停用后不再出现', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const workspace = mkdtempSync(join(tmpdir(), 'diffra-e2e-plugins-'))
  const project = join(workspace, 'project')
  const pluginDir = join(workspace, 'kit')
  const gitDir = join(workspace, 'git-kit')
  write(join(project, '.diffra', 'commands', 'diffra-fix.md'), '---\ndescription: 修一下\n---\n把报错修好')
  makePlugin(pluginDir)
  makeGitPlugin(gitDir)
  const model = await startScriptedModel([{ toolCalls: [{ name: 'mcp__kit-demo__echo', input: { text: 'hi' } }] }, { text: '好的' }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })

    await window.keyboard.press('Control+,')
    await settingsNav(window).getByRole('button', { name: '插件', exact: true }).click()
    await answerOpenDialog(app, pluginDir)
    await window.getByRole('button', { name: '从文件夹安装' }).click()
    const kit = window.getByTestId('plugin-card').filter({ hasText: 'kit' }).first()
    await expect(kit).toContainText('1.0.0')
    await expect(kit).toContainText('本地文件夹')
    await expect(kit.getByTestId('plugin-contents')).toContainText('/kit:greet')
    await expect(kit.getByTestId('plugin-contents')).toContainText('kit-style')
    await expect(kit.getByTestId('plugin-contents')).toContainText('kit-demo')
    await expect(kit).toContainText('已忽略：agents')

    // 从 Git 装：克隆到数据目录；删除时连克隆一起删
    await window.getByRole('button', { name: '从 Git 安装' }).click()
    const dialog = window.getByRole('dialog')
    await dialog.getByLabel('仓库地址').fill(pathToFileURL(gitDir).href)
    await dialog.getByRole('button', { name: '安装' }).click()
    await expect(dialog).toBeHidden({ timeout: 30_000 })
    const gitKit = window.getByTestId('plugin-card').filter({ hasText: 'git-kit' })
    await expect(gitKit).toContainText('/git-kit:hello')
    await expect(gitKit).toContainText('Git')
    expect(readdirSync(join(userDataDir, 'plugins'))).toHaveLength(1)
    await window.screenshot({ path: 'test-results/plugins-settings.png' })
    await gitKit.getByRole('button', { name: '删除' }).click()
    await gitKit.getByRole('button', { name: '确认删除' }).click()
    await expect(window.getByTestId('plugin-card')).toHaveCount(1)
    expect(readdirSync(join(userDataDir, 'plugins'))).toHaveLength(0)
    expect(existsSync(pluginDir)).toBe(true)
    await window.getByRole('button', { name: '返回' }).click()

    await chooseProject(app, window, project)
    const input = taskInput(window)
    const menu = window.getByRole('listbox', { name: '命令和 Skill' })
    const option = (name: string) => menu.getByRole('option').filter({ hasText: name })

    // 有参数的命令先填参数；没参数的直接放进输入框
    await input.pressSequentially('/kit:greet')
    await expect(option('kit:greet')).toContainText('插件')
    await input.press('Enter')
    const argsDialog = window.getByRole('dialog')
    await expect(argsDialog).toContainText('/kit:greet')
    await argsDialog.getByLabel('参数').fill('小明')
    await argsDialog.getByRole('button', { name: '放进输入框' }).click()
    await expect(input).toHaveValue('跟 小明 打个招呼')
    await input.fill('')
    await input.pressSequentially('/diffra-fix')
    await expect(option('diffra-fix')).toContainText('项目')
    await input.press('Enter')
    await expect(input).toHaveValue('把报错修好')
    await input.fill('')

    // 插件的 Skill 和 MCP 工具
    await input.pressSequentially('/kit-style')
    await input.press('Enter')
    await expect(window.getByTestId('composer-chip')).toHaveText(['kit-style'])
    await input.pressSequentially('试试插件')
    await window.getByRole('button', { name: '发送', exact: true }).click()
    await waitTaskDone(window)
    expect(model.bodies()[0]).toContain('回答前先说 KIT-OK')
    expect(model.bodies()[0]).toContain('mcp__kit-demo__echo')
    expect(model.bodies()[1]).toContain('echo: hi')

    // 停用后菜单里没有它的命令
    await window.keyboard.press('Control+,')
    await settingsNav(window).getByRole('button', { name: '插件', exact: true }).click()
    await window.getByRole('switch', { name: '启用 kit' }).click()
    await expect(window.getByRole('switch', { name: '启用 kit' })).toHaveAttribute('aria-checked', 'false')
    await window.getByRole('button', { name: '返回' }).click()
    await input.pressSequentially('/diffra')
    await expect(option('diffra-fix')).toBeVisible()
    await input.fill('')
    await input.pressSequentially('/kit:')
    await expect(menu).toBeHidden()
  } finally {
    await app.close()
    await model.close()
    rmSync(workspace, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
