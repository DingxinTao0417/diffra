import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { cards, chooseProject, settingsNav, startTask, taskInput, waitTaskDone, waitTaskStatus } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { addFile, exec, read, startScriptedModel } from './scripted-model'

const FILES_TS = [
  'export const read = (name: string) => fs.readFileSync(path.join(UPLOAD, name))',
  'export const calc = (input: string) => eval(input)',
  '',
].join('\n')

test('安全设置只剩深度扫描；改了代码结束时不再自动查；深度扫描出报告，勾选后交给智能体修', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-security-'))
  const model = await startScriptedModel([
    { toolCalls: [addFile('files.ts', FILES_TS)] },
    // 只回文字，这一轮就结束：写了 eval 和路径拼接，Diffra 也不再自动跑安全检查
    { text: '加了读文件和计算' },
    // 深度扫描：只读的命令
    { toolCalls: [exec('grep -n readFileSync files.ts')] },
    { toolCalls: [read('files.ts')] },
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
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })

    // 安全设置：只剩深度扫描一个开关，默认开，写着什么时候查；关掉再打开会存下来
    await window.keyboard.press('ControlOrMeta+,')
    await settingsNav(window).getByRole('button', { name: '安全' }).click()
    const levels = window.getByTestId('security-levels')
    await expect(levels.getByRole('switch')).toHaveCount(1)
    await expect(levels.getByRole('switch', { name: '深度扫描' })).toHaveAttribute('aria-checked', 'true')
    await expect(levels).toContainText('提交前询问')
    await levels.getByRole('switch', { name: '深度扫描' }).click()
    await expect(levels.getByRole('switch', { name: '深度扫描' })).toHaveAttribute('aria-checked', 'false')
    // 改了对已经打开的任务立即生效，提示里不带「新任务生效」
    await expect(window.getByRole('status').filter({ hasText: '已保存' })).toHaveText('已保存')
    await expect.poll(() => JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')).security).toEqual({ deepScan: false })
    await levels.getByRole('switch', { name: '深度扫描' }).click()
    await expect.poll(() => JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')).security).toEqual({ deepScan: true })
    await window.screenshot({ path: 'test-results/security-settings.png' })
    await window.getByRole('button', { name: '返回' }).click()

    await chooseProject(app, window, project)
    await startTask(window, '加一个读文件的函数和一个计算函数')
    await waitTaskDone(window)
    await expect(cards(window, 'security')).toHaveCount(0)
    expect(model.requests()).toBe(2)

    // 深度扫描：确认后跑一轮只读审计，出报告；这一轮没有「重新生成」
    // 第 529 步起任务监控里没有扫描按钮，从输入框的斜杠菜单发起
    await taskInput(window).pressSequentially('/扫描')
    await window.getByRole('listbox', { name: '命令和 Skill' }).getByRole('option').filter({ hasText: '深度扫描 · 本任务改动' }).click()
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
    expect(model.requests()).toBe(6)
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test('智能体提交前先问要不要深度扫描，选先扫描就停下这一轮、接着扫本任务的改动', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-security-live-'))
  const model = await startScriptedModel([
    // 第一轮：写了 eval，结束时不再自动查
    { toolCalls: [addFile('calc.ts', 'export const calc = (input: string) => eval(input)\n')] },
    { text: '加了计算' },
    // 第二轮：要提交时先问深度扫描
    { toolCalls: [exec('git commit -m 加计算')] },
    // 接着跑的深度扫描
    {
      toolCalls: [
        {
          name: 'report',
          input: { summary: '看过了计算函数', findings: [{ severity: 'high', ruleId: 'SEC-INJ-2', path: 'calc.ts', line: 1, problem: 'eval 执行外部输入', flow: 'calc.ts:1 calc', fix: '换成 Number' }] },
        },
      ],
    },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '加一个计算函数')
    await waitTaskStatus(window, 'done')
    await expect(cards(window, 'security')).toHaveCount(0)

    // 提交前先问；选先扫描：命令不执行，接着跑一轮本任务改动的深度扫描
    await taskInput(window).fill('提交一下')
    await window.getByRole('button', { name: '发送', exact: true }).click()
    const permission = window.getByTestId('permission-card')
    await expect(permission).toContainText('提交前先做一次深度扫描？')
    await expect(permission).toContainText('git commit -m 加计算')
    await window.screenshot({ path: 'test-results/security-deep-scan-ask.png' })
    await permission.getByRole('button', { name: '先做深度扫描' }).click()
    await expect(window.getByTestId('turn')).toHaveCount(3, { timeout: 15_000 })
    await expect(window.getByTestId('turn').nth(1).getByTestId('notice')).toContainText('提交前先做深度扫描')
    await expect(window.getByTestId('turn').nth(1).getByTestId('notice')).toContainText('这条命令没有执行')
    await expect(window.getByTestId('turn').last().getByTestId('user-message')).toHaveText('深度安全扫描 · 本任务改动')
    const report = cards(window, 'deep-scan')
    await expect(report).toHaveCount(1, { timeout: 30_000 })
    await expect(report.getByTestId('deep-scan-finding')).toContainText('eval 执行外部输入')
    expect(model.requests()).toBe(4)
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})
