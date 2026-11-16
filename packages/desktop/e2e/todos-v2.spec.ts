import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import type { Todo } from '../src/shared/todos'
import { type Device, freeUdpPort, lanEnv, launchDevice, openDevices, requestPairing } from './lan'
import { launchApp, makeUserDataDir } from './launch'

// 待办 v2（M8）：重复、嵌套标签、日历拖动、局域网同步
const localKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const at = (day: Date, hours: number) => {
  const date = new Date(day)
  date.setHours(hours, 0, 0, 0)
  return date
}
const addDays = (day: Date, days: number) => {
  const date = new Date(day)
  date.setDate(date.getDate() + days)
  return date
}
const base = { project: null, tags: [] as string[], createdAt: '2026-01-01T00:00:00.000Z', done: false, sentTo: null }
const seed = (userDataDir: string, todos: Array<Record<string, unknown>>) => writeFileSync(join(userDataDir, 'todos.json'), JSON.stringify({ version: 1, todos: todos.map((todo) => ({ ...base, ...todo })) }))
const saved = (userDataDir: string) => (JSON.parse(readFileSync(join(userDataDir, 'todos.json'), 'utf8')) as { todos: Todo[] }).todos
const savedTodo = (userDataDir: string, id: string) => saved(userDataDir).find((todo) => todo.id === id)
const openTodos = (window: Page) => window.getByTestId('sidebar').getByRole('button', { name: /待办/ }).click()

