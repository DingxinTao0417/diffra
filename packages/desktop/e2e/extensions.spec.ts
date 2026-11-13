import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'
import { BACK_KEY, chooseProject, openExtensions, settingsNav, startTask, waitTaskDone } from './flows'
import { desktopDir, launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startHttpMcpServer } from '../../core/test/fixtures/mcp-http-server.ts'
import { exec, startScriptedModel } from './scripted-model'

// core 单测也用的 stdio 测试服务器：假的 railway 命令启动的就是它
const MCP_SERVER = resolve(desktopDir, '../core/test/fixtures/mcp-server.mjs')

function write(path: string, content: string) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

function gitRepo(dir: string) {
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...args], { cwd: dir })
  git('init', '-q')
  git('add', '.')
  git('commit', '-q', '-m', 'plugins')
}

// PATH 去掉本机真装着 railway 的目录，前面加一个空的 bin：测试里往这里放假的 railway
function pathWithout(command: string, bin: string): Record<string, string> {
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : ['']
  const dirs = (process.env[key] ?? '').split(delimiter).filter((dir) => dir && !extensions.some((extension) => existsSync(join(dir, `${command}${extension}`))))
  return { [key]: [bin, ...dirs].join(delimiter) }
}

function fakeRailway(bin: string) {
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'railway.cmd'), `@"${process.execPath}" "${MCP_SERVER}" %*\r\n`)
  } else {
    writeFileSync(join(bin, 'railway'), `#!/bin/sh\nexec "${process.execPath}" "${MCP_SERVER}" "$@"\n`)
    chmodSync(join(bin, 'railway'), 0o755)
  }
}

