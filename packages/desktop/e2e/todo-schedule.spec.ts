import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, test } from '@playwright/test'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

type Shown = { title: string; body: string }

// 系统通知不真的弹：记下标题和正文，留着对象好模拟点击
async function captureNotifications(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Notification }) => {
    const state = globalThis as unknown as { notifications: Electron.Notification[] }
    state.notifications = []
    Notification.prototype.show = function (this: Electron.Notification) {
      state.notifications.push(this)
    }
  })
}

function shownNotifications(app: ElectronApplication): Promise<Shown[]> {
  return app.evaluate(() => (globalThis as unknown as { notifications: Electron.Notification[] }).notifications.map((item) => ({ title: item.title, body: item.body })))
}

const localKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

test('定时待办：到点提醒弹系统通知，到点在后台发给新任务；应用没开时错过的提醒标逾期、错过的发送等用户点「现在发送」；点通知回到这条', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-todo-schedule-'))
  const model = await startScriptedModel([
    { match: '整理下载文件夹', text: '下载文件夹整理好了' },
    { match: '写周报', text: '周报写好了' },
  ])
  const now = Date.now()
  const iso = (offset: number) => new Date(now + offset).toISOString()
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(9, 0, 0, 0)
  const base = { project: null, createdAt: iso(-3_600_000), done: false, sentTo: null }
  writeFileSync(
    join(userDataDir, 'todos.json'),
    JSON.stringify({
      version: 1,
      todos: [
        { ...base, id: 'drink', text: '喝水', schedule: { at: iso(12_000), action: { kind: 'remind' }, result: null } },
        { ...base, id: 'tidy', text: '整理下载文件夹', schedule: { at: iso(15_000), action: { kind: 'send', text: '整理下载文件夹', target: { kind: 'new', project, design: false } }, result: null } },
        { ...base, id: 'report', text: '写周报', schedule: { at: iso(-86_400_000), action: { kind: 'send', text: '写周报', target: { kind: 'new', project, design: false } }, result: null } },
        { ...base, id: 'bill', text: '交水费', schedule: { at: iso(-7_200_000), action: { kind: 'remind' }, result: null } },
        { ...base, id: 'meet', text: '约牙医', schedule: { at: tomorrow.toISOString(), action: { kind: 'remind' }, result: null } },
        { ...base, id: 'idea', text: '试试新的配色' },
      ],
    }),
  )
  const app = await launchApp(userDataDir)
  try {
    await captureNotifications(app)
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await window.getByTestId('sidebar').getByRole('button', { name: /待办/ }).click()
    const rows = window.getByTestId('todo-row')
    const group = (name: string) => window.locator(`[data-testid="todo-group"][data-group="${name}"]`)

    // 应用没开时就到点的：提醒不补弹通知，标逾期；定时发送不自动补发
    await expect(group('overdue')).toContainText('交水费')
    await expect(rows.filter({ hasText: '写周报' }).getByTestId('todo-missed')).toContainText('错过了定时发送')
    await expect(group('tomorrow')).toContainText('约牙医')
    await expect(group('unscheduled')).toContainText('试试新的配色')
    await expect(window.getByTestId('sidebar-todo-due')).toBeVisible()

    // 到点：提醒弹通知；定时发送在后台建任务发出去，不切走当前页面
    await expect.poll(async () => (await shownNotifications(app)).map((item) => item.title), { timeout: 30_000 }).toContain('已按时发给任务「整理下载文件夹」')
    const shown = await shownNotifications(app)
    expect(shown).toContainEqual({ title: '待办到时间了', body: '喝水' })
    expect(shown.some((item) => item.body.includes('交水费'))).toBe(false)
    await expect(window.getByTestId('todos-view')).toBeVisible()
    await expect(group('overdue')).toContainText('喝水')
    await expect(rows.filter({ hasText: '整理下载文件夹' }).getByTestId('todo-sent')).toContainText('已派给 整理下载文件夹')
    await expect(window.getByTestId('sidebar')).toContainText('整理下载文件夹')

    // 错过的那条点「现在发送」
    const report = rows.filter({ hasText: '写周报' })
    await report.getByRole('button', { name: '现在发送' }).click()
    await expect(report.getByTestId('todo-sent')).toContainText('已派给 写周报')
    await expect(report.getByTestId('todo-missed')).toHaveCount(0)
    await expect.poll(() => model.requests(), { timeout: 15_000 }).toBe(2)

    // 在别的页面点提醒通知：回到待办页，那一条高亮
    await window.getByTestId('sidebar').getByRole('button', { name: '新任务' }).click()
    await expect(window.getByTestId('todos-view')).toHaveCount(0)
    await app.evaluate(() => {
      const items = (globalThis as unknown as { notifications: Electron.Notification[] }).notifications
      items.find((item) => item.title === '待办到时间了')?.emit('click')
    })
    await expect(window.getByTestId('todos-view')).toBeVisible()
    await expect(rows.filter({ hasText: '喝水' })).toHaveClass(/ring-1/)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('定时和日历：输入框先定提醒时间再记；一条改成定时发给新任务；日历里看到并在某天加一条；派给任务的列表最多露 5 行；问题条自己写的答案可以多行、点别处也算数', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const model = await startScriptedModel([
    {
      toolCalls: [
        {
          name: 'submit_prompt',
          input: { prompt: '买咖啡豆\n买两包。', questions: [{ question: '买几包？', options: [{ label: '两包', text: '买两包。' }, { label: '一包', text: '买一包。' }] }] },
        },
      ],
    },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await window.getByTestId('sidebar').getByRole('button', { name: /待办/ }).click()
    const rows = window.getByTestId('todo-row')
    const picker = window.getByTestId('schedule-picker')

    // 先定时间再记
    const input = window.getByLabel('新待办')
    await input.fill('买咖啡豆')
    await window.getByRole('button', { name: '定个提醒时间' }).click()
    await picker.getByRole('button', { name: '明早 9:00' }).click()
    await expect(window.getByTestId('todo-input-due')).toContainText('明天 09:00')
    await input.press('Enter')
    await expect(window.locator('[data-testid="todo-group"][data-group="tomorrow"]')).toContainText('买咖啡豆')
    // 列表里时间在每行左边一列：钟点和日子分两行
    await expect(rows.filter({ hasText: '买咖啡豆' }).getByTestId('todo-due')).toContainText('09:00')
    await expect(rows.filter({ hasText: '买咖啡豆' }).getByTestId('todo-due')).toContainText('明天')
    await expect(window.getByTestId('todo-input-due')).toHaveCount(0)

    // 一条没定时间的改成到时发给新任务
    await input.fill('准备周会材料')
    await input.press('Enter')
    const weekly = rows.filter({ hasText: '准备周会材料' })
    await weekly.hover()
    await weekly.getByRole('button', { name: '定时' }).click()
    await picker.getByRole('radio', { name: '到时发给任务…' }).click()
    await picker.getByRole('button', { name: '下周一 9:00' }).click()
    const dialog = window.getByTestId('send-todos')
    await expect(dialog).toContainText('定时发给任务')
    await expect(dialog.getByRole('button', { name: '只填入输入框' })).toHaveCount(0)
    await dialog.getByRole('button', { name: '定时发送' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(weekly).toContainText('发给 新任务')
    await expect(weekly.getByTestId('todo-due')).toContainText('09:00')

    // 右边一栏：数字、接下来的几条；点迷你月历里的明天，跳到日历视图的那天
    const side = window.getByTestId('todo-side-panel')
    await expect(side.getByTestId('todo-upcoming')).toContainText('买咖啡豆')
    const tomorrowKey = new Date()
    tomorrowKey.setDate(tomorrowKey.getDate() + 1)
    await side.locator(`[data-day="${localKey(tomorrowKey)}"]`).first().click()
    await expect(window.getByTestId('todo-calendar')).toBeVisible()
    await expect(window.getByTestId('calendar-selected')).toContainText('明天')
    await window.getByRole('radio', { name: '列表' }).click()

    // 日历：明天那格有这条；选中明天，在这天加一条
    await window.getByRole('radio', { name: '日历' }).click()
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const tomorrowCell = window.locator(`[data-testid="calendar-day"][data-day="${localKey(tomorrow)}"]`)
    await expect(tomorrowCell).toContainText('买咖啡豆')
    await tomorrowCell.click()
    await expect(window.getByTestId('calendar-selected')).toContainText('明天')
    const dayInput = window.getByTestId('todo-calendar').getByLabel('新待办')
    await expect(dayInput).toHaveAttribute('placeholder', /09:00 提醒/)
    await dayInput.fill('订会议室')
    await dayInput.press('Enter')
    await expect(tomorrowCell).toContainText('订会议室')
    const month = await window.getByTestId('calendar-month').textContent()
    await window.getByRole('button', { name: '下个月' }).click()
    await expect(window.getByTestId('calendar-month')).not.toHaveText(month ?? '')
    await window.getByRole('button', { name: '今天', exact: true }).click()
    await expect(window.getByTestId('calendar-month')).toHaveText(month ?? '')

    // 派给已有任务时的任务列表最多露 5 行（每行 2rem，加上下边框）
    await window.getByRole('radio', { name: '列表' }).click()
    const coffee = rows.filter({ hasText: '买咖啡豆' })
    await coffee.hover()
    await coffee.getByRole('button', { name: '发送给任务' }).click()
    await dialog.getByRole('radio', { name: '已有任务' }).click()
    const sizes = await dialog.getByRole('listbox', { name: '任务' }).evaluate((element) => {
      const page = globalThis as unknown as { getComputedStyle(target: unknown): { maxHeight: string; fontSize: string }; document: { documentElement: unknown } }
      return { max: page.getComputedStyle(element).maxHeight, rem: page.getComputedStyle(page.document.documentElement).fontSize }
    })
    expect(Number.parseFloat(sizes.max)).toBeCloseTo(5 * 2 * Number.parseFloat(sizes.rem) + 2, 1)

    // 优化后自己写答案：Shift+回车换行，点别处也算写完，按钮上显示写的答案
    await dialog.getByRole('button', { name: '优化' }).click()
    const content = dialog.getByLabel('要发的内容')
    await expect(content).toHaveValue('买咖啡豆\n买两包。')
    await dialog.getByRole('button', { name: '其他…' }).click()
    const answer = dialog.getByLabel('自己回答：买几包？')
    await answer.pressSequentially('先买一包')
    await answer.press('Shift+Enter')
    await answer.pressSequentially('好喝再买')
    await expect(answer).toHaveValue('先买一包\n好喝再买')
    await content.click()
    await expect(content).toHaveValue('买咖啡豆\n先买一包\n好喝再买')
    await expect(dialog.getByRole('button', { name: '先买一包 好喝再买' })).toHaveAttribute('aria-pressed', 'true')
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
