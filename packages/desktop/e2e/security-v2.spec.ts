import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { cards, chooseProject, startTask, taskInput, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { addFile, replaceLines, startScriptedModel } from './scripted-model'

// 安全的 v2 部分（M10）：污点分析、依赖许可证、按项目的开关、更多安全检查（许可证、外部扫描器、动态测试）
// 装好了 left-pad（MIT）和 gpl-lib（GPL）；dependencies 是 package.json 里声明了的
function projectWithGplDependency(prefix: string, dependencies: Record<string, string>): string {
  const project = mkdtempSync(join(tmpdir(), prefix))
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'shop', license: 'MIT', dependencies }, null, 2))
  for (const [name, license] of [['left-pad', 'MIT'], ['gpl-lib', 'GPL-3.0-only']]) {
    mkdirSync(join(project, 'node_modules', name!), { recursive: true })
    writeFileSync(join(project, 'node_modules', name!, 'package.json'), JSON.stringify({ name, version: '1.0.0', license }))
  }
  return project
}

async function slash(window: Page, query: string, option: string): Promise<void> {
  await taskInput(window).pressSequentially(`/${query}`)
  await window.getByRole('listbox', { name: '命令和 Skill' }).getByRole('option').filter({ hasText: option }).click()
}

const SERVER = ["const fs = require('fs')", "const path = require('path')", '', 'exports.download = (req, res) => {', '  const name = req.query.name', '  res.send(fs.readFileSync(name))', '}', ''].join('\n')