test('扩展：目录里的 MCP 一键装，Key 不对不保存、改对后连上才装；缺 railway 命令时提示，装好后重新检测能装本地服务；设置里不再有 MCP 和插件两页', async () => {
  test.setTimeout(120_000)
  const userDataDir = makeUserDataDir()
  const bin = mkdtempSync(join(tmpdir(), 'diffra-e2e-bin-'))
  const token = ['e2e', 'catalog', 'token', '9'].join('-')
  const remote = await startHttpMcpServer(token)
  const app = await launchApp(userDataDir, { ...pathWithout('railway', bin), DIFFRA_CATALOG_OVERRIDES: JSON.stringify({ mcp: { github: { url: remote.url } } }) })
  try {
    const window = await app.firstWindow()
    await openExtensions(window, '推荐')
    const view = window.getByTestId('extensions-view')
    await expect(view.getByRole('heading', { name: '接上常用服务' })).toBeVisible()
    await expect(view.getByRole('heading', { name: '更好的工作方法' })).toBeVisible()
    const vercel = view.getByTestId('catalog-mcp').filter({ hasText: 'Vercel' })
    await expect(vercel.getByRole('button', { name: '下一版支持' })).toBeDisabled()
    await window.screenshot({ path: 'test-results/extensions-recommended.png' })
    // 按名称、说明搜目录
    const search = view.getByLabel('搜索扩展')
    await search.fill('报错')
    await expect(view.getByTestId('catalog-mcp')).toHaveText([/Sentry/])
    await expect(view.getByTestId('catalog-plugin')).toHaveCount(0)
    await search.fill('没有这种扩展')
    await expect(view).toContainText('没有匹配「没有这种扩展」的扩展')
    await search.fill('')

    // GitHub：原地展开，只填一个 Token；填错连不上，什么都不存
    const github = view.getByTestId('catalog-mcp').filter({ hasText: 'GitHub' })
    await github.getByRole('button', { name: '安装 GitHub' }).click()
    const form = github.getByRole('form', { name: '安装 GitHub' })
    await expect(form).toContainText('不在本机运行程序')
    await form.getByLabel('GitHub Token').fill('wrong-token')
    await form.getByRole('button', { name: '安装并测试' }).click()
    await expect(form.getByTestId('catalog-install-error')).toContainText('HTTP 401', { timeout: 30_000 })
    await window.screenshot({ path: 'test-results/extensions-install-failed.png' })
    expect(JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')).mcpServers).toEqual([])
    await form.getByLabel('GitHub Token').fill(token)
    await form.getByRole('button', { name: '安装并测试' }).click()
    await expect(github).toContainText('已安装', { timeout: 30_000 })
    expect(remote.authorizations().at(-1)).toBe(`Bearer ${token}`)
    expect(readFileSync(join(userDataDir, 'settings.json'), 'utf8')).not.toContain(token)
    expect(readFileSync(join(userDataDir, 'secrets.json'), 'utf8')).not.toContain(token)

    // Railway 要本机的 railway 命令：没有时说缺什么、不能装；放上假的再检测就能装
    await openExtensions(window, 'MCP')
    const railway = view.getByTestId('catalog-mcp').filter({ hasText: 'Railway' })
    await expect(railway.getByTestId('catalog-missing')).toContainText('没检测到 railway 命令')
    await expect(railway.getByRole('button', { name: '安装 Railway' })).toHaveCount(0)
    await window.screenshot({ path: 'test-results/extensions-mcp.png' })
    fakeRailway(bin)
    await railway.getByRole('button', { name: '重新检测' }).click()
    await expect(railway.getByTestId('catalog-missing')).toHaveCount(0)
    await railway.getByRole('button', { name: '安装 Railway' }).click()
    const railwayForm = railway.getByRole('form', { name: '安装 Railway' })
    await expect(railwayForm).toContainText('在本机运行 railway mcp。')
    await expect(railwayForm).toContainText('railway login')
    await railwayForm.getByRole('button', { name: '安装并测试' }).click()
    await expect(railway).toContainText('已安装', { timeout: 30_000 })

    // 已安装：两个都连上了；GitHub 带着加密的请求头
    await openExtensions(window, '已安装')
    const rows = view.getByTestId('mcp-server-card')
    await expect(rows).toHaveCount(2)
    await expect(rows.filter({ hasText: 'github' }).getByTestId('mcp-status')).toHaveText('已连接', { timeout: 30_000 })
    await expect(rows.filter({ hasText: 'github' })).toContainText('请求头：Authorization')
    await expect(rows.filter({ hasText: 'railway' }).getByTestId('mcp-status')).toHaveText('已连接', { timeout: 30_000 })
    await expect(rows.filter({ hasText: 'railway' }).getByTestId('mcp-tools')).toHaveText('4 个工具 · 1 个提示词模板')
    await window.screenshot({ path: 'test-results/extensions-installed.png' })

    // 设置里没有这两页了
    await window.keyboard.press('ControlOrMeta+,')
    await expect(settingsNav(window).getByRole('button', { name: '模型与角色' })).toBeVisible()
    await expect(settingsNav(window).getByRole('button', { name: 'MCP 服务器' })).toHaveCount(0)
    await expect(settingsNav(window).getByRole('button', { name: '插件', exact: true })).toHaveCount(0)
  } finally {
    await app.close()
    await remote.close()
    rmSync(bin, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('扩展：目录里的插件只取仓库里那个子目录；带钩子的先给看命令，取消不留克隆；允许后钩子在任务里运行（会话开始的说明、拦下命令），撤销后不再运行；插件的子智能体能派', async () => {
  test.setTimeout(150_000)
  const userDataDir = makeUserDataDir()
  const workspace = mkdtempSync(join(tmpdir(), 'diffra-e2e-ext-plugins-'))
  const project = join(workspace, 'project')
  mkdirSync(project)
  // 一个放了多个插件的仓库（像官方插件市场），只装其中的 feature-dev
  const market = join(workspace, 'market')
  write(join(market, 'plugins', 'feature-dev', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'feature-dev', version: '1.0.0' }))
  write(join(market, 'plugins', 'feature-dev', 'commands', 'feature-dev.md'), '---\ndescription: 开发一个功能\n---\n按步骤开发 $ARGUMENTS')
  write(join(market, 'plugins', 'feature-dev', 'agents', 'code-explorer.md'), '---\nname: code-explorer\ndescription: 读代码弄清一个功能怎么实现\ntools: Glob, Grep, LS, Read\nmodel: sonnet\n---\n追踪调用链')
  write(join(market, 'plugins', 'feature-dev', 'agents', 'code-architect.md'), '---\nname: code-architect\ndescription: 设计功能怎么实现\ntools: Glob, Grep, Read\n---\n出实现方案')
  write(join(market, 'plugins', 'other', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'other' }))
  write(join(market, 'plugins', 'other', 'commands', 'x.md'), 'x')
  gitRepo(market)
  // 带钩子的插件：会话开始时给一段说明（Claude Code 的 JSON 写法）；执行命令前拦下 deploy
  const powers = join(workspace, 'superpowers')
  write(join(powers, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'superpowers', version: '7.0.0' }))
  write(join(powers, 'skills', 'using-superpowers', 'SKILL.md'), '---\nname: using-superpowers\ndescription: 怎么用这些 Skill\n---\n先想再做')
  write(join(powers, 'hooks', 'session-start'), `#!/usr/bin/env bash\necho '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"POWERS-CONTEXT-OK"}}'\n`)
  write(
    join(powers, 'hooks', 'hooks.json'),
    JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: 'startup|clear|compact', hooks: [{ type: 'command', command: 'bash "${CLAUDE_PLUGIN_ROOT}/hooks/session-start"' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'input=$(cat); case "$input" in *deploy*) echo "POWERS-BLOCKED-DEPLOY" >&2; exit 2;; esac' }] }],
      },
    }),
  )
  gitRepo(powers)
  const overrides = {
    plugins: {
      'feature-dev': { repo: pathToFileURL(market).href, path: 'plugins/feature-dev' },
      superpowers: { repo: pathToFileURL(powers).href, path: null },
    },
  }
  const model = await startScriptedModel([{ toolCalls: [exec('echo deploy')] }, { text: '拦下了' }, { text: '这次没有钩子' }])
  const app = await launchApp(userDataDir, { DIFFRA_CATALOG_OVERRIDES: JSON.stringify(overrides) })
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await openExtensions(window, '插件')
    const view = window.getByTestId('extensions-view')
    await expect(view.getByRole('heading', { name: '服务商的官方 Skill' })).toBeVisible()

    // 没有钩子的直接装：只检出 plugins/feature-dev，别的插件不下来
    const featureDev = view.getByTestId('catalog-plugin').filter({ hasText: 'Feature Dev' })
    await featureDev.getByRole('button', { name: '安装 Feature Dev' }).click()
    await expect(featureDev).toContainText('已安装', { timeout: 30_000 })
    const pluginsRoot = join(userDataDir, 'plugins')
    const clones = readdirSync(pluginsRoot).filter((name) => name !== '.staging')
    expect(clones).toHaveLength(1)
    expect(existsSync(join(pluginsRoot, clones[0]!, 'plugins', 'feature-dev', 'agents', 'code-explorer.md'))).toBe(true)
    expect(existsSync(join(pluginsRoot, clones[0]!, 'plugins', 'other'))).toBe(false)

    // 带钩子的：先列出会自动运行的命令；取消时取回的克隆删掉
    const superpowers = view.getByTestId('catalog-plugin').filter({ hasText: 'Superpowers' })
    await superpowers.getByRole('button', { name: '安装 Superpowers' }).click()
    const review = superpowers.getByTestId('plugin-review')
    await expect(review).toContainText('它会在这些时候自动运行命令', { timeout: 30_000 })
    await expect(review.getByTestId('plugin-hooks')).toContainText('会话开始时')
    await expect(review.getByTestId('plugin-hooks')).toContainText('调用工具前（执行命令）')
    await expect(review.getByTestId('plugin-hooks')).toContainText('POWERS-BLOCKED-DEPLOY')
    await window.screenshot({ path: 'test-results/extensions-plugin-review.png' })
    await review.getByRole('button', { name: '取消' }).click()
    await expect(review).toHaveCount(0)
    await expect.poll(() => readdirSync(join(pluginsRoot, '.staging'))).toEqual([])
    await superpowers.getByRole('button', { name: '安装 Superpowers' }).click()
    await review.getByRole('checkbox').click()
    await review.getByRole('button', { name: '安装', exact: true }).click()
    await expect(superpowers).toContainText('已安装', { timeout: 30_000 })

    // 已安装：内容和钩子状态
    await openExtensions(window, '已安装')
    const installed = view.getByTestId('plugin-card')
    await expect(installed.filter({ hasText: 'feature-dev' }).getByTestId('plugin-contents')).toContainText('1 个命令 · 2 个子智能体')
    const powersRow = installed.filter({ hasText: 'superpowers' })
    await expect(powersRow.getByTestId('plugin-contents')).toContainText('1 个 Skill · 2 个钩子，钩子已允许')
    await powersRow.getByRole('button', { name: '查看' }).click()
    await expect(powersRow.getByTestId('plugin-detail')).toContainText(pathToFileURL(powers).href)
    await window.screenshot({ path: 'test-results/extensions-installed-plugins.png' })
    await window.keyboard.press(BACK_KEY)

    // 任务里：会话开始的说明进了系统提示词，插件的子智能体能派（只读），执行 deploy 被钩子拦下
    await chooseProject(app, window, project)
    await startTask(window, '部署一下')
    await waitTaskDone(window)
    expect(model.bodies()[0]).toContain('POWERS-CONTEXT-OK')
    expect(model.bodies()[0]).toContain('feature-dev:code-explorer (read-only)')
    expect(model.bodies()[1]).toContain('Blocked by a hook of the superpowers plugin: POWERS-BLOCKED-DEPLOY')

    // 撤销允许：新任务不再带它的说明
    await openExtensions(window, '已安装')
    await powersRow.getByRole('button', { name: '查看' }).click()
    await powersRow.getByTestId('plugin-detail').getByRole('checkbox').click()
    await expect(powersRow.getByTestId('plugin-contents')).toContainText('钩子没允许，不会运行')
    await window.getByTestId('sidebar').getByRole('button', { name: '新任务' }).click()
    await startTask(window, '再来')
    await waitTaskDone(window)
    expect(model.bodies()[2]).not.toContain('POWERS-CONTEXT-OK')
  } finally {
    await app.close()
    await model.close()
    rmSync(workspace, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
