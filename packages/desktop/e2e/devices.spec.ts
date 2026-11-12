import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { createRelay, type Relay } from '../../relay/src/relay.ts'
import { chooseProject, settingsNav, startTask, taskInput, waitTaskDone, waitTaskStatus } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel, openModelsPage, providerCard } from './model-setup'
import { startScriptedModel } from './scripted-model'

// 设备连接：两个开发版实例（各自的临时数据目录）经测试进程里起的本机中转配对。不连真实的 relay.diffra.dev

interface Device {
  app: ElectronApplication
  window: Page
  userDataDir: string
}

async function startRelay(port = 0, log: (line: string) => void = () => {}): Promise<{ relay: Relay; port: number }> {
  const relay = createRelay({ host: '127.0.0.1', port, trustProxy: false, release: 'e2e', log })
  return { relay, port: await relay.listen() }
}

async function launchDevice(relayPort: number, env: Record<string, string> = {}): Promise<Device> {
  const userDataDir = makeUserDataDir()
  const app = await launchApp(userDataDir, { DIFFRA_RELAY_URL: `ws://127.0.0.1:${relayPort}/v1`, ...env })
  return { app, window: await app.firstWindow(), userDataDir }
}

async function openDevices(window: Page, tab: '连接其他设备' | '允许连接本机'): Promise<void> {
  if (!(await settingsNav(window).isVisible())) await window.getByTestId('sidebar').getByRole('button', { name: '设置', exact: true }).click()
  await settingsNav(window).getByRole('button', { name: '设备连接' }).click()
  await window.getByRole('radio', { name: tab }).click()
}

async function allowIncoming(window: Page): Promise<void> {
  await openDevices(window, '允许连接本机')
  // 同一台被连接端再配一台设备时开关已经开着
  const toggle = window.getByRole('switch', { name: '允许连接本机' })
  if (!(await toggle.isChecked())) await toggle.click()
  await expect(window.getByTestId('relay-status')).toHaveAttribute('data-state', 'online')
}

async function newInvite(window: Page): Promise<string> {
  await window.getByRole('button', { name: '生成邀请串' }).click()
  return ((await window.getByTestId('invite-text').textContent()) ?? '').trim()
}

// 连接端粘贴邀请串点添加；返回本机指纹（等对方确认时显示）
async function addDevice(window: Page, invite: string, name = ''): Promise<void> {
  await openDevices(window, '连接其他设备')
  await window.getByRole('button', { name: '添加设备' }).click()
  await window.getByLabel('邀请串').fill(invite)
  await window.getByLabel('显示名称').fill(name)
  await window.getByRole('button', { name: '添加', exact: true }).click()
}

async function close(devices: Device[]): Promise<void> {
  for (const device of devices) {
    await device.app.close()
    rmSync(device.userDataDir, { recursive: true, force: true })
  }
}

test('设备连接：邀请串配对，被连接端核对指纹、选项目后允许；两边看到对方在线；修改授权、重新配对显示原来的授权、撤销后连接端马上看到离线；中转重启后自动重连；私钥加密存放；连接端放弃配对时对方的确认弹窗收起，删除设备时对方一起撤销授权', async () => {
  test.setTimeout(150_000)
  let { relay, port } = await startRelay()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-devices-'))
  const host = await launchDevice(port)
  const guest = await launchDevice(port)
  try {
    await chooseProject(host.app, host.window, project)
    await allowIncoming(host.window)
    await host.window.getByLabel('本机名称').fill('主机')
    await host.window.getByLabel('本机名称').press('Enter')
    const invite = await newInvite(host.window)
    expect(invite).toMatch(/^diffra-[0-9A-Z-]+$/)

    await addDevice(guest.window, invite, '主机那台')
    const guestFingerprint = ((await guest.window.getByTestId('self-fingerprint').textContent()) ?? '').trim()
    expect(guestFingerprint).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/)

    // 被连接端在任何页面都弹出请求：指纹和连接端显示的一致；默认一个项目都不勾
    const request = host.window.getByTestId('pair-request')
    await expect(request).toBeVisible()
    await expect(request.getByTestId('pair-request-fingerprint')).toHaveText(guestFingerprint)
    await expect(request).not.toContainText('以前配对过')
    await request.getByRole('checkbox', { name: `开放 ${basename(project)}` }).click()
    await request.getByRole('radio', { name: '可查看和操作' }).click()
    await expect(request.getByRole('note')).toContainText('不是沙箱')
    await host.window.screenshot({ path: 'test-results/devices-pair-request.png' })
    await request.getByRole('button', { name: '允许' }).click()

    const peers = guest.window.getByTestId('peers')
    await expect(peers.getByTestId('peer')).toContainText('主机那台')
    await expect(peers.getByTestId('device-online')).toBeVisible()
    const grants = host.window.getByTestId('grants')
    await expect(grants.getByTestId('grant')).toBeVisible()
    await expect(grants.getByTestId('device-online')).toBeVisible()
    await expect(grants).toContainText(`${basename(project)}（可查看和操作）`)
    await expect(grants).toContainText(guestFingerprint)
    await host.window.screenshot({ path: 'test-results/devices-allow-tab.png' })
    await guest.window.screenshot({ path: 'test-results/devices-connect-tab.png' })

    // 私钥是 safeStorage 加密后的密文，不是明文的 PKCS#8（Ed25519 私钥的 base64 以 MC4CAQAwBQYDK2Vw 开头）
    for (const device of [host, guest]) {
      const identity = readFileSync(join(device.userDataDir, 'remote', 'identity.json'), 'utf8')
      expect(identity).not.toContain('MC4CAQAwBQYDK2Vw')
    }

    // 修改授权：改成只能看
    await grants.getByRole('button', { name: '修改授权' }).click()
    await host.window.getByRole('dialog').getByRole('radio', { name: '可查看', exact: true }).click()
    await host.window.getByRole('dialog').getByRole('button', { name: '保存' }).click()
    await expect(grants).toContainText(`${basename(project)}（可查看）`)

    // 重新配对：弹窗写明原来的授权，这次什么都不勾
    await addDevice(guest.window, await newInvite(host.window))
    await expect(request).toContainText(`以前配对过，原来的授权：${basename(project)}（可查看）`)
    await request.getByRole('button', { name: '允许' }).click()
    await expect(grants).toContainText('不开放任何项目')
    await expect(guest.window.getByRole('dialog')).toHaveCount(0)
    await expect(peers.getByTestId('peer')).toHaveCount(1)

    // 中转重启：两边自己重连，又看到对方在线；日志里记下断开的关闭码
    await relay.close()
    await expect(peers.getByTestId('device-offline')).toBeVisible()
    for (const device of [host, guest]) await expect.poll(() => readFileSync(join(device.userDataDir, 'logs', 'remote.log'), 'utf8')).toMatch(/和中转断开：\d+.*，连了 \d+ 秒/)
    ;({ relay } = await startRelay(port))
    await expect(peers.getByTestId('device-online')).toBeVisible({ timeout: 30_000 })
    await expect(grants.getByTestId('device-online')).toBeVisible({ timeout: 30_000 })

    // 撤销：连接端马上看到离线
    await grants.getByRole('button', { name: '撤销' }).click()
    await host.window.getByRole('alertdialog').getByRole('button', { name: '撤销' }).click()
    await expect(grants.getByTestId('grant')).toHaveCount(0)
    await expect(peers.getByTestId('device-offline')).toBeVisible()

    // 连接端等对方确认时放弃：被连接端的确认弹窗马上收起，不会留下授权
    await addDevice(guest.window, await newInvite(host.window))
    await expect(request).toBeVisible()
    await guest.window.getByRole('dialog').getByRole('button', { name: '取消' }).click()
    await expect(request).toHaveCount(0)
    await expect(host.window.getByTestId('invite-text')).toHaveCount(0)
    await expect(grants.getByTestId('grant')).toHaveCount(0)

    // 连接端删除设备：对方在线时一起撤销对方给本机的授权
    await expect(guest.window.getByRole('dialog')).toHaveCount(0)
    await addDevice(guest.window, await newInvite(host.window))
    await request.getByRole('button', { name: '允许' }).click()
    await expect(grants.getByTestId('grant')).toHaveCount(1)
    await expect(peers.getByTestId('device-online')).toBeVisible()
    await peers.getByRole('button', { name: '删除' }).click()
    await guest.window.getByRole('alertdialog').getByRole('button', { name: '删除' }).click()
    await expect(peers.getByTestId('peer')).toHaveCount(0)
    await expect(grants.getByTestId('grant')).toHaveCount(0)

    await host.window.getByRole('button', { name: '查看' }).click()
    const audit = host.window.getByTestId('audit')
    await expect(audit).toContainText('对方删除了本机，撤销授权')
    await expect(audit).toContainText('撤销授权')
    await expect(audit).toContainText('修改授权')
    await expect(audit).toContainText('允许配对')
  } finally {
    await close([host, guest])
    await relay.close()
    rmSync(project, { recursive: true, force: true })
  }
})

