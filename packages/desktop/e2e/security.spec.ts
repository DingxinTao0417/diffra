import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { cards, chooseProject, settingsNav, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

const FILES_TS = [
  'export const read = (name: string) => fs.readFileSync(path.join(UPLOAD, name))',
  'export const calc = (input: string) => eval(input)',
  '',
].join('\n')

test('安全设置；静态检查和轻量扫描先后打回，改好后完成；深度扫描出报告，勾选后交给智能体修', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-security-'))
  const model = await startScriptedModel(
    [
      { toolCalls: [{ name: 'edit_file', input: { path: 'files.ts', old_string: '', new_string: FILES_TS } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '加了读文件和计算' } }] },
      { toolCalls: [{ name: 'edit_file', input: { path: 'files.ts', old_string: 'eval(input)', new_string: 'Number(input)' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '去掉了 eval' } }] },
      { toolCalls: [{ name: 'edit_file', input: { path: 'files.ts', old_string: 'path.join(UPLOAD, name)', new_string: 'path.join(UPLOAD, path.basename(name))' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '文件名限制在上传目录内' } }] },
      // 深度扫描
      { toolCalls: [{ name: 'search', input: { pattern: 'readFileSync' } }] },
      { toolCalls: [{ name: 'read_file', input: { path: 'files.ts' } }] },
      {
        toolCalls: [
          {
            name: 'report',
            input: {
              summary: '检查了读文件函数的调用链',
              findings: [{ severity: 'high', ruleId: 'SEC-AUTH-2', path: 'files.ts', line: 1, problem: '读文件没有登录校验', flow: 'files.ts:1 read', fix: '在路由上加登录校验' }],
            },
          },
        ],
      },
      // 按报告修
      { text: '已加上登录校验' },
    ],
    { securityReplies: ['high | SEC-INJ-4 | files.ts:1 | 文件名来自外部，可以用 ../ 读到上传目录外的文件'] },
  )
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })

    // 安全设置：三档默认都开，关掉再打开会存下来
    await window.keyboard.press('ControlOrMeta+,')
    await settingsNav(window).getByRole('button', { name: '安全' }).click()
    const levels = window.getByTestId('security-levels')
    for (const name of ['静态检查', '轻量扫描', '深度扫描']) await expect(levels.getByRole('switch', { name })).toHaveAttribute('aria-checked', 'true')
    await levels.getByRole('switch', { name: '深度扫描' }).click()
    await expect(levels.getByRole('switch', { name: '深度扫描' })).toHaveAttribute('aria-checked', 'false')
    // 深度扫描只控制入口，立即生效，提示里不带「新任务生效」
    await expect(window.getByRole('status').filter({ hasText: '已保存' })).toHaveText('已保存')
    await expect.poll(() => JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')).security.deepScan).toBe(false)
    await levels.getByRole('switch', { name: '深度扫描' }).click()
    await expect.poll(() => JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')).security.deepScan).toBe(true)
    await window.screenshot({ path: 'test-results/security-settings.png' })
    await window.getByRole('button', { name: '返回' }).click()

    await chooseProject(app, window, project)
    await startTask(window, '加一个读文件的函数和一个计算函数')
    const finishes = cards(window, 'finish')
    await expect(finishes).toHaveCount(3, { timeout: 30_000 })
    await waitTaskDone(window)

    // 第一次完成：静态检查打回 eval；第二次：轻量扫描打回路径穿越；第三次通过
    const security = cards(window, 'security')
    await expect(security).toHaveCount(5)
    await expect(security.nth(0)).toHaveAttribute('data-status', 'failed')
    await expect(security.nth(0)).toContainText('静态检查 · 1 处高危问题，已打回')
    await expect(security.nth(0)).toContainText('files.ts:2')
    await expect(security.nth(1)).toContainText('没有发现常见的高危写法')
    await expect(security.nth(2)).toHaveAttribute('data-status', 'failed')
    await expect(security.nth(2)).toContainText('轻量扫描 · 1 处高危问题，已打回')
    await expect(security.nth(2)).toContainText('SEC-INJ-4')
    await expect(security.nth(4)).toContainText('没有发现安全问题')
    await expect(finishes.nth(0)).toContainText('安全检查发现 1 处高危问题')
    await expect(finishes.nth(2)).toHaveAttribute('data-status', 'completed')
    expect(model.securityReviews()).toBe(2)
    expect(readFileSync(join(project, 'files.ts'), 'utf8')).toContain('path.basename(name)')
    await expect(window.getByTestId('monitor-panel')).toContainText('完成前自动检查')
    await window.screenshot({ path: 'test-results/security-gate.png' })

    // 深度扫描：确认后跑一轮只读审计，出报告；这一轮没有「重新生成」
    await window.getByRole('button', { name: '扫描本任务改动' }).click()
    await window.getByRole('button', { name: '开始扫描' }).click()
    const report = cards(window, 'deep-scan')
    await expect(report).toHaveCount(1, { timeout: 30_000 })
    await waitTaskDone(window)
    await expect(window.getByTestId('turn').last().getByTestId('user-message')).toHaveText('深度安全扫描 · 本任务改动')
    await expect(window.getByTestId('turn').last().getByRole('button', { name: '重新生成' })).toHaveCount(0)
    const finding = report.getByTestId('deep-scan-finding')
    await expect(finding).toHaveCount(1)
    await expect(finding).toContainText('读文件没有登录校验')
    await expect(finding.getByRole('checkbox')).toBeChecked()
    await window.screenshot({ path: 'test-results/security-deep-scan.png' })

    // 勾选的问题作为新的一轮发给编码模型
    await report.getByRole('button', { name: '修复选中的 1 个问题' }).click()
    await expect(window.getByTestId('turn')).toHaveCount(3)
    await expect(window.getByTestId('turn').last().getByTestId('user-message')).toContainText('[SEC-AUTH-2] files.ts:1 读文件没有登录校验')
    await expect(window.getByText('已加上登录校验')).toBeVisible({ timeout: 15_000 })
    expect(model.requests()).toBe(10)
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})
