import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { chooseProject, settingsNav, taskInput, waitTaskStatus } from './flows'
import { launchApp, makeUserDataDir } from './launch'

// 外接智能体用本机真装、真登录过的 CLI（v2 · M1）：会走 npx 下载官方 ACP 适配器、用掉一点订阅额度，默认不跑，
// DIFFRA_E2E_REAL_AGENTS=1 才跑。只问一句话，不让它读写文件、跑命令
const REAL = process.env.DIFFRA_E2E_REAL_AGENTS === '1'

async function openAgentSettings(window: Page): Promise<void> {
  if (!(await settingsNav(window).isVisible())) await window.getByTestId('sidebar').getByRole('button', { name: '设置', exact: true }).click()
  await settingsNav(window).getByRole('button', { name: '外接智能体' }).click()
}

// 从预设添加：检测，返回检测结果的文字
async function addPreset(window: Page, preset: string): Promise<{ text: string; form: ReturnType<Page['getByRole']> }> {
  await openAgentSettings(window)
  const row = window.getByTestId('external-agent-preset').filter({ hasText: preset })
  await expect(row.getByText(/已装|没找到/)).toBeVisible({ timeout: 15_000 })
  await row.getByRole('button', { name: '添加' }).click()
  const form = window.getByRole('form', { name: '添加外接智能体' })
  await form.getByRole('button', { name: '检测' }).click()
  const detection = form.getByTestId('external-detection')
  await expect(detection).toBeVisible({ timeout: 150_000 })
  return { text: ((await detection.textContent()) ?? '').trim(), form }
}

for (const preset of ['Claude Code', 'Codex']) {
  test(`外接智能体（真的 CLI）：${preset} 经官方 ACP 适配器检测可用，新建任务问一句、拿到回复，没有改文件`, async () => {
    test.skip(!REAL, '要用本机装好、登录过的 CLI 和订阅额度：DIFFRA_E2E_REAL_AGENTS=1 才跑')
    test.setTimeout(420_000)
    const userDataDir = makeUserDataDir()
    const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-real-agent-'))
    execFileSync('git', ['init', '-q', project])
    writeFileSync(join(project, 'README.md'), '项目')
    const app = await launchApp(userDataDir)
    try {
      const window = await app.firstWindow()
      const { text, form } = await addPreset(window, preset)
      console.log(`${preset} 检测：${text}`)
      expect(text).toContain('已连上')
      await form.getByRole('button', { name: '保存' }).click()
      await expect(window.getByTestId('external-agent-row')).toHaveCount(1)
      await window.getByRole('button', { name: '返回' }).click()

      await chooseProject(app, window, project)
      await window.getByTestId('model-menu').click()
      await window.getByTestId('external-agent-list').getByRole('menuitem', { name: new RegExp(preset) }).click()
      await expect(window.getByTestId('model-menu')).toContainText(preset)
      await taskInput(window).fill('只回复两个字：好的。不要读写任何文件，不要运行任何命令。')
      await window.getByRole('button', { name: '发送', exact: true }).click()
      await expect(window.getByTestId('task-title')).toBeVisible()
      // 没改文件：结论是「没有改动」
      await waitTaskStatus(window, 'nochange', 300_000)
      const reply = window.getByTestId('turn').last().getByText(/好的/).last()
      await expect(reply).toBeVisible()
      console.log(`${preset} 回复：${(await reply.textContent())?.trim()}`)
      expect(readdirSync(project).sort()).toEqual(['.git', 'README.md'])
      await window.screenshot({ path: `test-results/external-real-${preset.replace(/\s+/g, '-').toLowerCase()}.png` })
    } finally {
      await app.close()
      rmSync(project, { recursive: true, force: true })
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })
}