test('设备连接：抄错的、自己的、被拒绝的、用过的、过期的邀请串都配不上，提示原因', async () => {
  test.setTimeout(120_000)
  const { relay, port } = await startRelay()
  // 邀请串 8 秒过期，测过期用
  const host = await launchDevice(port, { DIFFRA_INVITE_TTL_SECONDS: '8' })
  const guest = await launchDevice(port)
  try {
    await allowIncoming(host.window)
    const error = guest.window.getByRole('dialog').getByRole('alert')

    // 抄错一位：本地就认出来，不连服务器
    const invite = await newInvite(host.window)
    const last = invite.at(-1) === '0' ? '1' : '0'
    await addDevice(guest.window, `${invite.slice(0, -1)}${last}`)
    await expect(error).toContainText('有字符抄错了')

    // 被连接端拒绝
    await guest.window.getByLabel('邀请串').fill(invite)
    await guest.window.getByRole('button', { name: '添加', exact: true }).click()
    await host.window.getByTestId('pair-request').getByRole('button', { name: '拒绝' }).click()
    await expect(error).toContainText('对方拒绝了这次配对')
    await expect(host.window.getByTestId('invite-text')).toHaveCount(0)

    // 用过的邀请串：会合点已经关了
    await guest.window.getByRole('button', { name: '添加', exact: true }).click()
    await expect(error).toContainText('邀请串已经失效')

    // 过期
    const expiring = await newInvite(host.window)
    await expect(host.window.getByTestId('invite-text')).toHaveCount(0, { timeout: 15_000 })
    await guest.window.getByLabel('邀请串').fill(expiring)
    await guest.window.getByRole('button', { name: '添加', exact: true }).click()
    await expect(error).toContainText('邀请串已经失效')

    // 自己的邀请串
    await guest.window.getByRole('dialog').getByRole('button', { name: '取消' }).click()
    // 等关闭动画走完：对话框开着时页面其余部分 aria-hidden，按角色找不到设置导航
    await expect(guest.window.getByRole('dialog')).toHaveCount(0)
    await allowIncoming(guest.window)
    const own = await newInvite(guest.window)
    await addDevice(guest.window, own)
    await expect(error).toContainText('本机自己的邀请串')

    await expect(guest.window.getByTestId('peers').getByTestId('peer')).toHaveCount(0)
    await expect(host.window.getByTestId('grants').getByTestId('grant')).toHaveCount(0)
  } finally {
    await close([host, guest])
    await relay.close()
  }
})

// 测试用的假密钥在运行时拼出来，仓库里不出现完整的密钥格式
const fakeKey = (prefix: string, body: string) => `${prefix}${body}`

// 被连接端开总开关、生成邀请串，连接端添加，被连接端勾 view（可查看）、controlled（可查看和操作）、full（完全控制）里的项目后允许
async function pair(host: Device, guest: Device, view: string[], controlled: string[] = [], full: string[] = []): Promise<void> {
  await allowIncoming(host.window)
  await addDevice(guest.window, await newInvite(host.window), '主机')
  const request = host.window.getByTestId('pair-request')
  for (const path of view) await request.getByRole('checkbox', { name: `开放 ${basename(path)}` }).click()
  for (const path of controlled) {
    await request.getByRole('checkbox', { name: `开放 ${basename(path)}` }).click()
    await request.getByRole('radiogroup', { name: `${basename(path)} 的权限` }).getByRole('radio', { name: '可查看和操作' }).click()
  }
  for (const path of full) {
    await request.getByRole('checkbox', { name: `开放 ${basename(path)}` }).click()
    await request.getByRole('radiogroup', { name: `${basename(path)} 的权限` }).getByRole('radio', { name: '完全控制' }).click()
    await expect(request.getByRole('note').filter({ hasText: '完全控制' })).toContainText('直接执行任意命令')
  }
  await request.getByRole('button', { name: '允许' }).click()
  await expect(guest.window.getByTestId('peers').getByTestId('device-online')).toBeVisible()
  await host.window.getByRole('button', { name: '返回' }).click()
  await guest.window.getByRole('button', { name: '返回' }).click()
}

// 在首页输入框上拖进一张 1x1 的 PNG。页面里跑的代码，e2e 的类型配置里没有 DOM 类型，写成字符串
const DROP_PIXEL = `(async () => {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  const data = new DataTransfer()
  data.items.add(new File([blob], 'pixel.png', { type: 'image/png' }))
  const element = document.querySelector('[data-testid="composer"]')
  element.dispatchEvent(new DragEvent('dragenter', { dataTransfer: data, bubbles: true, cancelable: true }))
  element.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
})()`
// 在输入框上粘贴一张 3000x1500 的 PNG（本机发给模型前缩到长边 1600，发给远程设备时再压到长边 1024）
const PASTE_BIG_IMAGE = `(async () => {
  const element = document.querySelector('textarea[aria-label="任务"]')
  const canvas = document.createElement('canvas')
  canvas.width = 3000
  canvas.height = 1500
  const context = canvas.getContext('2d')
  context.fillStyle = '#2e6b57'
  context.fillRect(0, 0, 3000, 1500)
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  const data = new DataTransfer()
  data.items.add(new File([blob], 'big.png', { type: 'image/png' }))
  element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
})()`
const imageSizes = (window: Page, root: string) => window.evaluate<number[][]>(`[...document.querySelectorAll('${root} [data-testid="message-image"]')].map((image) => [image.naturalWidth, image.naturalHeight])`)

// root 下每一轮的提问和回答文字、工具调用个数，用来比两边看到的是不是一样
interface TurnTexts {
  messages: string[]
  tools: number
}
const turnTexts = (window: Page, root: string) =>
  window.evaluate<TurnTexts[]>(`[...document.querySelectorAll('${root} [data-testid="turn"]')].map((turn) => ({
    messages: [...turn.querySelectorAll('[data-testid="user-message"], [data-testid="agent-message"]')].map((node) => node.innerText.trim()),
    tools: turn.querySelectorAll('[data-testid="tool-call"]').length,
  }))`)

async function enableVision(window: Page, provider: string): Promise<void> {
  await openModelsPage(window)
  await providerCard(window, provider).getByRole('button', { name: 'scripted 模型操作', exact: true }).click()
  await window.getByRole('menuitem', { name: '配置能力', exact: true }).click()
  const capabilities = window.getByRole('dialog')
  await capabilities.getByRole('checkbox', { name: '视觉', exact: true }).click()
  await capabilities.getByRole('button', { name: '保存模型能力', exact: true }).click()
  await expect(capabilities).toBeHidden()
  await window.getByRole('button', { name: '返回' }).click()
}

async function send(window: Page, text: string): Promise<void> {
  await taskInput(window).fill(text)
  await window.keyboard.press('Control+Enter')
}