test('完成前：污点分析打回请求参数直接当文件路径；新加的 GPL 依赖提醒；项目里关掉的轻量扫描和规范审查不跑，改了立即生效', async () => {
  test.setTimeout(120_000)
  const userDataDir = makeUserDataDir()
  const project = projectWithGplDependency('diffra-e2e-security-v2-', { 'left-pad': '^1.0.0' })
  const model = await startScriptedModel([
    { text: '看过了' },
    { toolCalls: [addFile('server.js', SERVER), replaceLines('package.json', '    "left-pad": "^1.0.0"', '    "left-pad": "^1.0.0",\n    "gpl-lib": "^1.0.0"')] },
    { text: '加了下载接口' },
    { toolCalls: [replaceLines('server.js', '  const name = req.query.name', '  const name = path.basename(String(req.query.name))')] },
    { text: '文件名只取最后一段' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '先看看')
    await waitTaskDone(window)

    // 项目设置：这个项目关掉轻量扫描和规范审查，其余跟设置
    await window.locator('header').getByRole('button', { name: '任务菜单' }).click()
    await window.getByRole('menuitem', { name: '项目设置' }).click()
    const section = window.getByTestId('project-security')
    await expect(section).toContainText('设置里开着')
    await section.getByRole('radiogroup', { name: '轻量扫描（这个项目）' }).getByRole('radio', { name: '关' }).click()
    await section.getByRole('radiogroup', { name: '规范审查（这个项目）' }).getByRole('radio', { name: '关' }).click()
    await window.screenshot({ path: 'test-results/security-v2-project.png' })
    await window.getByRole('button', { name: '保存项目设置' }).click()
    await expect.poll(() => JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')).projects[project]?.security).toEqual({ lightScan: false, review: false })

    // 同一个任务接着做：完成前静态检查里污点分析打回，许可证提醒；改好后通过
    await taskInput(window).fill('加一个下载文件的接口')
    await window.getByRole('button', { name: '发送', exact: true }).click()
    await waitTaskDone(window, 60_000)
    const security = cards(window, 'security')
    await expect(security.first()).toHaveAttribute('data-status', 'failed')
    await expect(security.first()).toContainText('SEC-INJ-4')
    await expect(security.first()).toContainText('污点分析')
    await expect(security.first()).toContainText('req.query')
    await expect(security.first()).toContainText('LICENSE-COPYLEFT')
    await expect(security.last()).not.toHaveAttribute('data-status', 'failed')
    // 这个项目关掉了轻量扫描：一次都没调评审模型
    expect(model.securityReviews()).toBe(0)
    expect(readFileSync(join(project, 'server.js'), 'utf8')).toContain('path.basename')
    await window.screenshot({ path: 'test-results/security-v2-gate.png' })
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('更多安全检查：依赖许可证列出 GPL 依赖、勾选后填进输入框；动态测试打本机服务发现反射 XSS；装了 Semgrep 才能用它扫；CodeQL 没装不能跑', async () => {
  test.setTimeout(120_000)
  const userDataDir = makeUserDataDir()
  const project = projectWithGplDependency('diffra-e2e-security-tools-', { 'left-pad': '^1.0.0', 'gpl-lib': '^1.0.0' })
  writeFileSync(join(project, 'server.js'), "app.get('/search', (req, res) => res.send('<p>' + req.query.q + '</p>'))\n")
  const fake = join(project, 'fake-semgrep.mjs')
  writeFileSync(
    fake,
    `if (process.argv.includes('--version')) { console.log('1.99.0'); process.exit(0) }
console.log(JSON.stringify({ results: [{ check_id: 'js.express.direct-response-write', path: 'server.js', start: { line: 1 }, extra: { message: 'Detected user input written directly to the response', severity: 'ERROR' } }], errors: [] }))`,
  )
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(url.pathname === '/search' ? `<p>${url.searchParams.get('q')}</p>` : '<p>首页</p>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const model = await startScriptedModel([{ text: '看过了' }])
  const app = await launchApp(userDataDir, { DIFFRA_SEMGREP_PATH: fake })
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '先看看')
    await waitTaskDone(window)
    const dialog = window.getByTestId('security-tools')

    // 依赖许可证
    await slash(window, '许可证', '安全 · 依赖许可证')
    await dialog.getByRole('button', { name: '开始扫描' }).click()
    const findings = dialog.getByTestId('security-tools-finding')
    await expect(findings).toHaveCount(1, { timeout: 30_000 })
    await expect(findings).toContainText('gpl-lib@1.0.0 是 GPL-3.0-only')
    await expect(dialog.getByTestId('security-tools-report')).toContainText('项目自己是 MIT')
    await dialog.getByRole('button', { name: '填进输入框（1）' }).click()
    await expect(taskInput(window)).toHaveValue(/许可证要处理[\s\S]*LICENSE-COPYLEFT package\.json gpl-lib/)
    await taskInput(window).fill('')

    // 动态测试：从代码里认出 /search，打本机服务
    await slash(window, '动态', '安全 · 动态测试')
    await expect(dialog.getByLabel('要探测的接口（一行一个，以 / 开头）')).toHaveValue('/search')
    await dialog.getByLabel('本机服务的地址').fill(base)
    await dialog.getByRole('button', { name: '开始测试' }).click()
    await expect(findings.filter({ hasText: 'SEC-OUT-1' })).toContainText('反射型 XSS', { timeout: 30_000 })
    await window.screenshot({ path: 'test-results/security-v2-dynamic.png' })
    await dialog.getByRole('button', { name: '关闭', exact: true }).first().click()

    // 外部扫描器：Semgrep（假的）装了，CodeQL 没装
    await slash(window, '扫描器', '安全 · 外部扫描器')
    await expect(dialog.getByTestId('scanner-status')).toContainText('1.99.0')
    await dialog.getByRole('radio', { name: /CodeQL/ }).click()
    await expect(dialog.getByTestId('scanner-status')).toContainText('本机没装 CodeQL')
    await expect(dialog.getByRole('button', { name: '开始扫描' })).toBeDisabled()
    await dialog.getByRole('radio', { name: /Semgrep/ }).click()
    await dialog.getByRole('button', { name: '开始扫描' }).click()
    await expect(findings).toContainText('direct-response-write', { timeout: 30_000 })
    await expect(findings).toContainText('高危')
  } finally {
    await app.close()
    await model.close()
    server.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
