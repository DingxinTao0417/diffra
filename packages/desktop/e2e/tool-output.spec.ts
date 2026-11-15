import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
