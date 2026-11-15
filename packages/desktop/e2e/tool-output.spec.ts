import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { type ElectronApplication, expect, test } from '@playwright/test'
import { chooseProject, startTask, taskInput, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { exec, startScriptedModel } from './scripted-model'

const ESC = '\u001b'

// vitest 风格的输出：一条失败、两条通过，带颜色码
const VITEST_LOG = [
  `${ESC}[31m FAIL ${ESC}[39m src/math.test.ts > adds numbers`,
  `${ESC}[31mAssertionError: expected 3 to be 4${ESC}[39m`,
  '',
  ` Test Files  ${ESC}[1m${ESC}[31m1 failed${ESC}[39m${ESC}[22m (1)`,
  `      Tests  ${ESC}[1m${ESC}[31m1 failed${ESC}[39m${ESC}[22m | ${ESC}[1m${ESC}[32m2 passed${ESC}[39m${ESC}[22m (3)`,
  `   Duration  1.52s`,
].join('\n')

const SERVER_LOG = [`${ESC}[90m10:00:01${ESC}[39m ${ESC}[32mINFO${ESC}[39m 启动`, `${ESC}[90m10:00:02${ESC}[39m ${ESC}[31mERROR${ESC}[39m 连接被拒绝`].join('\n')

async function clipboard(app: ElectronApplication): Promise<string> {
  return (await app.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, '\n')
}

// 第 655 步：工具步骤展开后，测试结果有汇总和失败的用例、搜索结果按文件分组能跳到那一行、读文件按代码高亮、终端颜色保留
test('工具输出：测试汇总和修复提示词、搜索按文件分组能跳转、读文件高亮带行号、ANSI 颜色；复制输出不带颜色码', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-tool-output-'))
  mkdirSync(join(project, 'src'))
  writeFileSync(join(project, 'src', 'a.ts'), ['// 第一行', 'export const needle = 1', 'export function find() {', '  return needle', '}', ''].join('\n'))
  writeFileSync(join(project, 'src', 'b.ts'), ['import { needle } from "./a"', ''].join('\n'))
  writeFileSync(join(project, 'vitest.log'), VITEST_LOG)
  writeFileSync(join(project, 'server.log'), SERVER_LOG)
  const model = await startScriptedModel([
    { toolCalls: [exec('cat vitest.log')] },
    { toolCalls: [exec('grep -rn "needle" src')] },
    { toolCalls: [exec("sed -n '2,4p' src/a.ts")] },
    { toolCalls: [exec('cat server.log')] },
    { text: '看完了' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '看看测试和代码')
    await waitTaskDone(window)
    await window.getByTestId('tool-group').getByRole('button').first().click()
    const step = (command: string) => window.getByTestId('tool-call').filter({ hasText: command })

    // 测试：汇总、失败的用例；「填入修复提示词」把失败的用例填进输入框
    await step('cat vitest.log').getByRole('button').first().click()
    const test = step('cat vitest.log').getByTestId('tool-output')
    await expect(test).toHaveAttribute('data-view', 'test')
    await expect(test.getByTestId('test-summary')).toContainText('通过 2')
    await expect(test.getByTestId('test-summary')).toContainText('失败 1')
    await expect(test.getByTestId('test-failures')).toContainText('src/math.test.ts > adds numbers')
    await expect(test).toContainText('Exit code: 0')
    // 命令的用时写在顶上（第 659 步）
    await expect(test.getByTestId('command-duration')).toContainText('用时')
    await test.getByRole('button', { name: '填入修复提示词' }).click()
    await expect(taskInput(window)).toHaveValue(/- src\/math\.test\.ts > adds numbers/)
    await taskInput(window).fill('')
    // 原始输出照样在下面，颜色码换成了颜色
    await expect(test.getByTestId('terminal-output').locator('.text-destructive').first()).toContainText('FAIL')
    await expect(test.getByTestId('terminal-output')).not.toContainText('[31m')

    // 搜索：按文件分组，命中的词标出来；点一处在文件面板打开到那一行
    await step('grep -rn').getByRole('button').first().click()
    const search = step('grep -rn').getByTestId('tool-output')
    await expect(search).toHaveAttribute('data-view', 'search')
    await expect(search.getByTestId('search-file')).toHaveCount(2)
    await expect(search.getByTestId('search-hit')).toHaveCount(3)
    await expect(search.locator('mark').first()).toHaveText('needle')
    await search.getByTestId('search-hit').filter({ hasText: 'return needle' }).click()
    await expect(window.getByTestId('file-panel').locator('.cm-target-line')).toHaveText('  return needle')
    await window.getByRole('button', { name: '关闭面板' }).click()

    // 读文件：按代码高亮，行号从 2 开始
    await step("sed -n '2,4p'").getByRole('button').first().click()
    const read = step("sed -n '2,4p'").getByTestId('tool-output')
    await expect(read).toHaveAttribute('data-view', 'read')
    await expect(read.locator('.code-ln').first()).toHaveText('2')
    await expect(read.locator('.tok-keyword').first()).toHaveText('export')
    await expect(read).toContainText('第 2–4 行')

    // 日志：颜色保留；复制输出不带颜色码
    await step('cat server.log').getByRole('button').first().click()
    const log = step('cat server.log').getByTestId('tool-output')
    await expect(log).toHaveAttribute('data-view', 'text')
    await expect(log.locator('.text-destructive')).toHaveText('ERROR')
    await log.getByRole('button', { name: '复制输出' }).click()
    await expect.poll(() => clipboard(app)).toBe('10:00:01 INFO 启动\n10:00:02 ERROR 连接被拒绝')

    for (const scheme of ['light', 'dark'] as const) {
      await window.emulateMedia({ colorScheme: scheme })
      await test.screenshot({ path: `test-results/tool-output-test-${scheme}.png` })
      await search.screenshot({ path: `test-results/tool-output-search-${scheme}.png` })
    }
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

// psql 的对齐格式输出；测试里用 PATH 上的假 psql 打印它（本机不一定装了 PostgreSQL）
const PSQL_OUTPUT = [' id | name  | score', '----+-------+-------', '  1 | alice |    90', '  2 | bob   |    75', '(2 rows)'].join('\n')

const BUILD_LOG = [
  'vite v8.0.0 building for production...',
  'dist/index.html                  0.46 kB │ gzip:  0.30 kB',
  'dist/assets/index-abc.css       12.10 kB │ gzip:  3.20 kB',
  'dist/assets/vendor-def.js      420.50 kB │ gzip: 130.00 kB',
  'dist/assets/index-ghi.js        88.20 kB │ gzip: 30.10 kB',
  '(!) Some chunks are larger than 400 kB after minification.',
].join('\n')

const APP_LOG = ['2026-11-14 10:00:01 INFO 启动', '2026-11-14 10:00:02 WARN 慢查询 1200ms', '2026-11-14 10:00:03 ERROR 连接被拒绝', '    at connect (src/a.ts:1:5)'].join('\n')

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...args], { cwd, stdio: 'pipe' })

// 第 657 步：git（状态、提交、diff）、构建产物体积、HTTP 响应、数据库查询结果、带级别的日志各有自己的视图
test('工具输出（二）：git 状态和提交和 diff、构建产物体积、curl 的 HTTP 响应、psql 的查询表、带级别的日志', async () => {
  test.setTimeout(120_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-tool-output2-'))
  const bin = mkdtempSync(join(tmpdir(), 'diffra-e2e-bin-'))
  mkdirSync(join(project, 'src'))
  writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 1\n')
  git(project, 'init', '-q', '-b', 'main')
  git(project, 'add', '.')
  git(project, 'commit', '-q', '-m', '初始提交')
  writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 2\n')
  writeFileSync(join(project, 'src', 'new.ts'), 'export const b = 1\n')
  writeFileSync(join(project, 'build.log'), BUILD_LOG)
  writeFileSync(join(project, 'app.log'), APP_LOG)
  writeFileSync(join(bin, 'psql.out'), `${PSQL_OUTPUT}\n`)
  writeFileSync(join(bin, 'psql'), ['#!/bin/sh', `cat "$(dirname "$0")/psql.out"`, ''].join('\n'), { mode: 0o755 })
  const api = createServer((_request, response) => response.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 7, user: { name: 'alice' } })))
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(api.address() as AddressInfo).port}/users`
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
  const model = await startScriptedModel([
    { toolCalls: [exec('git status')] },
    { toolCalls: [exec('git log --oneline')] },
    { toolCalls: [exec('git diff')] },
    { toolCalls: [exec('cat build.log')] },
    { toolCalls: [exec(`curl -s -i -X POST ${url}`)] },
    { toolCalls: [exec('psql -c "select id, name, score from users"')] },
    { toolCalls: [exec('cat app.log')] },
    { text: '看完了' },
  ])
  const app = await launchApp(userDataDir, { [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ''}` })
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '看看项目状态')
    // 访问网络、不认识的命令要确认：都允许一次
    const permission = window.getByTestId('permission-card')
    const done = window.getByTestId('task-status').filter({ hasText: '已完成' })
    for (let index = 0; index < 4; index++) {
      await expect(permission.or(done)).toBeVisible({ timeout: 20_000 })
      if (await done.isVisible()) break
      // 第一个要确认的是 curl：确认卡写明「访问网络」（第 659 步）
      if (index === 0) {
        await expect(permission.getByTestId('permission-risk')).toHaveAttribute('data-level', 'medium')
        await expect(permission.getByTestId('permission-risk')).toContainText('访问网络')
        await permission.screenshot({ path: 'test-results/permission-risk.png' })
      }
      await permission.getByRole('button', { name: '允许一次' }).click()
      await expect(permission).toHaveCount(0)
    }
    await waitTaskDone(window)
    await window.getByTestId('tool-group').getByRole('button').first().click()
    const open = async (command: string) => {
      const step = window.getByTestId('tool-call').filter({ hasText: command }).first()
      await step.getByRole('button').first().click()
      return step.getByTestId('tool-output')
    }

    // git status：分支、未暂存和未跟踪分组，文件能点开
    const status = await open('git status')
    await expect(status).toHaveAttribute('data-view', 'git-status')
    await expect(status.getByTestId('git-status')).toContainText('main')
    await expect(status.getByTestId('git-group-unstaged')).toContainText('src/a.ts')
    await expect(status.getByTestId('git-group-untracked')).toContainText('src/new.ts')
    // git log：提交列表；git diff：红绿改动
    await expect(await open('git log --oneline')).toContainText('初始提交')
    const diff = await open('git diff')
    await expect(diff).toHaveAttribute('data-view', 'git-diff')
    await expect(diff.getByTestId('diff-block-lines')).toContainText('export const a = 2')
    // 构建产物：按体积排，最大的在最前；原始输出（带警告）也在
    const build = await open('cat build.log')
    await expect(build).toHaveAttribute('data-view', 'build')
    await expect(build.getByTestId('build-asset').first()).toContainText('vendor-def.js')
    await expect(build.getByTestId('terminal-output')).toContainText('larger than 400 kB')
    // HTTP：方法、状态码，JSON 正文是树
    const http = await open('curl -s -i -X POST')
    await expect(http).toHaveAttribute('data-view', 'http')
    await expect(http.getByTestId('http-response')).toContainText('POST')
    await expect(http.getByTestId('http-status')).toContainText('201')
    await expect(http.getByTestId('json-tree')).toContainText('alice')
    // 数据库：查询语句、行数，表能按列排序
    const query = await open('psql -c')
    await expect(query).toHaveAttribute('data-view', 'query')
    await expect(query.getByTestId('query-result')).toContainText('select id, name, score from users')
    await expect(query.getByTestId('query-result')).toContainText('(2 rows)')
    await query.getByRole('button', { name: /score/ }).click()
    await expect(query.getByTestId('rich-table-row').first()).toContainText('bob')
    // 日志：能按级别筛选，源码位置能点开
    const log = await open('cat app.log')
    await expect(log).toHaveAttribute('data-view', 'log')
    await log.getByTestId('log-filter-error').click()
    await expect(log.getByTestId('log-line')).toHaveCount(1)
    await log.getByTestId('log-filter-error').click()
    await log.getByTestId('log-source').click()
    await expect(window.getByTestId('file-panel').locator('.cm-target-line')).toHaveText('export const a = 2')

    for (const scheme of ['light', 'dark'] as const) {
      await window.emulateMedia({ colorScheme: scheme })
      await status.screenshot({ path: `test-results/tool-output-git-${scheme}.png` })
      await build.screenshot({ path: `test-results/tool-output-build-${scheme}.png` })
      await http.screenshot({ path: `test-results/tool-output-http-${scheme}.png` })
      await query.screenshot({ path: `test-results/tool-output-query-${scheme}.png` })
    }
  } finally {
    await app.close()
    await model.close()
    api.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
    rmSync(bin, { recursive: true, force: true })
  }
})