test('设备连接：连接端在侧栏看到授权项目里的会话（别的项目看不到、直接要也被拒），侧栏搜索也能找到；打开后看到脱敏的历史（提问图片压缩后同步过来，正在跑的那一轮先说带了几张）、实时看到对方正在跑的这一轮；只读；往前翻页；跑到一半中转断开，断线期间的输出重连后续传补发、不丢不重；两边逐轮内容一致；撤销后看到离线', async () => {
  test.setTimeout(240_000)
  let { relay, port } = await startRelay()
  const granted = mkdtempSync(join(tmpdir(), 'diffra-e2e-remote-granted-'))
  const hidden = mkdtempSync(join(tmpdir(), 'diffra-e2e-remote-hidden-'))
  writeFileSync(join(granted, 'note.txt'), '随便一行')
  const secret = fakeKey('sk-', 'remote'.repeat(8))
  const model = await startScriptedModel([
    { text: '没授权的项目里的回答' },
    { text: `第 1 轮回答，密钥是 ${secret}` },
    ...Array.from({ length: 11 }, (_, index) => ({ text: `第 ${index + 2} 轮回答` })),
    { text: '实时回答到了', delayMs: 4000 },
    // 断线的这一轮：先说一段话、读个文件（断线前就同步过去），隔一会儿再出最后的回答（重连之后才到）
    { text: '断线前先说的话', toolCalls: [{ name: 'read_file', input: { path: 'note.txt' } }] },
    { text: '断线后才回来的回答', delayMs: 6000 },
  ])
  const host = await launchDevice(port)
  const guest = await launchDevice(port)
  try {
    await configureCoderModel(host.window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await enableVision(host.window, '脚本模型')
    // 没授权的项目里先跑一个任务
    await chooseProject(host.app, host.window, hidden)
    await startTask(host.window, '没授权的任务')
    await waitTaskDone(host.window)
    const hiddenSession = await host.window.evaluate(`window.diffra.listSessions(null).then((tasks) => tasks.find((task) => task.title === '没授权的任务').sessionId)`)
    // 授权的项目里跑 12 轮（快照一页 10 轮，用来测往前翻）
    await host.window.getByTestId('sidebar').getByRole('button', { name: '新任务' }).click()
    await chooseProject(host.app, host.window, granted)
    // 第一轮带一张图：图片不同步，连接端只看到带了几张
    await host.window.evaluate(DROP_PIXEL)
    await expect(host.window.getByTestId('composer-image')).toHaveCount(1)
    await startTask(host.window, '远程看的任务')
    await expect(host.window.getByTestId('message-image')).toHaveCount(1)
    await waitTaskDone(host.window)
    for (let turn = 2; turn <= 12; turn++) {
      await send(host.window, `第 ${turn} 轮`)
      await expect(host.window.getByTestId('turn')).toHaveCount(turn)
      await waitTaskDone(host.window)
    }

    // 连接端本机也打开着同名的项目（同一个仓库在两台机器上）
    await chooseProject(guest.app, guest.window, granted)
    await pair(host, guest, [granted])

    // 侧栏「项目」：对方授权的项目排在本机项目后面，右边的设备图标标出是远程的；只列授权项目里的会话
    const sidebar = guest.window.getByTestId('sidebar')
    const projectRows = sidebar.locator('[data-testid="sidebar-project"], [data-testid="sidebar-remote-project"]')
    await expect(projectRows).toHaveCount(2)
    await expect(projectRows.nth(0)).toHaveAttribute('data-testid', 'sidebar-project')
    await expect(projectRows.nth(1)).toHaveAttribute('data-testid', 'sidebar-remote-project')
    const remoteProject = sidebar.getByTestId('sidebar-remote-project')
    await expect(remoteProject).toContainText(basename(granted))
    await expect(remoteProject.getByRole('img', { name: '「主机」上的项目，只读' })).toBeVisible()
    await expect(sidebar.getByTestId('sidebar-project').getByRole('img')).toHaveCount(0)
    const remoteTasks = remoteProject.getByTestId('sidebar-remote-task')
    await expect(remoteTasks).toHaveCount(1)
    await expect(remoteTasks).toContainText('远程看的任务')
    await expect(sidebar).not.toContainText('没授权的任务')
    // 直接要没授权的会话：被拒，说法和不存在一样
    const hostId = await guest.window.evaluate(`window.diffra.getRemoteState().then((state) => state.peers[0].deviceId)`)
    const denied = await guest.window.evaluate(`window.diffra.subscribeRemoteSession(${JSON.stringify(hostId)}, ${JSON.stringify(hiddenSession)}).then(() => 'ok', (error) => String(error))`)
    expect(denied).toContain('没有这个会话')

    // 侧栏搜索也能找到远程会话（按标题），点开是远程任务页
    await sidebar.getByRole('combobox', { name: '侧栏搜索' }).fill('远程看')
    const found = sidebar.getByRole('listbox', { name: '侧栏搜索结果' }).getByRole('option')
    await expect(found).toHaveCount(1)
    await expect(found).toContainText(`主机 · ${basename(granted)}`)
    await found.click()

    // 打开：最近 10 轮，密钥脱敏，只读
    const remoteTask = guest.window.getByTestId('remote-task')
    await expect(remoteTask.getByTestId('task-title')).toHaveText('远程看的任务')
    await expect(remoteTask.getByTestId('turn')).toHaveCount(10)
    await expect(remoteTask.getByTestId('load-earlier')).toHaveText('上拉或点这里，加载更早的 2 轮')
    await expect(remoteTask.getByRole('button', { name: '重新生成' })).toHaveCount(0)
    await expect(remoteTask.getByLabel('任务', { exact: true })).toHaveCount(0)
    await remoteTask.getByTestId('load-earlier').click()
    await expect(remoteTask.getByTestId('turn')).toHaveCount(12)
    await expect(remoteTask.getByTestId('load-earlier')).toHaveText('已经是最早的一轮')
    await expect(remoteTask).toContainText('第 1 轮回答，密钥是 [已脱敏：模型服务的 API Key]')
    await expect(remoteTask).not.toContainText(secret)
    // 提问带的图片压缩后同步过来
    await expect(remoteTask.getByTestId('turn').first().getByTestId('message-image')).toHaveCount(1)
    await expect(remoteTask.getByTestId('turn').first()).not.toContainText('没有同步')

    // 对方开始新的一轮（带一张大图）：实时看到它在跑、回答到了；图片这一轮跑完才过来，跑的时候先说带了几张
    await taskInput(host.window).click()
    await host.window.evaluate(PASTE_BIG_IMAGE)
    await expect(host.window.getByTestId('composer-image')).toHaveCount(1)
    // 收到「开始了」的那一刻，对方列表里这个会话就算在跑：core 存完盘才算在跑，以前中间这段列表写着没在跑，
    // 连接端会重新订阅，把没结束的这一轮显示成已停止、也不说带了几张图片
    await guest.window.evaluate(`(() => {
      window.runningAtStart = null
      const off = window.diffra.onRemoteEvent((payload) => {
        if (payload.event?.event !== 'turn.started') return
        off()
        window.diffra.listRemoteSessions(payload.deviceId).then((list) => {
          window.runningAtStart = list.sessions.find((session) => session.sessionId === payload.event.sessionId)?.running ?? '列表里没有'
        })
      })
    })()`)
    await send(host.window, '实时的一轮')
    await expect.poll(() => guest.window.evaluate('window.runningAtStart')).toBe(true)
    await expect(remoteTask.getByTestId('task-status')).toHaveAttribute('data-tone', 'running')
    await expect(remoteTask.getByTestId('turn')).toHaveCount(13)
    await expect(remoteTask.getByTestId('turn').last()).toContainText('（带了 1 张图片，这一轮跑完后显示）')
    await expect(remoteTask).toContainText('实时回答到了', { timeout: 15_000 })
    await waitTaskDone(host.window)
    await expect(remoteTask.getByTestId('task-status')).not.toHaveAttribute('data-tone', 'running')
    await expect(remoteTask.getByTestId('turn').last().getByTestId('message-image')).toHaveCount(1)
    await expect(remoteTask.getByTestId('turn').last()).not.toContainText('这一轮跑完后显示')
    // 本机存的是长边 1600 的图，发给远程设备的压到长边 1024
    await expect.poll(async () => (await imageSizes(host.window, '[data-testid="turn"]:last-of-type')).at(-1)).toEqual([1600, 800])
    await expect.poll(async () => (await imageSizes(guest.window, '[data-testid="remote-task"]')).at(-1)).toEqual([1024, 512])
    await guest.window.screenshot({ path: 'test-results/devices-remote-task.png' })

    // 跑到一半中转断了，断线期间对方把这一轮跑完：重连后续传补发这段输出（不重新取整页），不丢不重
    const hostLog: string[] = []
    host.app.process().stdout?.on('data', (chunk: Buffer) => hostLog.push(String(chunk)))
    await send(host.window, '断线的一轮')
    await expect(remoteTask.getByTestId('turn')).toHaveCount(14)
    await expect(remoteTask).toContainText('断线前先说的话')
    await relay.close()
    await expect(guest.window.getByTestId('remote-offline')).toBeVisible()
    await waitTaskDone(host.window, 30_000)
    await expect(remoteTask).not.toContainText('断线后才回来的回答')
    ;({ relay } = await startRelay(port))
    await expect(guest.window.getByTestId('remote-offline')).toHaveCount(0, { timeout: 30_000 })
    await expect(remoteTask).toContainText('断线后才回来的回答', { timeout: 15_000 })
    await expect.poll(() => hostLog.join('')).toMatch(/断线续传：从 \d+ 补发 [1-9]\d* 条/)
    await expect(remoteTask.getByTestId('task-status')).not.toHaveAttribute('data-tone', 'running')
    // 不丢不重：和被连接端自己看到的一样多
    for (const text of ['断线前先说的话', '断线后才回来的回答']) {
      await expect(remoteTask.getByText(text)).toHaveCount(await host.window.getByTestId('turn').last().getByText(text).count())
      await expect(remoteTask.getByText(text)).toHaveCount(1)
    }
    await expect(remoteTask.getByTestId('turn')).toHaveCount(14)

    // 两边逐轮比：除了脱敏的密钥，提问、回答、工具调用都一样
    const hostTurns = await turnTexts(host.window, 'body')
    const guestTurns = await turnTexts(guest.window, '[data-testid="remote-task"]')
    expect(hostTurns).toHaveLength(14)
    expect(guestTurns).toEqual(hostTurns.map((turn) => ({ ...turn, messages: turn.messages.map((text) => text.replace(secret, '[已脱敏：模型服务的 API Key]')) })))
    expect(guestTurns[0]!.messages[1]).toContain('[已脱敏：模型服务的 API Key]')
    expect(guestTurns[13]!.tools).toBe(1)
    await remoteTask.getByTestId('turn').first().scrollIntoViewIfNeeded()
    await guest.window.screenshot({ path: 'test-results/devices-remote-history.png' })

    // 撤销：连接端马上看到离线
    await openDevices(host.window, '允许连接本机')
    await host.window.getByTestId('grants').getByRole('button', { name: '撤销' }).click()
    await host.window.getByRole('alertdialog').getByRole('button', { name: '撤销' }).click()
    await expect(guest.window.getByTestId('remote-offline')).toBeVisible()
    await expect(remoteProject.getByTestId('remote-project-offline')).toBeVisible()
    await guest.window.screenshot({ path: 'test-results/devices-remote-offline.png' })
  } finally {
    await close([host, guest])
    await relay.close()
    await model.close()
    rmSync(granted, { recursive: true, force: true })
    rmSync(hidden, { recursive: true, force: true })
  }
})

// 连接端收到的权限请求和「已经答完」。页面里跑的代码写成字符串（e2e 的类型配置里没有 DOM 类型）
const RECORD_REMOTE_EVENTS = `(() => {
  window.__remoteEvents = []
  window.diffra.onRemoteEvent((payload) => { if (payload.event) window.__remoteEvents.push(payload.event) })
})()`
interface PermissionEvent {
  event: 'permission.request' | 'permission.settled'
  requestId: string
  toolCall?: { title?: string }
  options?: Array<{ optionId: string; name: string }>
}
const permissionEvents = (window: Page) => window.evaluate<PermissionEvent[]>(`window.__remoteEvents.filter((event) => event.event.startsWith('permission.'))`)
const call = (window: Page, script: string) => window.evaluate<string>(`${script}.then((value) => value === undefined ? 'ok' : 'ok ' + JSON.stringify(value), (error) => String(error))`)

test('设备连接：远程操作——发消息、新建、停止经被连接端执行，两边看到同一轮并标出来源；权限请求只给「允许一次」「拒绝」，先答先算、项目外访问只在本机确认；运行中发的排队；只开放查看的伪造请求被拒；限流；本机横幅能断开，没答的确认留在本机', async () => {
  test.setTimeout(240_000)
  const { relay, port } = await startRelay()
  const controlled = mkdtempSync(join(tmpdir(), 'diffra-e2e-remote-control-'))
  const viewOnly = mkdtempSync(join(tmpdir(), 'diffra-e2e-remote-view-'))
  const outside = mkdtempSync(join(tmpdir(), 'diffra-e2e-remote-outside-'))
  writeFileSync(join(outside, 'secret.txt'), '项目外的文件')
  const model = await startScriptedModel([
    { text: '第一轮回答' },
    { text: '只能看的回答' },
    { text: '远程发的回答到了' },
    { toolCalls: [{ name: 'run_command', input: { command: 'hostname' } }] },
    { text: '命令跑完了' },
    { toolCalls: [{ name: 'run_command', input: { command: 'hostname' } }] },
    { text: '第二个命令跑完了' },
    { toolCalls: [{ name: 'read_file', input: { path: join(outside, 'secret.txt') } }] },
    { text: '没读到' },
    { text: '慢的回答', delayMs: 3000 },
    { text: '排队的回答' },
    { text: '不该出现的回答', delayMs: 15_000 },
    { text: '新任务的回答' },
    { toolCalls: [{ name: 'run_command', input: { command: 'hostname' } }] },
    { text: '结束' },
  ])
  const host = await launchDevice(port)
  const guest = await launchDevice(port)
  try {
    await configureCoderModel(host.window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(host.app, host.window, controlled)
    await startTask(host.window, '远程操作的任务')
    await waitTaskDone(host.window)
    await host.window.getByTestId('sidebar').getByRole('button', { name: '新任务' }).click()
    await chooseProject(host.app, host.window, viewOnly)
    await startTask(host.window, '只能看的任务')
    await waitTaskDone(host.window)

    await guest.window.evaluate(`window.diffra.setRemoteName('同事的电脑')`)
    await guest.window.evaluate(RECORD_REMOTE_EVENTS)
    await pair(host, guest, [viewOnly], [controlled])
    // 标题栏的提示：能操作本机的设备在线
    await expect(host.window.getByTestId('remote-control-indicator')).toHaveText('「同事的电脑」能操作本机')

    const hostId = await guest.window.evaluate<string>(`window.diffra.getRemoteState().then((state) => state.peers[0].deviceId)`)
    const list = await guest.window.evaluate<{ projects: Array<{ id: string; name: string; level: string }>; sessions: Array<{ sessionId: string; projectId: string; title: string }> }>(`window.diffra.listRemoteSessions(${JSON.stringify(hostId)})`)
    const controlProject = list.projects.find((project) => project.name === basename(controlled))!
    const viewProject = list.projects.find((project) => project.name === basename(viewOnly))!
    expect([controlProject.level, viewProject.level]).toEqual(['control', 'view'])
    const controlSession = list.sessions.find((session) => session.title === '远程操作的任务')!.sessionId
    const viewSession = list.sessions.find((session) => session.title === '只能看的任务')!.sessionId
    const remote = (method: string, ...args: unknown[]) => call(guest.window, `window.diffra.${method}(${[hostId, ...args].map((arg) => JSON.stringify(arg)).join(', ')})`)

    // 只开放查看的项目：发消息、新建、停止都被拒；不存在的会话和没授权的说法一样
    expect(await remote('promptRemoteSession', viewSession, '想改点东西')).toContain('对方只开放了查看，不能操作')
    expect(await remote('createRemoteSession', viewProject.id, '想新建')).toContain('对方只开放了查看，不能操作')
    expect(await remote('cancelRemoteSession', viewSession)).toContain('对方只开放了查看，不能操作')
    expect(await remote('promptRemoteSession', 'no-such-session', '你好')).toContain('没有这个会话')

    // 侧栏：开放查看的项目没有加号；打开只能看的任务是「只读」、没有输入框
    const sidebar = guest.window.getByTestId('sidebar')
    await expect(sidebar.getByRole('button', { name: `在 ${basename(viewOnly)} 新建远程任务` })).toHaveCount(0)
    const remoteTask = guest.window.getByTestId('remote-task')
    await sidebar.getByTestId('sidebar-remote-task').filter({ hasText: '只能看的任务' }).click()
    await expect(remoteTask.getByTestId('task-title')).toHaveText('只能看的任务')
    await expect(remoteTask.getByTestId('remote-task-level')).toHaveText('只读')
    await expect(remoteTask.getByLabel('任务', { exact: true })).toHaveCount(0)

    // 两边都打开能操作的那个任务：连接端是「可操作」，有输入框
    await host.window.getByTestId('sidebar-task').filter({ hasText: '远程操作的任务' }).click()
    await sidebar.getByTestId('sidebar-remote-task').filter({ hasText: '远程操作的任务' }).click()
    await expect(remoteTask.getByTestId('remote-task-level')).toHaveText('可操作')
    await expect(remoteTask.getByTestId('turn')).toHaveCount(1)
    // 和本机任务页同一个输入框
    const composer = remoteTask.getByLabel('任务', { exact: true })
    const sendRemote = async (text: string) => {
      await composer.fill(text)
      await composer.press('Control+Enter')
      await expect(composer).toHaveValue('')
    }

    // 远程发消息：被连接端起一轮，标出来自哪台设备；连接端自己发的标「本机发的」；两边内容一样
    await sendRemote('远程发的第一条')
    await expect(host.window.getByTestId('turn')).toHaveCount(2)
    await waitTaskDone(host.window)
    await expect(host.window.getByTestId('turn').nth(1).getByTestId('turn-remote-source')).toHaveText('来自设备「同事的电脑」')
    await expect(remoteTask.getByTestId('turn').nth(1).getByTestId('turn-remote-source')).toHaveText('本机发的')
    await expect(remoteTask).toContainText('远程发的回答到了')
    expect(await turnTexts(guest.window, '[data-testid="remote-task"]')).toEqual(await turnTexts(host.window, 'body'))
    await host.window.screenshot({ path: 'test-results/devices-remote-control-host.png' })

    // 权限请求：连接端只拿到「允许一次」「拒绝」，在连接端点允许后本机的确认卡片收起，命令照常跑
    const requestIds = async () => [...new Set((await permissionEvents(guest.window)).filter((event) => event.event === 'permission.request').map((event) => event.requestId))]
    await sendRemote('跑个命令')
    const permission = host.window.getByTestId('permission-card')
    await expect(permission).toContainText('hostname')
    const remotePermission = remoteTask.getByTestId('permission-card')
    await expect(remotePermission).toContainText('hostname')
    await expect(remotePermission.getByRole('button')).toHaveText(['允许一次', '拒绝'])
    const first = (await permissionEvents(guest.window))[0]!
    expect(first.options?.map((option) => option.optionId)).toEqual(['allow_once', 'reject'])
    await guest.window.screenshot({ path: 'test-results/devices-remote-control-guest.png' })
    await remotePermission.getByRole('button', { name: '允许一次' }).click()
    await expect(remotePermission).toHaveCount(0)
    await expect(permission).toHaveCount(0)
    await waitTaskDone(host.window)
    await expect(host.window.getByTestId('turn').last()).toContainText('命令跑完了')
    // 同一个确认答第二次：已经处理过了
    expect(await remote('respondRemotePermission', first.requestId, 'reject')).toContain('这个确认已经处理过了')

    // 本机先答：连接端的确认卡片收起，再答被拒
    await sendRemote('再跑一个')
    await expect(permission).toContainText('hostname')
    await expect(remotePermission).toContainText('hostname')
    await expect.poll(requestIds).toHaveLength(2)
    const second = (await requestIds())[1]!
    await permission.getByRole('button', { name: '允许一次' }).click()
    await expect(remotePermission).toHaveCount(0)
    expect(await remote('respondRemotePermission', second, 'allow_once')).toContain('这个确认已经处理过了')
    await waitTaskDone(host.window)

    // 项目外的文件访问只在本机确认，连接端收不到
    await sendRemote('读项目外的文件')
    await expect(permission).toContainText('项目外读取')
    await permission.getByRole('button', { name: '拒绝', exact: true }).click()
    await waitTaskDone(host.window)
    expect(await requestIds()).toHaveLength(2)
    await expect(remotePermission).toHaveCount(0)

    // 运行中再发：排在这一轮后面，跑完接着跑
    await sendRemote('慢一点的回答')
    await expect(host.window.getByTestId('turn')).toHaveCount(6)
    await expect(remoteTask.getByTestId('task-status')).toHaveAttribute('data-tone', 'running')
    await sendRemote('排队的消息')
    await expect(guest.window.getByText('对方正在跑，这条消息排在这一轮后面')).toBeVisible()
    await expect(host.window.getByTestId('turn')).toHaveCount(7, { timeout: 15_000 })
    await waitTaskDone(host.window)
    await expect(host.window.getByTestId('turn').last()).toContainText('排队的回答')

    // 远程停止：模型正在回这一轮时，在连接端点停止
    const served = model.requests()
    await sendRemote('停下来')
    await expect(host.window.getByTestId('turn')).toHaveCount(8)
    await expect.poll(() => model.requests()).toBe(served + 1)
    await remoteTask.getByRole('button', { name: '停止' }).click()
    await waitTaskStatus(host.window, 'stopped')
    await expect(remoteTask.getByTestId('task-status')).not.toHaveAttribute('data-tone', 'running')
    await expect(host.window.getByTestId('turn').last()).not.toContainText('不该出现的回答')

    // 远程新建：侧栏能操作的项目上有加号，在被连接端后台建好、跑完，连接端打开它
    await sidebar.getByRole('button', { name: `在 ${basename(controlled)} 新建远程任务` }).click()
    const dialog = guest.window.getByRole('dialog')
    await dialog.getByLabel('新任务要做什么').fill('远程新建的任务')
    await dialog.getByRole('button', { name: '新建', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(remoteTask.getByTestId('task-title')).toHaveText('远程新建的任务')
    await expect(remoteTask).toContainText('新任务的回答')
    await expect(host.window.getByTestId('sidebar-task').filter({ hasText: '远程新建的任务' })).toBeVisible()
    await expect.poll(() => host.window.evaluate<boolean>(`window.diffra.listSessions(null).then((tasks) => tasks.some((task) => task.title === '远程新建的任务' && !task.running && task.turnCount === 1))`)).toBe(true)
    await sidebar.getByTestId('sidebar-remote-task').filter({ hasText: '远程操作的任务' }).click()
    await expect(remoteTask.getByTestId('task-title')).toHaveText('远程操作的任务')

    // 限流：每分钟最多 30 次操作
    let limited = ''
    for (let attempt = 0; attempt < 31 && !limited; attempt++) {
      const result = await remote('cancelRemoteSession', controlSession)
      if (result !== 'ok') limited = result
    }
    expect(limited).toContain('操作太频繁')

    // 操作记录里有远程做的事
    const audit = await host.window.evaluate<Array<{ name: string; action: string }>>(`window.diffra.getRemoteAudit()`)
    const actions = audit.filter((entry) => entry.name === '同事的电脑').map((entry) => entry.action)
    expect(actions).toContain(`远程发消息：${basename(controlled)}「远程操作的任务」`)
    expect(actions).toContain(`远程允许一次：${basename(controlled)}「执行 hostname」`)
    expect(actions).toContain(`远程停止：${basename(controlled)}「远程操作的任务」`)
    expect(actions).toContain(`远程新建任务：${basename(controlled)}`)

    // 本机横幅断开（撤销授权）：连接端马上离线，正在等的确认留在本机
    await host.window.getByTestId('sidebar-task').filter({ hasText: '远程操作的任务' }).click()
    await send(host.window, '最后一个命令')
    await expect(permission).toContainText('hostname')
    await expect.poll(requestIds).toHaveLength(3)
    await expect(remotePermission).toContainText('hostname')
    // 点标题栏的提示，在设备面板里断开
    await host.window.getByTestId('remote-control-indicator').click()
    await host.window.getByTestId('devices-panel').getByTestId('device-entry').filter({ hasText: '同事的电脑' }).getByRole('button', { name: '断开' }).click()
    await host.window.getByRole('alertdialog').getByRole('button', { name: '断开', exact: true }).click()
    await expect(host.window.getByTestId('remote-control-indicator')).toHaveCount(0)
    await expect(guest.window.getByTestId('remote-offline')).toBeVisible()
    await expect(remotePermission).toHaveCount(0)
    await expect(permission).toContainText('hostname')
    await permission.getByRole('button', { name: '拒绝', exact: true }).click()
    await waitTaskDone(host.window)
  } finally {
    await close([host, guest])
    await relay.close()
    await model.close()
    rmSync(controlled, { recursive: true, force: true })
    rmSync(viewOnly, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('设备连接：互相配对时，对方关掉「允许连接本机」、撤销授权后，连接端马上看到准确原因（中转上对方仍显示在线），侧栏收起它的项目、不自动重试；对方重新开放后点重试恢复成「可操作」；日志里记下拒绝', async () => {
  test.setTimeout(180_000)
  const { relay, port } = await startRelay()
  const aProject = mkdtempSync(join(tmpdir(), 'diffra-e2e-remote-a-'))
  const bProject = mkdtempSync(join(tmpdir(), 'diffra-e2e-remote-b-'))
  const model = await startScriptedModel([{ text: 'A 的回答' }])
  const a = await launchDevice(port)
  const b = await launchDevice(port)
  try {
    await configureCoderModel(a.window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(a.app, a.window, aProject)
    await startTask(a.window, 'A 的任务')
    await waitTaskDone(a.window)
    await chooseProject(b.app, b.window, bProject)
    // 互相配对：A 把自己的项目开放给 B（可查看和操作），B 把自己的项目开放给 A（可查看）
    await pair(a, b, [], [aProject])
    await pair(b, a, [bProject])

    // B 打开 A 的任务：可操作
    const sidebar = b.window.getByTestId('sidebar')
    const remoteProject = sidebar.getByTestId('sidebar-remote-project').filter({ hasText: basename(aProject) })
    await remoteProject.getByTestId('sidebar-remote-task').click()
    const remoteTask = b.window.getByTestId('remote-task')
    await expect(remoteTask.getByTestId('remote-task-level')).toHaveText('可操作')
    await expect(remoteTask).toContainText('A 的回答')

    // A 关掉「允许连接本机」：中转上 A 对 B 仍在线（B 是 A 自己连接的设备），B 马上看到准确原因，侧栏收起 A 的项目
    const allow = a.window.getByRole('switch', { name: '允许连接本机' })
    await openDevices(a.window, '允许连接本机')
    await allow.click()
    await expect(allow).not.toBeChecked()
    const error = remoteTask.getByTestId('remote-error')
    await expect(error).toContainText('对方关掉了「允许连接本机」', { timeout: 5_000 })
    await expect(remoteTask.getByTestId('remote-offline')).toHaveCount(0)
    await expect(remoteProject).toHaveCount(0)
    expect(await b.window.evaluate<boolean>(`window.diffra.getRemoteState().then((state) => state.peers[0].online)`)).toBe(true)
    // 被明确拒绝不自动重试：过了第一次自动重试的时间还停在这个原因上
    await b.window.waitForTimeout(3_000)
    await expect(error).toContainText('对方关掉了「允许连接本机」')

    // A 重新打开，B 点重试：恢复，侧栏的项目回来
    await allow.click()
    await expect(allow).toBeChecked()
    await error.getByRole('button', { name: '重试' }).click()
    await expect(error).toHaveCount(0)
    await expect(remoteTask.getByTestId('remote-task-level')).toHaveText('可操作')
    await expect(remoteTask).toContainText('A 的回答')
    await expect(remoteProject).toHaveCount(1)
    await b.window.screenshot({ path: 'test-results/devices-refused-recovered.png' })

    // A 撤销 B：B 看到「没有授权本机」
    await a.window.getByTestId('grants').getByRole('button', { name: '撤销' }).click()
    await a.window.getByRole('alertdialog').getByRole('button', { name: '撤销' }).click()
    await expect(error).toContainText('对方没有授权本机', { timeout: 5_000 })
    await b.window.screenshot({ path: 'test-results/devices-refused.png' })

    // 两边的日志里都记下了
    await expect.poll(() => readFileSync(join(a.userDataDir, 'logs', 'remote.log'), 'utf8')).toContain('没开「允许连接本机」')
    await expect.poll(() => readFileSync(join(b.userDataDir, 'logs', 'remote.log'), 'utf8')).toContain('对方没有授权本机')
  } finally {
    await close([a, b])
    await relay.close()
    await model.close()
    rmSync(aProject, { recursive: true, force: true })
    rmSync(bProject, { recursive: true, force: true })
  }
})

// 伪随机汉字（压不小）：6 万个压缩后约 110 KB
function randomHan(seed: number, length: number): string {
  const next = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return (value ^ (value >>> 14)) >>> 0
  }
  return Array.from({ length }, () => String.fromCharCode(0x4e00 + (next() % 3000))).join('')
}
// 一条消息要切成一整片加一小片（整片加上直发种类、中转帧头曾经比中转的单帧上限多 1 字节）
const BIG_REPLY = randomHan(1, 60_000)

test('设备连接：会话一页压缩后超过一片（约 64 KB）也能看完整，中转不把被连接端断开；对方不在中转上时建通道马上失败、说清原因，不干等 10 秒', async () => {
  test.setTimeout(120_000)
  const relayLog: string[] = []
  const { relay, port } = await startRelay(0, (line) => relayLog.push(line))
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-remote-big-'))
  const model = await startScriptedModel([{ text: `长回答开始${BIG_REPLY}长回答结束` }])
  const host = await launchDevice(port)
  const guest = await launchDevice(port)
  try {
    await configureCoderModel(host.window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(host.app, host.window, project)
    await startTask(host.window, '要一个很长的回答')
    await waitTaskDone(host.window)
    await pair(host, guest, [project])

    await guest.window.getByTestId('sidebar').getByTestId('sidebar-remote-task').click()
    const remoteTask = guest.window.getByTestId('remote-task')
    await expect(remoteTask).toContainText('长回答结束', { timeout: 20_000 })
    const [turn] = await turnTexts(guest.window, '[data-testid="remote-task"]')
    expect(turn?.messages.at(-1)).toBe(`长回答开始${BIG_REPLY}长回答结束`)
    expect(relayLog.filter((line) => !line.startsWith('connect '))).toEqual([])

    // 被连接端关掉总开关：中转上它的白名单里没有连接端了，连接端发的握手中转送不到
    const hostId = await guest.window.evaluate<string>(`window.diffra.getRemoteState().then((state) => state.peers[0].deviceId)`)
    await openDevices(host.window, '允许连接本机')
    await host.window.getByRole('switch', { name: '允许连接本机' }).click()
    await expect.poll(() => guest.window.evaluate<boolean>(`window.diffra.getRemoteState().then((state) => state.peers[0].online)`)).toBe(false)
    const started = Date.now()
    expect(await call(guest.window, `window.diffra.listRemoteSessions('${hostId}')`)).toContain('对方现在不在线')
    expect(Date.now() - started).toBeLessThan(3_000)
    await expect.poll(() => readFileSync(join(guest.userDataDir, 'logs', 'remote.log'), 'utf8')).toContain('建通道没成：offline')
  } finally {
    await close([host, guest])
    await relay.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
  }
})

test('设备连接：快照一页按压缩后的大小装（每页不超过 500 KB）；滚到顶继续往上拉取更早的一页，正在看的位置不动；读取、执行的长输出只同步开头，展开时取全文', async () => {
  test.setTimeout(180_000)
  const { relay, port } = await startRelay()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-remote-pages-'))
  writeFileSync(join(project, 'long.txt'), `${Array.from({ length: 300 }, (_, index) => `第 ${index + 1} 行：${'内容'.repeat(10)}`).join('\n')}\n文件最后一行\n`)
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'read_file', input: { path: 'long.txt' } }] },
    { text: '读完了' },
    ...[2, 3, 4, 5, 6, 7].map((turn) => ({ text: `第 ${turn} 轮开始${randomHan(turn, 60_000)}第 ${turn} 轮结束` })),
  ])
  const host = await launchDevice(port)
  const guest = await launchDevice(port)
  try {
    await configureCoderModel(host.window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(host.app, host.window, project)
    await startTask(host.window, '读一下 long.txt')
    await waitTaskDone(host.window)
    for (let turn = 2; turn <= 7; turn++) {
      await send(host.window, `第 ${turn} 轮`)
      await expect(host.window.getByTestId('turn')).toHaveCount(turn)
      await waitTaskDone(host.window)
    }
    await pair(host, guest, [project])

    // 第一页：每轮压缩后约 110 KB，500 KB 装 4 轮
    await guest.window.getByTestId('sidebar').getByTestId('sidebar-remote-task').click()
    const remoteTask = guest.window.getByTestId('remote-task')
    await expect(remoteTask).toContainText('第 7 轮结束', { timeout: 20_000 })
    await expect(remoteTask.getByTestId('turn')).toHaveCount(4)
    const earlier = remoteTask.getByTestId('load-earlier')
    await expect(earlier).toHaveText('上拉或点这里，加载更早的 3 轮')

    // 先直接放到顶（到顶以后再滚就算上拉了），再往上拉：取出剩下的 3 轮，原来最上面那一轮还在原处
    const turns = remoteTask.getByTestId('turn')
    await guest.window.evaluate(`(() => {
      let scroller = document.querySelector('[data-testid="remote-task"] [data-testid="turn"]').parentElement
      while (scroller && getComputedStyle(scroller).overflowY !== 'auto') scroller = scroller.parentElement
      scroller.scrollTop = 0
    })()`)
    // 悬停在顶上那一行（悬停在很长的第一轮上会先把它滚进视野，就不在顶上了）
    await earlier.hover()
    await expect(earlier).toHaveText('上拉或点这里，加载更早的 3 轮')
    const before = await turns.first().evaluate((node) => ({ id: node.getAttribute('data-turn-id'), top: node.getBoundingClientRect().top }))
    await guest.window.mouse.wheel(0, -60)
    await expect(earlier).toHaveText('继续上拉，加载更早的 3 轮')
    await guest.window.mouse.wheel(0, -100)
    await expect(turns).toHaveCount(7)
    await expect(earlier).toHaveText('已经是最早的一轮')
    const after = await remoteTask.locator(`[data-turn-id="${before.id}"]`).evaluate((node) => node.getBoundingClientRect().top)
    expect(Math.abs(after - before.top)).toBeLessThan(8)
    await guest.window.screenshot({ path: 'test-results/devices-pull-earlier.png' })

    // 第一轮读的长文件：只同步了开头，展开后取全文
    const read = turns.first().getByTestId('tool-call').filter({ hasText: '读取' })
    await read.getByRole('button').first().click()
    await expect(read.locator('pre')).toBeVisible()
    await expect(read.locator('pre')).toContainText('文件最后一行', { timeout: 10_000 })
    await expect(read.getByTestId('tool-output-note')).toHaveCount(0)
  } finally {
    await close([host, guest])
    await relay.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
  }
})

test('设备连接：「完全控制」——授权时有醒目的提醒，本机横幅写明能开终端、执行任意命令；连接端看到「完全控制」，能做「可查看和操作」能做的事', async () => {
  test.setTimeout(120_000)
  const { relay, port } = await startRelay()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-remote-full-'))
  const model = await startScriptedModel([{ text: '第一轮的回答' }, { text: '远程发的回答' }])
  const host = await launchDevice(port)
  const guest = await launchDevice(port)
  try {
    await configureCoderModel(host.window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(host.app, host.window, project)
    await startTask(host.window, '本机的任务')
    await waitTaskDone(host.window)
    await pair(host, guest, [], [], [project])

    // 本机：横幅、授权列表
    await expect(host.window.getByTestId('remote-control-indicator')).toContainText('能操作本机')
    await host.window.getByTestId('remote-control-indicator').click()
    await expect(host.window.getByTestId('devices-panel').getByTestId('device-level')).toHaveText('完全控制')
    await expect(host.window.getByTestId('devices-panel').getByTestId('device-entry')).toContainText('1 个项目')
    await host.window.keyboard.press('Escape')
    await openDevices(host.window, '允许连接本机')
    await expect(host.window.getByTestId('grants')).toContainText('完全控制')

    // 连接端：侧栏和任务页标出「完全控制」，能发消息
    const remoteProject = guest.window.getByTestId('sidebar').getByTestId('sidebar-remote-project')
    await expect(remoteProject.getByRole('img', { name: '「主机」上的项目，完全控制' })).toBeVisible()
    await remoteProject.getByTestId('sidebar-remote-task').click()
    const remoteTask = guest.window.getByTestId('remote-task')
    await expect(remoteTask.getByTestId('remote-task-level')).toHaveText('完全控制')
    await remoteTask.getByLabel('任务', { exact: true }).fill('远程发一条')
    await remoteTask.getByLabel('任务', { exact: true }).press('Control+Enter')
    await expect(remoteTask).toContainText('远程发的回答', { timeout: 15_000 })
  } finally {
    await close([host, guest])
    await relay.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
  }
})

test('设备连接：远程任务页借用本机任务页——任务监控（本任务改动）、审阅改动看得到对方的文件改动，只读时没有撤销；远程没有终端和浏览器', async () => {
  test.setTimeout(120_000)
  const { relay, port } = await startRelay()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-remote-monitor-'))
  writeFileSync(join(project, 'hello.txt'), 'hello world\n')
  // 编辑之前要先读过这个文件
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'read_file', input: { path: 'hello.txt' } }] },
    { toolCalls: [{ name: 'edit_file', input: { path: 'hello.txt', old_string: 'hello world', new_string: 'hello diffra' } }] },
    { toolCalls: [{ name: 'finish', input: { summary: '改好了' } }] },
  ])
  const host = await launchDevice(port)
  const guest = await launchDevice(port)
  try {
    await configureCoderModel(host.window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(host.app, host.window, project)
    await startTask(host.window, '改一下 hello')
    await waitTaskDone(host.window)
    await pair(host, guest, [project])

    await guest.window.getByTestId('sidebar').getByTestId('sidebar-remote-task').click()
    const remoteTask = guest.window.getByTestId('remote-task')
    await expect(remoteTask.getByTestId('task-title')).toHaveText('改一下 hello')
    await expect(remoteTask.getByTestId('remote-task-level')).toHaveText('只读')
    await expect(remoteTask).toContainText('改好了')
    // 不带对方电脑上的完整路径：编辑卡按相对项目的路径显示（读文件和编辑收在过程组里，先点开）
    await remoteTask.getByRole('button', { name: /执行工具 2 次/ }).click()
    await expect(remoteTask.getByRole('button', { name: '查看改动 hello.txt', exact: true })).toBeVisible()
    const shown = (await remoteTask.innerText()).replace(/\\/g, '/').toLowerCase()
    expect(shown).not.toContain(project.replace(/\\/g, '/').toLowerCase())
    await expect(remoteTask.getByRole('button', { name: '终端 Ctrl+`' })).toHaveCount(0)
    await expect(remoteTask.getByRole('button', { name: '浏览器' })).toHaveCount(0)

    // 任务监控：对方的文件改动
    const monitor = remoteTask.getByTestId('monitor-panel')
    if (!(await monitor.isVisible())) await remoteTask.getByRole('button', { name: '任务监控' }).click()
    await expect(monitor).toContainText('本任务改动 · 1 个文件', { timeout: 15_000 })
    await expect(monitor.getByTestId('monitor-file')).toContainText('hello.txt')
    await expect(monitor.getByRole('button', { name: '编辑检查命令' })).toHaveCount(0)
    await guest.window.screenshot({ path: 'test-results/devices-remote-monitor.png' })

    // 审阅改动：只读时没有撤销
    await monitor.getByRole('button', { name: '审阅', exact: true }).click()
    const review = remoteTask.getByTestId('review-panel')
    await expect(review.getByTestId('review-file')).toHaveCount(1)
    await expect(review).toContainText('hello.txt')
    await expect(review.getByRole('button', { name: '撤销这些改动' })).toHaveCount(0)
    await guest.window.screenshot({ path: 'test-results/devices-remote-review.png' })
  } finally {
    await close([host, guest])
    await relay.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
  }
})

test('设备连接：可操作的远程任务页用本机的输入框——切换权限模式（完全访问要「完全控制」）、撤销一轮的改动（先列出文件）都经对方做', async () => {
  test.setTimeout(120_000)
  const { relay, port } = await startRelay()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-remote-ops-'))
  writeFileSync(join(project, 'hello.txt'), 'hello world\n')
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'read_file', input: { path: 'hello.txt' } }] },
    { toolCalls: [{ name: 'edit_file', input: { path: 'hello.txt', old_string: 'hello world', new_string: 'hello diffra' } }] },
    { toolCalls: [{ name: 'finish', input: { summary: '改好了' } }] },
  ])
  const host = await launchDevice(port)
  const guest = await launchDevice(port)
  try {
    await configureCoderModel(host.window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(host.app, host.window, project)
    await startTask(host.window, '改一下 hello')
    await waitTaskDone(host.window)
    await pair(host, guest, [], [project])
    await host.window.getByTestId('sidebar-task').first().click()

    await guest.window.getByTestId('sidebar').getByTestId('sidebar-remote-task').click()
    const remoteTask = guest.window.getByTestId('remote-task')
    await expect(remoteTask.getByTestId('remote-task-level')).toHaveText('可操作')
    const mode = remoteTask.getByTestId('permission-mode')
    await expect(mode).toContainText('每次询问')

    // 切到自动审批：对方任务的权限模式跟着变
    await mode.click()
    await guest.window.getByRole('menuitemradio', { name: /自动审批/ }).click()
    await expect(mode).toContainText('自动审批')
    await expect(host.window.getByTestId('permission-mode')).toContainText('自动审批')
    // 等上一个菜单的关闭动画走完再点，不然这次点击会被当成点在菜单外面（Mac 上容易撞上）
    await expect(guest.window.getByRole('menu')).toHaveCount(0)
    // 完全访问：只开放了「可查看和操作」，被拒
    await mode.click()
    await guest.window.getByRole('menuitemradio', { name: /完全访问/ }).click()
    await expect(guest.window.getByText('对方没有开放「完全控制」，不能切到完全访问')).toBeVisible()
    await expect(host.window.getByTestId('permission-mode')).toContainText('自动审批')

    // 撤销这一轮：先列出会改回去的文件，确认后对方的文件改回去
    await remoteTask.locator('[data-testid="tool-call"][data-kind="finish"]').getByRole('button', { name: '撤销改动', exact: true }).click()
    await expect(guest.window.getByTestId('restore-list')).toContainText('hello.txt')
    await guest.window.getByTestId('restore-confirm').click()
    await expect.poll(() => readFileSync(join(project, 'hello.txt'), 'utf8')).toBe('hello world\n')
    // 任务监控跟着刷新：改回去之后没有改动了
    const monitor = remoteTask.getByTestId('monitor-panel')
    if (!(await monitor.isVisible())) await remoteTask.getByRole('button', { name: '任务监控' }).click()
    await expect(monitor).toContainText('本任务改动 · 0 个文件', { timeout: 10_000 })
    await guest.window.screenshot({ path: 'test-results/devices-remote-ops.png' })
  } finally {
    await close([host, guest])
    await relay.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
  }
})