test('待办重复、嵌套标签、日历拖动：编辑里设成每天，勾完成只完成这一次、提醒挪到第二天；标签按 / 分层，选上一层连下面的都算；日历里拖到别的日子钟点不变，没定时间的拖进去定在早上 9 点', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const today = at(new Date(), 0)
  const tomorrow9 = at(addDays(today, 1), 9)
  // 拖去的那天和今天在同一个月里
  const target = addDays(today, today.getDate() <= 20 ? 3 : -3)
  seed(userDataDir, [
    { id: 'water', text: '浇花', schedule: { at: tomorrow9.toISOString(), action: { kind: 'remind' }, result: null } },
    { id: 'api', text: '写接口文档', tags: ['工作/项目A'] },
    { id: 'review', text: '评审设计稿', tags: ['工作/项目B'] },
    { id: 'food', text: '买菜', tags: ['生活'] },
    { id: 'move', text: '交周报', schedule: { at: at(today, 15).toISOString(), action: { kind: 'remind' }, result: null } },
    { id: 'loose', text: '想想周末去哪' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await openTodos(window)
    const rows = window.getByTestId('todo-row')
    await expect(rows).toHaveCount(6)

    // 重复：双击打开编辑，定了时间才有「重复」，选每天
    await rows.filter({ hasText: '浇花' }).getByTestId('todo-title').dblclick()
    const editor = window.getByTestId('todo-editor')
    await editor.getByRole('radiogroup', { name: '重复' }).getByRole('radio', { name: '每天' }).click()
    await editor.getByRole('button', { name: '保存' }).click()
    const water = rows.filter({ hasText: '浇花' })
    await expect(water.getByTestId('todo-repeat')).toContainText('每天')
    await expect.poll(() => savedTodo(userDataDir, 'water')?.schedule?.repeat).toEqual({ every: 'day', interval: 1, start: tomorrow9.toISOString() })
    // 勾完成：这一次做完，待办还在、提醒挪到再下一天的同一钟点
    await water.getByLabel('完成这一次：浇花').click()
    await expect.poll(() => savedTodo(userDataDir, 'water')?.schedule?.at).toBe(at(addDays(today, 2), 9).toISOString())
    expect(savedTodo(userDataDir, 'water')?.done).toBe(false)
    expect(savedTodo(userDataDir, 'water')?.schedule?.last?.kind).toBe('done')
    expect(savedTodo(userDataDir, 'water')?.updatedAt).toBeTruthy()
    await expect(water).toBeVisible()

    // 嵌套标签：第一层一直列出，选「工作」后展开下一层，两条都算；再选「项目A」只剩一条
    const tagFilters = window.getByTestId('todo-tag-filter')
    await expect(tagFilters).toHaveCount(2)
    await expect(window.locator('[data-testid="todo-tag-filter"][data-depth="0"]')).toHaveText(['#工作', '#生活'])
    await window.getByRole('button', { name: '#工作', exact: true }).click()
    await expect(rows).toHaveCount(2)
    await expect(window.locator('[data-testid="todo-tag-filter"][data-depth="1"]')).toHaveText(['↳ 项目A', '↳ 项目B'])
    await window.getByRole('button', { name: '#工作/项目A', exact: true }).click()
    await expect(rows).toHaveCount(1)
    await expect(rows).toContainText('写接口文档')
    await window.screenshot({ path: 'test-results/todos-v2-tags.png' })
    await window.getByRole('button', { name: '#工作/项目A', exact: true }).click()
    await expect(rows).toHaveCount(6)

    // 日历：把今天的「交周报」拖到另一天，还是下午 3 点；没定时间的拖进去定在那天早上 9 点
    await window.getByRole('radio', { name: '日历' }).click()
    const day = (date: Date) => window.locator(`[data-testid="calendar-day"][data-day="${localKey(date)}"]`)
    await day(today).getByTestId('calendar-item').filter({ hasText: '交周报' }).dragTo(day(target))
    await expect(day(target).getByTestId('calendar-item').filter({ hasText: '交周报' })).toBeVisible()
    await expect(day(today).getByTestId('calendar-item').filter({ hasText: '交周报' })).toHaveCount(0)
    await expect.poll(() => savedTodo(userDataDir, 'move')?.schedule?.at).toBe(at(target, 15).toISOString())
    await window.getByRole('region', { name: '未定时间' }).getByTestId('todo-row').filter({ hasText: '想想周末去哪' }).dragTo(day(target))
    await expect.poll(() => savedTodo(userDataDir, 'loose')?.schedule?.at).toBe(at(target, 9).toISOString())
    await expect(day(target).getByTestId('calendar-item')).toHaveCount(2)
    await window.screenshot({ path: 'test-results/todos-v2-calendar.png' })
  } finally {
    await app.close().catch(() => {})
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('局域网同步待办：被连接端配对时允许同步待办、连接端打开同步后两边的待办合在一起；一边新加、删掉的另一边几秒内跟上；定时发给任务的不同步', async () => {
  test.setTimeout(180_000)
  const [hostPort, guestPort] = [await freeUdpPort(), await freeUdpPort()]
  const hostDir = makeUserDataDir()
  const guestDir = makeUserDataDir()
  seed(hostDir, [{ id: 'milk', text: '主机记的：买牛奶', updatedAt: '2026-01-02T00:00:00.000Z' }])
  seed(guestDir, [
    { id: 'rent', text: '连接端记的：交房租' },
    { id: 'send', text: '定时发给任务的', schedule: { at: '2030-01-01T09:00:00.000Z', action: { kind: 'send', text: '定时发给任务的', target: { kind: 'new', project: null, design: false } }, result: null } },
  ])
  const devices: Device[] = []
  try {
    const host = await launchDevice(lanEnv(hostPort, guestPort), hostDir)
    devices.push(host)
    const guest = await launchDevice(lanEnv(guestPort, hostPort), guestDir)
    devices.push(guest)
    await requestPairing(host, guest, '主机')
    const request = host.window.getByTestId('pair-request')
    await request.getByRole('checkbox', { name: '允许同步待办' }).click()
    await request.getByRole('button', { name: '允许' }).click()
    await expect(host.window.getByTestId('grants')).toContainText('允许同步待办')

    // 连接端打开「同步待办」：马上同步一次
    const peer = guest.window.getByTestId('peers')
    await expect(peer.getByTestId('peer')).toContainText('主机')
    await expect(peer.getByTestId('device-online')).toBeVisible({ timeout: 15_000 })
    await expect(peer.getByTestId('peer-todos-sync')).toHaveCount(0)
    await peer.getByRole('switch', { name: '和「主机」同步待办' }).click()
    await expect(peer.getByTestId('peer-todos-sync')).toContainText('同步过', { timeout: 15_000 })
    await expect(peer.getByRole('switch', { name: '和「主机」同步待办' })).toBeChecked()
    await guest.window.waitForTimeout(300)
    await guest.window.screenshot({ path: 'test-results/todos-v2-sync-peer.png' })

    await guest.window.getByRole('button', { name: '返回' }).click()
    await openTodos(guest.window)
    const guestRows = guest.window.getByTestId('todo-row')
    await expect(guestRows.filter({ hasText: '主机记的：买牛奶' })).toBeVisible()
    await host.window.getByRole('button', { name: '返回' }).click()
    await openTodos(host.window)
    const hostRows = host.window.getByTestId('todo-row')
    await expect(hostRows.filter({ hasText: '连接端记的：交房租' })).toBeVisible()
    await expect(hostRows).toHaveCount(2)
    expect(saved(hostDir).map((todo) => todo.id).sort()).toEqual(['milk', 'rent'])

    // 被连接端新加一条：通知连接端马上来同步（不用等定时的 30 秒）
    const input = host.window.getByLabel('新待办')
    await input.fill('主机后来加的：修自行车')
    await input.press('Enter')
    await expect(guestRows.filter({ hasText: '主机后来加的：修自行车' })).toBeVisible({ timeout: 10_000 })

    // 连接端删掉一条：推给被连接端，那边也删掉、记下墓碑
    await guestRows.filter({ hasText: '主机记的：买牛奶' }).getByRole('button', { name: '删除' }).click()
    await expect(hostRows.filter({ hasText: '主机记的：买牛奶' })).toHaveCount(0, { timeout: 10_000 })
    const tombstones = JSON.parse(readFileSync(join(hostDir, 'todos-sync.json'), 'utf8')) as { deleted: Array<{ id: string }> }
    expect(tombstones.deleted.map((item) => item.id)).toEqual(['milk'])
    expect(saved(hostDir).some((todo) => todo.id === 'send')).toBe(false)
    expect(savedTodo(guestDir, 'send')).toBeTruthy()
    await host.window.screenshot({ path: 'test-results/todos-v2-sync-host.png' })

    // 连接端关掉同步：之后两边各改各的
    await openDevices(guest.window, '连接其他设备')
    await guest.window.getByTestId('peers').getByRole('switch', { name: '和「主机」同步待办' }).click()
    await expect(guest.window.getByTestId('peer-todos-sync')).toHaveCount(0)
    await input.fill('关掉同步以后加的')
    await input.press('Enter')
    await guest.window.waitForTimeout(4000)
    expect(saved(guestDir).some((todo) => todo.text === '关掉同步以后加的')).toBe(false)
  } finally {
    for (const device of devices) {
      await device.app.close().catch(() => {})
      rmSync(device.userDataDir, { recursive: true, force: true })
    }
  }
})
