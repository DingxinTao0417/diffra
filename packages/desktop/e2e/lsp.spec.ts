import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { answerOpenDialog, chooseProject, openExtensions, startTask, waitTaskDone } from './flows'
import { desktopDir, launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { addFile, replaceLines, startScriptedModel } from './scripted-model'

const FAKE_LSP = resolve(desktopDir, '../core/test/fixtures/fake-lsp.mjs')

function write(path: string, content: string) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

test('扩展：插件的语言服务器——改完文件把错误给智能体；崩了自动重启并提示；任务监控里看状态、出错的文件，能停止和启动', async () => {
  test.setTimeout(150_000)
  const userDataDir = makeUserDataDir()
  const workspace = mkdtempSync(join(tmpdir(), 'diffra-e2e-lsp-'))
  const project = join(workspace, 'project')
  write(join(project, 'README.md'), '项目')
  execFileSync('git', ['init', '-q'], { cwd: project })
  // 只带语言服务器的插件：管 .ts 文件，服务器是假的 LSP（含 ERROR 的行报错误、WARN 报警告，CRASH_ONCE 崩一次）
  const plugin = join(workspace, 'lsp-kit')
  write(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'kit', version: '1.0.0' }))
  write(
    join(plugin, '.lsp.json'),
    JSON.stringify({ fake: { command: process.execPath, args: [FAKE_LSP], extensionToLanguage: { '.ts': 'typescript' }, env: { FAKE_LSP_MARK: join(workspace, 'crashed.mark') } } }),
  )
  const model = await startScriptedModel([
    { toolCalls: [addFile('src/a.ts', 'const a = 1\nconst b = ERROR\n')] },
    { toolCalls: [replaceLines('src/a.ts', 'const b = ERROR', 'const b = CRASH_ONCE')] },
    { toolCalls: [addFile('src/c.ts', '// WARN later')] },
    { text: '改好了' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await openExtensions(window, '已安装')
    await answerOpenDialog(app, plugin)
    await window.getByRole('button', { name: '从文件夹安装' }).click()
    const card = window.getByTestId('plugin-card').filter({ hasText: 'kit' })
    await expect(card.getByTestId('plugin-contents')).toContainText('1 个语言服务器')
    await card.getByRole('button', { name: '查看' }).click()
    await expect(card.getByTestId('plugin-detail')).toContainText('kit-fake')

    await window.getByTestId('sidebar').getByRole('button', { name: '新任务' }).click()
    await chooseProject(app, window, project)
    await startTask(window, '写两个文件')
    await waitTaskDone(window, 60_000)

    // 智能体拿到了诊断：第一次改完有一个错误
    const bodies = model.bodies()
    expect(bodies.some((body) => body.includes('Language server kit-fake reports 1 error(s) and 0 warning(s) in src/a.ts after this edit') && body.includes('src/a.ts:2:11 error: found ERROR on line 2 (fake E1)'))).toBe(true)
    // 崩了：提示用户一次，自动重启后照常给诊断
    await expect(window.getByText('语言服务器 kit-fake 崩溃了，正在重启')).toBeVisible()
    expect(bodies.some((body) => body.includes('Language server kit-fake reports 0 error(s) and 1 warning(s) in src/c.ts'))).toBe(true)

    // 任务监控：运行中、重启过一次，出问题的文件
    const server = window.getByTestId('lsp-server')
    await expect(server).toHaveAttribute('data-status', 'running')
    await expect(server.getByTestId('lsp-state')).toHaveText('运行中（重启过 1 次）')
    await expect(server.getByTestId('lsp-counts')).toHaveText('1 个警告')
    await expect(server.getByTestId('lsp-file')).toHaveCount(1)
    await expect(server.getByTestId('lsp-file')).toContainText('src/c.ts')
    await expect(server.getByTestId('lsp-file')).toContainText('1 行：found WARN')
    await window.getByTestId('monitor-panel').screenshot({ path: 'test-results/lsp-monitor.png' })

    // 停止：进程退出、诊断清空；启动后又在运行
    await server.getByRole('button', { name: '停止 kit-fake' }).click()
    await expect(server).toHaveAttribute('data-status', 'stopped')
    await expect(server.getByTestId('lsp-state')).toHaveText('已停止')
    await expect(server.getByTestId('lsp-file')).toHaveCount(0)
    await server.getByRole('button', { name: '启动 kit-fake' }).click()
    await expect(server).toHaveAttribute('data-status', 'running')
    await expect(server.getByTestId('lsp-state')).toHaveText('运行中')
  } finally {
    await app.close()
    await model.close()
    rmSync(workspace, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