test('设备连接：「完全控制」——连接端开对方电脑上的终端，输入、输出都能用，本机横幅写着开着几个终端，关掉面板后对方的终端结束；能切到完全访问', async () => {
  test.setTimeout(120_000)
  const { relay, port } = await startRelay()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-remote-terminal-'))
  const model = await startScriptedModel([{ text: '好的' }])
  const host = await launchDevice(port)
  const guest = await launchDevice(port)
  try {
    await configureCoderModel(host.window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(host.app, host.window, project)
    await startTask(host.window, '终端的任务')
    await waitTaskDone(host.window)
    await pair(host, guest, [], [], [project])
    await host.window.getByTestId('sidebar-task').first().click()

    await guest.window.getByTestId('sidebar').getByTestId('sidebar-remote-task').click()
    const remoteTask = guest.window.getByTestId('remote-task')
    await expect(remoteTask.getByTestId('remote-task-level')).toHaveText('完全控制')

    // 打开终端：在对方电脑上跑命令，输出回来
    await remoteTask.getByRole('button', { name: '终端 Ctrl+`' }).click()
    const terminal = remoteTask.getByTestId('remote-terminal')
    await expect(terminal).not.toContainText('正在打开', { timeout: 15_000 })
    await expect(host.window.getByTestId('remote-control-indicator')).toContainText('开着 1 个终端')
    await terminal.locator('.xterm').click()
    await guest.window.keyboard.type('echo remote-terminal-ok')
    await guest.window.keyboard.press('Enter')
    // 一次是对方 shell 回显的命令，一次是命令的输出
    await expect.poll(async () => ((await terminal.locator('.xterm-rows').innerText()).match(/remote-terminal-ok/g) ?? []).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
    await guest.window.screenshot({ path: 'test-results/devices-remote-terminal.png' })

    // 关掉面板：对方的终端结束
    await terminal.getByRole('button', { name: '关闭远程终端' }).click()
    await expect(terminal).toHaveCount(0)
    await expect(host.window.getByTestId('remote-control-indicator')).not.toContainText('开着')

    // 完全访问：开放了「完全控制」才能切
    await remoteTask.getByTestId('permission-mode').click()
    await guest.window.getByRole('menuitemradio', { name: /完全访问/ }).click()
    await expect(host.window.getByTestId('permission-mode')).toContainText('完全访问')
  } finally {
    await close([host, guest])
    await relay.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
  }
})

const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

test('切换分支：本机任务页底栏能切本地分支，有未提交的改动时不切、说明原因；可操作的远程设备也能切对方项目的分支', async () => {
  test.setTimeout(120_000)
  const { relay, port } = await startRelay()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-branch-'))
  gitIn(project, 'init', '-b', 'main')
  gitIn(project, 'config', 'user.name', 'e2e')
  gitIn(project, 'config', 'user.email', 'e2e@example.com')
  writeFileSync(join(project, 'a.txt'), 'a\n')
  gitIn(project, 'add', '.')
  gitIn(project, 'commit', '-m', 'init')
  gitIn(project, 'branch', 'feature')
  const model = await startScriptedModel([{ text: '好的' }])
  const host = await launchDevice(port)
  const guest = await launchDevice(port)
  try {
    await configureCoderModel(host.window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(host.app, host.window, project)
    await startTask(host.window, '分支的任务')
    await waitTaskDone(host.window)

    // 本机：切到 feature
    const branch = host.window.getByTestId('branch-menu')
    await expect(branch).toContainText('main')
    await branch.click()
    await host.window.getByRole('menuitemradio', { name: 'feature' }).click()
    await expect(branch).toContainText('feature')
    expect(gitIn(project, 'branch', '--show-current')).toBe('feature')
    // 有未提交的改动：不切，说明原因
    writeFileSync(join(project, 'a.txt'), 'changed\n')
    await branch.click()
    await host.window.getByRole('menuitemradio', { name: 'main' }).click()
    await expect(host.window.getByText('工作区有未提交的改动，先提交或暂存再切换分支')).toBeVisible()
    expect(gitIn(project, 'branch', '--show-current')).toBe('feature')
    gitIn(project, 'checkout', '--', 'a.txt')

    // 远程：可操作的设备把对方切回 main
    await pair(host, guest, [], [project])
    await guest.window.getByTestId('sidebar').getByTestId('sidebar-remote-task').click()
    const remoteBranch = guest.window.getByTestId('remote-task').getByTestId('branch-menu')
    await expect(remoteBranch).toContainText('feature')
    await remoteBranch.click()
    await guest.window.getByRole('menuitemradio', { name: 'main' }).click()
    await expect.poll(() => gitIn(project, 'branch', '--show-current')).toBe('main')
    await expect(remoteBranch).toContainText('main')
  } finally {
    await close([host, guest])
    await relay.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
  }
})

test('左下角的设备和用量：设备、用量、设置竖着排；设备那行右边是在线台数，有设备能操作本机时变琥珀色；面板里能操作的排最前、标出级别和正在看的任务；标题栏一直提示能操作本机的设备（收起侧栏、在设置页也在）；用量写今天的 token，点开能切今天、近 7 天、本月，看按模型和用得最多的任务', async () => {
  test.setTimeout(180_000)
  const { relay, port } = await startRelay()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-footer-'))
  const model = await startScriptedModel([{ text: '好的' }])
  const host = await launchDevice(port)
  const operator = await launchDevice(port)
  const viewer = await launchDevice(port)
  try {
    await configureCoderModel(host.window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(host.app, host.window, project)
    await startTask(host.window, '大家看的任务')
    await waitTaskDone(host.window)
    await operator.window.evaluate(`window.diffra.setRemoteName('能操作的电脑')`)
    await viewer.window.evaluate(`window.diffra.setRemoteName('只能看的电脑')`)
    await pair(host, viewer, [project])
    await pair(host, operator, [], [project])

    // 左下角竖着排三行：设备、用量、设置，一样宽、左边对齐
    const rows = host.window.getByTestId('sidebar-footer').getByRole('button')
    await expect(rows).toHaveCount(3)
    const boxes = await Promise.all([0, 1, 2].map(async (index) => (await rows.nth(index).boundingBox())!))
    expect(boxes.map((box) => box.x)).toEqual([boxes[0].x, boxes[0].x, boxes[0].x])
    expect(boxes.map((box) => box.width)).toEqual([boxes[0].width, boxes[0].width, boxes[0].width])
    expect(boxes[0].y).toBeLessThan(boxes[1].y)
    expect(boxes[1].y).toBeLessThan(boxes[2].y)
    await expect(rows.nth(2)).toHaveText('设置')

    // 设备那行：右边是在线台数，有设备能操作本机时是琥珀色
    const devices = host.window.getByTestId('devices-button')
    await expect(devices.getByTestId('devices-badge')).toHaveText('2')
    await expect(devices).toHaveAttribute('data-state-level', 'controlling')
    await expect(devices).toHaveAccessibleName('设备：2 台在线，1 台能操作本机')

    // 能操作的设备打开任务：面板里写它正在看哪个任务
    await operator.window.getByTestId('sidebar').getByTestId('sidebar-remote-task').click()
    await expect(operator.window.getByTestId('remote-task')).toContainText('好的')
    await devices.click()
    const panel = host.window.getByTestId('devices-panel')
    await expect(panel).toContainText('连着本机 · 2')
    const entries = panel.getByTestId('device-entry')
    await expect(entries).toHaveCount(2)
    await expect(entries.first()).toContainText('能操作的电脑')
    await expect(entries.first().getByTestId('device-level')).toHaveText('可查看和操作')
    await expect(entries.first().getByTestId('device-watching')).toHaveText('正在看「大家看的任务」')
    await expect(entries.last()).toContainText('只能看的电脑')
    await expect(entries.last().getByTestId('device-level')).toHaveText('可查看')
    await expect(entries.last().getByRole('button', { name: '断开' })).toHaveCount(0)
    // 等弹出动画结束再截图，浅色、深色各一张
    await host.window.waitForTimeout(400)
    await host.window.screenshot({ path: 'test-results/devices-footer-panel.png' })
    await host.window.emulateMedia({ colorScheme: 'dark' })
    await host.window.waitForTimeout(200)
    await host.window.screenshot({ path: 'test-results/devices-footer-panel-dark.png' })
    await host.window.emulateMedia({ colorScheme: 'light' })
    // 右上角的「连接设置」跳到设备连接
    await panel.getByRole('button', { name: '连接设置' }).click()
    await expect(settingsNav(host.window).getByRole('button', { name: '设备连接' })).toHaveAttribute('aria-current', 'page')
    await host.window.getByRole('button', { name: '返回' }).click()

    // 标题栏的提示：收起侧栏、进设置页也在
    const indicator = host.window.getByTestId('remote-control-indicator')
    await expect(indicator).toHaveText('「能操作的电脑」能操作本机')
    await host.window.keyboard.press('ControlOrMeta+B')
    await expect(host.window.getByTestId('sidebar')).toHaveCount(0)
    await expect(indicator).toBeVisible()
    await host.window.keyboard.press('ControlOrMeta+B')
    await host.window.getByTestId('sidebar').getByRole('button', { name: '设置', exact: true }).click()
    await expect(indicator).toBeVisible()
    await host.window.getByRole('button', { name: '返回' }).click()

    // 用量那行：右边写今天的 token，和用量统计一致
    const usageOf = (days: number) =>
      host.window.evaluate<number>(`(() => {
        const now = new Date()
        const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ${days}).toISOString()
        return window.diffra.usageSummary({ from, to: new Date(now.getTime() + 1000).toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).then((summary) => summary.totals.input + summary.totals.output)
      })()`)
    const format = (tokens: number) => (tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(1))}m` : tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens))
    const today = await usageOf(0)
    expect(today).toBeGreaterThan(0)
    const usage = host.window.getByTestId('usage-button')
    await expect(usage).toHaveText(`用量今天 ${format(today)}`)
    await host.window.screenshot({ path: 'test-results/devices-footer.png' })
    // 点开：今天的总数、按模型（只有脚本模型，占 100%）、用得最多的任务
    await usage.click()
    const usagePanel = host.window.getByTestId('usage-panel')
    await expect(usagePanel.getByTestId('usage-period')).toHaveAttribute('data-period', 'today')
    await expect(usagePanel.getByTestId('usage-total')).toHaveText(format(today))
    await expect(usagePanel.getByTestId('usage-model')).toHaveText(['scripted100%'])
    await expect(usagePanel.getByTestId('usage-task').first()).toContainText('大家看的任务')
    await host.window.waitForTimeout(400)
    await host.window.screenshot({ path: 'test-results/devices-footer-usage.png' })
    await host.window.emulateMedia({ colorScheme: 'dark' })
    await host.window.waitForTimeout(200)
    await host.window.screenshot({ path: 'test-results/devices-footer-usage-dark.png' })
    await host.window.emulateMedia({ colorScheme: 'light' })
    // 切到近 7 天：总数换成近 7 天的
    await usagePanel.getByRole('radio', { name: '近 7 天' }).click()
    await expect(usagePanel.getByTestId('usage-period')).toHaveAttribute('data-period', 'week')
    await expect(usagePanel.getByTestId('usage-total')).toHaveText(format(await usageOf(6)))
    // 点任务打开它；再点开、跳到用量详情
    await usagePanel.getByTestId('usage-task').first().click()
    await expect(usagePanel).toHaveCount(0)
    await expect(host.window.getByTestId('task-title')).toHaveText('大家看的任务')
    await usage.click()
    await host.window.getByTestId('usage-panel').getByRole('button', { name: '用量详情' }).click()
    await expect(settingsNav(host.window).getByRole('button', { name: '用量' })).toHaveAttribute('aria-current', 'page')
  } finally {
    await close([host, operator, viewer])
    await relay.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
  }
})
