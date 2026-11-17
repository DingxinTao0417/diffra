import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { BACK_KEY, chooseProject, cards, settingsNav, taskInput, waitTaskStatus } from './flows'
import { desktopDir, launchApp, makeUserDataDir } from './launch'

// core 单测也用的假外接智能体（ACP 服务端），用跑测试的这个 Node 启动
const FAKE_AGENT = resolve(desktopDir, '../core/test/fixtures/fake-acp-agent.mjs')
// 运行时拼出来，仓库里不出现完整的值
const SECRET = ['e2e', 'agent', 'secret', '7'].join('-')

async function openAgentSettings(window: Page): Promise<void> {
  if (!(await settingsNav(window).isVisible())) await window.getByTestId('sidebar').getByRole('button', { name: '设置', exact: true }).click()
  await settingsNav(window).getByRole('button', { name: '外接智能体' }).click()
}

async function send(window: Page, text: string): Promise<void> {
  await taskInput(window).fill(text)
  await window.getByRole('button', { name: '发送', exact: true }).click()
}

test('外接智能体：设置里检测出没装、版本不对和可用，添加、编辑、删除；新建任务选它，对话、确认、停止、崩溃都在任务页里，不用配 Diffra 的模型', async () => {
  test.setTimeout(120_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-external-'))
  // 「很久没有输出」的提示缩短到 1.5 秒
  const app = await launchApp(userDataDir, { DIFFRA_MODEL_SILENCE_MS: '1500' })
  try {
    const window = await app.firstWindow()
    await openAgentSettings(window)
    await expect(window.getByText('还没有添加外接智能体')).toBeVisible()
    // 四个预设各一行：本机装了的标「已装」，没装的给安装命令
    const presets = window.getByTestId('external-agent-preset')
    await expect(presets).toHaveCount(4)
    for (const name of ['Claude Code', 'Codex', 'Gemini CLI', 'Copilot CLI']) {
      const row = presets.filter({ hasText: name })
      await expect(row.getByText(/已装|没找到/)).toBeVisible({ timeout: 15_000 })
      if (await row.getByText(/没找到/).isVisible()) await expect(row).toContainText('安装：npm install -g')
    }
    await window.screenshot({ path: 'test-results/external-agents-presets.png' })

    // 自定义：先填一个不存在的命令，检测说没装
    await window.getByTestId('external-agent-presets').getByRole('button', { name: '添加' }).last().click()
    const form = window.getByRole('form', { name: '添加外接智能体' })
    await form.getByLabel('名称').fill('假智能体')
    await form.getByLabel('启动命令').fill('diffra-no-such-agent-cli')
    await form.getByRole('button', { name: '检测' }).click()
    await expect(form.getByText('没装', { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(form.getByTestId('external-detection')).toContainText('找不到命令「diffra-no-such-agent-cli」')

    // 像不认 --acp 的老版本：版本不对，带上它的输出
    await form.getByLabel('启动命令').fill(process.execPath)
    await form.getByLabel('参数').fill(FAKE_AGENT)
    await form.getByRole('button', { name: '添加环境变量' }).click()
    await form.getByLabel('变量名').fill('FAKE_ACP_MODE')
    await form.getByLabel('FAKE_ACP_MODE 的值').fill('old')
    await form.getByRole('button', { name: '检测' }).click()
    await expect(form.getByText('版本不对', { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(form.getByTestId('external-detection')).toContainText("unknown option '--acp'")

    // 换成正常启动，带一个像密钥的环境变量：检测可用，保存后设置文件和密钥文件里都没有明文
    await form.getByLabel('变量名').fill('FAKE_ACP_TOKEN')
    await form.getByLabel('FAKE_ACP_TOKEN 的值').fill(SECRET)
    await form.getByRole('button', { name: '检测' }).click()
    await expect(form.getByText('可用 · 1.2.3')).toBeVisible({ timeout: 20_000 })
    await expect(form.getByTestId('external-detection')).toContainText('能接着原来的对话')
    await form.getByRole('button', { name: '保存' }).click()
    const row = window.getByTestId('external-agent-row')
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('假智能体')
    await expect(row).toContainText('自定义')
    expect(readFileSync(join(userDataDir, 'settings.json'), 'utf8')).toContain('FAKE_ACP_TOKEN')
    expect(readFileSync(join(userDataDir, 'settings.json'), 'utf8')).not.toContain(SECRET)
    expect(readFileSync(join(userDataDir, 'secrets.json'), 'utf8')).not.toContain(SECRET)

    // 编辑：改名，值留空沿用已保存的
    await row.getByRole('button', { name: '编辑' }).click()
    const edit = window.getByRole('form', { name: '编辑 假智能体' })
    await expect(edit.getByLabel('FAKE_ACP_TOKEN 的值')).toHaveAttribute('placeholder', '已保存，留空不改')
    await edit.getByLabel('名称').fill('假智能体乙')
    await edit.getByRole('button', { name: '保存' }).click()
    await expect(row).toContainText('假智能体乙')
    await row.getByRole('button', { name: '检测' }).click()
    await expect(row.getByText('可用 · 1.2.3')).toBeVisible({ timeout: 20_000 })
    await window.screenshot({ path: 'test-results/external-agents-settings.png' })

    // 首页：没配 Diffra 的模型，模型菜单里选外接智能体
    await window.keyboard.press(BACK_KEY)
    await chooseProject(app, window, project)
    await window.getByTestId('model-menu').click()
    await window.getByTestId('external-agent-list').getByRole('menuitem', { name: /假智能体乙/ }).click()
    await expect(window.getByTestId('model-menu')).toContainText('假智能体乙')
    await send(window, '你好')
    await expect(window.getByTestId('task-title')).toBeVisible()
    await expect(window.getByText('收到：你好')).toBeVisible({ timeout: 20_000 })
    await waitTaskStatus(window, 'done')
    // 任务中途不能换成别的模型；斜杠菜单里没有目标、计划和压缩
    await expect(window.getByTestId('model-menu')).toBeDisabled()
    await taskInput(window).fill('/')
    await expect(window.getByRole('option', { name: /目标/ })).toHaveCount(0)
    await expect(window.getByRole('option', { name: /compact/ })).toHaveCount(0)
    await taskInput(window).fill('')

    // 它要确认的事走同一张确认卡
    await send(window, '问我')
    const permission = window.getByTestId('permission-card')
    await expect(permission).toContainText('运行 rm -rf build', { timeout: 20_000 })
    await permission.getByRole('button', { name: '允许', exact: true }).click()
    await expect(window.getByText('允许了')).toBeVisible({ timeout: 20_000 })

    // 它改文件：改动卡片照常显示，结论是已完成
    await send(window, '写文件 hello.txt 来自外接智能体')
    await expect(cards(window, 'edit')).toHaveCount(1, { timeout: 20_000 })
    await waitTaskStatus(window, 'done')
    expect(readFileSync(join(project, 'hello.txt'), 'utf8')).toBe('来自外接智能体')

    // 停止：用同一个停止按钮
    await send(window, '卡住')
    await expect(window.getByText('开始干活')).toBeVisible({ timeout: 20_000 })
    // 很久没有输出：提示可能卡住了；它的请求在它自己那边，没有「重试这一步」
    await expect(window.getByTestId('model-silence')).toContainText('假智能体乙已', { timeout: 10_000 })
    await expect(window.getByTestId('model-silence').getByRole('button', { name: '重试这一步' })).toHaveCount(0)
    await window.getByRole('button', { name: '停止' }).click()
    await waitTaskStatus(window, 'stopped')

    // 进程崩溃：结论是出错，提示里带着它最后的输出，任务不卡在运行中
    await send(window, '崩溃')
    await waitTaskStatus(window, 'error')
    const notice = window.getByTestId('notice').last()
    await expect(notice).toContainText('进程退出了（退出码 3）')
    await expect(window.getByTestId('stop-summary').last()).toContainText('这一轮停在这里')
    await expect(window.getByRole('button', { name: '发送', exact: true })).toBeVisible()
    await window.screenshot({ path: 'test-results/external-agents-task.png' })

    // 任务监控里写的是哪个外接智能体，不提示找不到 Git Bash（命令由它自己跑）
    await expect(window.getByTestId('monitor-agent')).toContainText('假智能体乙')
    await expect(window.getByText('没找到 Git Bash')).toHaveCount(0)

    // 下一条消息重新起进程，接着做
    await send(window, '还在吗')
    await expect(window.getByText('收到：还在吗')).toBeVisible({ timeout: 20_000 })
  } finally {
    await app.close()
  }

  // 重启应用后打开旧任务：历史都在，接着它原来的会话（假智能体的进程是新起的，靠 session/load 接上）
  const reopened = await launchApp(userDataDir)
  try {
    const window = await reopened.firstWindow()
    await window.getByTestId('sidebar').getByText('你好', { exact: true }).click()
    await expect(window.getByText('收到：还在吗')).toBeVisible({ timeout: 20_000 })
    await expect(window.getByTestId('model-menu')).toContainText('假智能体乙')
    await send(window, '第几条')
    await expect(window.getByText('第 1 条')).toBeVisible({ timeout: 20_000 })
    await expect(window.getByText('回放的回答')).toHaveCount(0)

    // 删除：确认后设置里没了；旧任务还能打开看，再发消息时说明智能体不在了
    await openAgentSettings(window)
    await window.getByTestId('external-agent-row').getByRole('button', { name: '删除' }).click()
    await window.getByRole('alertdialog').getByRole('button', { name: '删除' }).click()
    await expect(window.getByTestId('external-agent-row')).toHaveCount(0)
    await expect(window.getByText('还没有添加外接智能体')).toBeVisible()
    await window.keyboard.press(BACK_KEY)
    await send(window, '还能做吗')
    await waitTaskStatus(window, 'error')
    await expect(window.getByTestId('notice').last()).toContainText('已经不在设置里')
    await expect(window.getByTestId('stop-summary').last().getByRole('button', { name: '打开外接智能体设置' })).toBeVisible()
    expect(existsSync(join(userDataDir, 'sessions'))).toBe(true)
  } finally {
    await reopened.close()
    rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
