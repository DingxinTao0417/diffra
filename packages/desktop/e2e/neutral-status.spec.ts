import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { exec, startScriptedModel } from './scripted-model'

// 第 638 步：命令失败、等你回答都不用警示色。命令失败的工具组前面是普通对勾、文字照常写几条失败；
// 提问卡片和顶栏、侧栏、对话里的「等待确认」都是普通配色，等待确认留着空心圈的形状
test('命令失败不显示感叹号；提问卡片和等待确认是普通配色，深浅主题都看', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-neutral-'))
  const model = await startScriptedModel([
    { toolCalls: [exec('ls no-such-dir'), exec('echo ok')] },
    { toolCalls: [{ name: 'ask_user', input: { questions: [{ question: '用哪种方案？', options: [{ label: '方案 A', description: '改得少' }, { label: '方案 B' }] }] } }] },
    { text: '按方案 A 做完了' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '看一下目录')

    const card = window.getByTestId('permission-card')
    await expect(card).toContainText('智能体想先问你一下')
    await expect(card).not.toHaveClass(/warning/)
    expect(await card.locator('.text-warning').count()).toBe(0)

    const group = window.getByTestId('tool-group').first()
    await expect(group).toContainText('执行工具 2 次 · 1 条命令失败')
    await expect(group.locator('.lucide-circle-alert')).toHaveCount(0)
    await expect(window.locator('[data-testid="tool-group"] .text-warning')).toHaveCount(0)

    const status = window.getByTestId('task-status')
    await expect(status).toHaveAttribute('data-tone', 'confirm')
    await expect(status).not.toHaveClass(/warning/)
    await expect(window.locator('.border-warning')).toHaveCount(0)
    await window.screenshot({ path: 'test-results/neutral-status-light.png' })
    await window.emulateMedia({ colorScheme: 'dark' })
    // 换主题有颜色过渡，等它走完再截
    await window.waitForTimeout(500)
    await window.screenshot({ path: 'test-results/neutral-status-dark.png' })
    await window.emulateMedia({ colorScheme: 'light' })

    await card.getByRole('button', { name: '方案 A', exact: true }).click()
    await waitTaskDone(window)
    await expect(window.getByText('按方案 A 做完了')).toBeVisible()
    // 展开工具组：失败的那条命令前面也是普通对勾
    await group.getByRole('button').first().click()
    const failed = window.locator('[data-testid="tool-call"][data-succeeded="false"]')
    await expect(failed).toHaveCount(1)
    await expect(failed.locator('.lucide-circle-alert')).toHaveCount(0)
    await expect(failed.locator('.lucide-check')).toHaveCount(1)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
