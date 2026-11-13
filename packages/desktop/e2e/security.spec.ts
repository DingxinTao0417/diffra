import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { cards, chooseProject, settingsNav, startTask, taskInput, waitTaskDone, waitTaskStatus } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { addFile, exec, read, replaceLines, startScriptedModel } from './scripted-model'

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
      { toolCalls: [addFile('files.ts', FILES_TS)] },
      // 每次想结束这一轮都过结束门禁，打回后接着调模型
      { text: '加了读文件和计算' },
      { toolCalls: [replaceLines('files.ts', 'export const calc = (input: string) => eval(input)', 'export const calc = (input: string) => Number(input)')] },
      { text: '去掉了 eval' },
      {
        toolCalls: [
          replaceLines(
            'files.ts',
            'export const read = (name: string) => fs.readFileSync(path.join(UPLOAD, name))',
            'export const read = (name: string) => fs.readFileSync(path.join(UPLOAD, path.basename(name)))',
          ),
        ],
      },
      { text: '文件名限制在上传目录内' },
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
    ],
    { securityReplies: ['high | SEC-INJ-4 | files.ts:1 | 文件名来自外部，可以用 ../ 读到上传目录外的文件'] },
  )
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })

    // 安全设置：四项默认都开，各自写着什么时候查；关掉再打开会存下来
    await window.keyboard.press('ControlOrMeta+,')
    await settingsNav(window).getByRole('button', { name: '安全' }).click()
    const levels = window.getByTestId('security-levels')
    for (const name of ['静态检查', '轻量扫描', '深度扫描', '规范审查']) await expect(levels.getByRole('switch', { name })).toHaveAttribute('aria-checked', 'true')
    await expect(levels).toContainText('完成前自动')
    await expect(levels).toContainText('提交前询问')
    await levels.getByRole('switch', { name: '深度扫描' }).click()
    await expect(levels.getByRole('switch', { name: '深度扫描' })).toHaveAttribute('aria-checked', 'false')
    // 改了对已经打开的任务立即生效，提示里不带「新任务生效」
    await expect(window.getByRole('status').filter({ hasText: '已保存' })).toHaveText('已保存')
    await expect.poll(() => JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')).security.deepScan).toBe(false)
    await levels.getByRole('switch', { name: '深度扫描' }).click()
    await expect.poll(() => JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')).security.deepScan).toBe(true)
    await window.screenshot({ path: 'test-results/security-settings.png' })
    await window.getByRole('button', { name: '返回' }).click()

    await chooseProject(app, window, project)
    await startTask(window, '加一个读文件的函数和一个计算函数')
    await expect(cards(window, 'security')).toHaveCount(5, { timeout: 30_000 })
    await waitTaskDone(window)
    // 打回和通过都看安全检查的卡，对话里不再有完成卡（第 526 步）
    await expect(cards(window, 'finish')).toHaveCount(0)

    // 改的过程中不查；第一次完成：静态检查打回 eval；第二次：轻量扫描打回路径穿越；第三次通过
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
    expect(model.securityReviews()).toBe(2)
    expect(readFileSync(join(project, 'files.ts'), 'utf8')).toContain('path.basename(name)')
    await window.screenshot({ path: 'test-results/security-gate.png' })

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
    expect(model.requests()).toBe(10)
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test('设置里关掉的检查，已经打开的任务立即不再查；智能体提交前先问要不要深度扫描，选先扫描就停下这一轮、接着扫本任务的改动', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-security-live-'))
  const evalLine = (name: string) => `export const ${name} = (input: string) => eval(input)\n`
  const model = await startScriptedModel([
    // 第一轮：都开着，写了 eval 又改掉，完成前的检查都通过
    { toolCalls: [addFile('calc.ts', evalLine('calc'))] },
    { toolCalls: [replaceLines('calc.ts', 'export const calc = (input: string) => eval(input)', 'export const calc = (input: string) => Number(input)')] },
    { text: '加了计算' },
    // 第二轮：静态检查、轻量扫描、规范审查关了，写了 eval 也不查
    { toolCalls: [addFile('other.ts', evalLine('other'))] },
    { text: '加了另一个计算' },
    // 第三轮：要提交时先问深度扫描
    { toolCalls: [exec('git commit -m 加计算')] },
    // 接着跑的深度扫描
    {
      toolCalls: [
        {
          name: 'report',
          input: { summary: '看过了两个计算函数', findings: [{ severity: 'high', ruleId: 'SEC-INJ-2', path: 'other.ts', line: 1, problem: 'eval 执行外部输入', flow: 'other.ts:1 other', fix: '换成 Number' }] },
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
    await expect(cards(window, 'security')).toHaveCount(2)
    await expect(cards(window, 'review')).toHaveCount(1)

    // 任务开着时到设置里关掉三项
    await window.keyboard.press('ControlOrMeta+,')
    await settingsNav(window).getByRole('button', { name: '安全' }).click()
    const levels = window.getByTestId('security-levels')
    for (const name of ['静态检查', '轻量扫描', '规范审查']) {
      await levels.getByRole('switch', { name }).click()
      await expect(levels.getByRole('switch', { name })).toHaveAttribute('aria-checked', 'false')
    }
    await expect.poll(() => JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')).security).toEqual({ staticCheck: false, lightScan: false, deepScan: true, review: false })
    await window.getByRole('button', { name: '返回' }).click()

    await taskInput(window).fill('再加一个计算函数')
    await window.getByRole('button', { name: '发送', exact: true }).click()
    await expect(window.getByTestId('turn')).toHaveCount(2)
    await waitTaskStatus(window, 'done')
    await expect(cards(window, 'security')).toHaveCount(2)
    await expect(cards(window, 'review')).toHaveCount(1)
    expect(model.securityReviews()).toBe(1)
    expect(model.ruleReviews()).toBe(1)

    // 提交前先问；选先扫描：命令不执行，接着跑一轮本任务改动的深度扫描
    await taskInput(window).fill('提交一下')
    await window.getByRole('button', { name: '发送', exact: true }).click()
    const permission = window.getByTestId('permission-card')
    await expect(permission).toContainText('提交前先做一次深度扫描？')
    await expect(permission).toContainText('git commit -m 加计算')
    await window.screenshot({ path: 'test-results/security-deep-scan-ask.png' })
    await permission.getByRole('button', { name: '先做深度扫描' }).click()
    await expect(window.getByTestId('turn')).toHaveCount(4, { timeout: 15_000 })
    await expect(window.getByTestId('turn').nth(2).getByTestId('notice')).toContainText('提交前先做深度扫描')
    await expect(window.getByTestId('turn').nth(2).getByTestId('notice')).toContainText('这条命令没有执行')
    await expect(window.getByTestId('turn').last().getByTestId('user-message')).toHaveText('深度安全扫描 · 本任务改动')
    const report = cards(window, 'deep-scan')
    await expect(report).toHaveCount(1, { timeout: 30_000 })
    await expect(report.getByTestId('deep-scan-finding')).toContainText('eval 执行外部输入')
    expect(model.requests()).toBe(7)
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})
