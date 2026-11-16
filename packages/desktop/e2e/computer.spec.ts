import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel, openModelCapabilities, openModelsPage } from './model-setup'
import { startScriptedModel } from './scripted-model'

const computer = (input: Record<string, unknown>) => ({ toolCalls: [{ name: 'computer', input }] })

// 电脑操控用假驱动（DIFFRA_COMPUTER_DRIVER=fake）：不动真的鼠标键盘，操作记进文件；假屏幕 1600×900
test('电脑操控：默认关、第一次打开先确认；看屏幕问一次、动鼠标键盘每一步都问，拒绝了不执行；截图发给模型；操作记录在设置里，输入的文字只记字数；关掉后马上不能用', async () => {
  test.setTimeout(180_000)
  const userDataDir = makeUserDataDir()
  const workspace = mkdtempSync(join(tmpdir(), 'diffra-e2e-computer-'))
  const project = join(workspace, 'project')
  execFileSync('git', ['init', '-q', project])
  writeFileSync(join(project, 'README.md'), '项目')
  const log = join(workspace, 'input.log')
  const model = await startScriptedModel([
    computer({ action: 'screenshot' }),
    computer({ action: 'double_click', x: 640, y: 360 }),
    computer({ action: 'type', text: '秘密口令123\n' }),
    computer({ action: 'key', keys: 'Ctrl+S' }),
    { text: '保存好了' },
    computer({ action: 'screenshot' }),
    { text: '没看成' },
  ])
  const app = await launchApp(userDataDir, { DIFFRA_COMPUTER_DRIVER: 'fake', DIFFRA_COMPUTER_LOG: log })
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await openModelsPage(window)
    const capabilities = await openModelCapabilities(window, '脚本模型', 'scripted')
    await capabilities.getByRole('checkbox', { name: '视觉', exact: true }).click()
    await capabilities.getByRole('button', { name: '保存模型能力', exact: true }).click()
    await expect(capabilities).toBeHidden()

    // 设置：默认关；第一次打开先讲清楚，取消不开，确认才开
    await window.getByRole('navigation', { name: '设置分区' }).getByRole('button', { name: '浏览器与电脑操控' }).click()
    const toggle = window.getByRole('switch', { name: '让智能体操作这台电脑' })
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(window.getByTestId('computer-audit')).toContainText('还没有操作记录')
    await toggle.click()
    const dialog = window.getByRole('alertdialog')
    await expect(dialog).toContainText('让智能体操作这台电脑？')
    await dialog.getByRole('button', { name: '先不开' }).click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await toggle.click()
    await dialog.getByRole('button', { name: '我明白了，打开' }).click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect.poll(() => (JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')) as { computerUse?: unknown }).computerUse).toEqual({ enabled: true, acknowledged: true })
    await window.screenshot({ path: 'test-results/computer-settings.png' })
    await window.getByRole('button', { name: '返回' }).click()

    // 任务：看屏幕问一次；双击、输入、按键每一步都问；按键这步拒绝
    await chooseProject(app, window, project)
    await startTask(window, '在桌面上把文件保存一下')
    const permission = window.getByTestId('permission-card')
    await expect(permission).toContainText('让智能体看你的屏幕', { timeout: 30_000 })
    await expect(permission.getByRole('button', { name: '本会话允许看屏幕' })).toBeVisible()
    await permission.getByRole('button', { name: '允许一次' }).click()
    await expect(permission).toContainText('让智能体操作你的电脑：在 (640, 360) 双击')
    await expect(permission.getByRole('button', { name: '本会话允许看屏幕' })).toHaveCount(0)
    await permission.getByRole('button', { name: '允许这一步' }).click()
    await expect(permission).toContainText('输入「秘密口令123')
    await permission.getByRole('button', { name: '允许这一步' }).click()
    await expect(permission).toContainText('按 Ctrl+S')
    await permission.getByRole('button', { name: '拒绝' }).click()
    await waitTaskDone(window, 30_000)

    // 驱动收到的：双击换算到假屏幕（截图 1280×720 → 屏幕 1600×900），第二下带 clicks 2；文字和回车分开；没按 Ctrl+S
    const ops = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(ops).toEqual([
      { op: 'move', x: 800, y: 450 },
      { op: 'button', button: 'left', down: true, clicks: 1 },
      { op: 'button', button: 'left', down: false, clicks: 1 },
      { op: 'button', button: 'left', down: true, clicks: 2 },
      { op: 'button', button: 'left', down: false, clicks: 2 },
      { op: 'text', text: '秘密口令123' },
      { op: 'key', key: 'enter', down: true },
      { op: 'key', key: 'enter', down: false },
    ])
    // 截图跟在工具结果后面发给了模型
    const bodies = model.bodies()
    expect(bodies.some((body) => body.includes('截图 1280×720') && body.includes('image'))).toBe(true)
    expect(bodies.some((body) => body.includes('did not allow this computer action'))).toBe(true)

    // 操作记录：输入的文字只记字数
    await window.getByTestId('sidebar').getByRole('button', { name: '设置', exact: true }).click()
    await window.getByRole('navigation', { name: '设置分区' }).getByRole('button', { name: '浏览器与电脑操控' }).click()
    const audit = window.getByTestId('computer-audit')
    await expect(audit.getByTestId('computer-audit-entry')).toHaveCount(3)
    await expect(audit).toContainText('截屏')
    await expect(audit).toContainText('双击 (640, 360)')
    await expect(audit).toContainText('输入 8 个字')
    await expect(audit).not.toContainText('秘密口令')
    expect(readFileSync(join(userDataDir, 'computer-audit.jsonl'), 'utf8')).not.toContain('秘密口令')

    // 关掉：已经开着的任务再要截屏，客户端直接拒绝；操作记录能清空
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await window.getByRole('button', { name: '返回' }).click()
    await window.getByLabel('任务', { exact: true }).fill('再看一眼屏幕')
    await window.getByRole('button', { name: '发送', exact: true }).click()
    await expect(permission).toContainText('让智能体看你的屏幕', { timeout: 30_000 })
    await permission.getByRole('button', { name: '允许一次' }).click()
    await expect.poll(() => model.bodies().some((body) => body.includes('电脑操控在设置里关掉了')), { timeout: 30_000 }).toBe(true)
    await window.getByTestId('sidebar').getByRole('button', { name: '设置', exact: true }).click()
    await window.getByRole('navigation', { name: '设置分区' }).getByRole('button', { name: '浏览器与电脑操控' }).click()
    await audit.getByRole('button', { name: '刷新' }).click()
    await expect(audit.getByTestId('computer-audit-entry').first()).toHaveAttribute('data-ok', 'false')
    await audit.getByRole('button', { name: '清空记录' }).click()
    await expect(audit).toContainText('还没有操作记录')
    expect(existsSync(join(userDataDir, 'computer-audit.jsonl')) ? readFileSync(join(userDataDir, 'computer-audit.jsonl'), 'utf8') : '').toBe('')
  } finally {
    await app.close()
    await model.close()
    rmSync(workspace, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
