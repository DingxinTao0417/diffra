import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { createRelay, type Relay } from '../../relay/src/relay.ts'
import { chooseProject, settingsNav, startTask, taskInput, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel, openModelsPage, providerCard } from './model-setup'
import { startScriptedModel } from './scripted-model'

// 设备连接：两个开发版实例（各自的临时数据目录）经测试进程里起的本机中转配对。不连真实的 relay.diffra.dev

interface Device {
  app: ElectronApplication
  window: Page
  userDataDir: string
}

async function startRelay(port = 0): Promise<{ relay: Relay; port: number }> {
  const relay = createRelay({ host: '127.0.0.1', port, trustProxy: false, release: 'e2e', log: () => {} })
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
  await window.getByRole('switch', { name: '允许连接本机' }).click()
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

test('设备连接：邀请串配对，被连接端核对指纹、选项目后允许；两边看到对方在线；修改授权、重新配对显示原来的授权、撤销后连接端马上看到离线；中转重启后自动重连；私钥加密存放', async () => {
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

    // 中转重启：两边自己重连，又看到对方在线
    await relay.close()
    await expect(peers.getByTestId('device-offline')).toBeVisible()
    ;({ relay } = await startRelay(port))
    await expect(peers.getByTestId('device-online')).toBeVisible({ timeout: 30_000 })
    await expect(grants.getByTestId('device-online')).toBeVisible({ timeout: 30_000 })

    // 撤销：连接端马上看到离线
    await grants.getByRole('button', { name: '撤销' }).click()
    await host.window.getByRole('alertdialog').getByRole('button', { name: '撤销' }).click()
    await expect(grants.getByTestId('grant')).toHaveCount(0)
    await expect(peers.getByTestId('device-offline')).toBeVisible()

    await host.window.getByRole('button', { name: '查看' }).click()
    const audit = host.window.getByTestId('audit')
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

// 被连接端开总开关、生成邀请串，连接端添加，被连接端只勾 project 并允许
async function pair(host: Device, guest: Device, project: string): Promise<void> {
  await allowIncoming(host.window)
  await addDevice(guest.window, await newInvite(host.window), '主机')
  const request = host.window.getByTestId('pair-request')
  await request.getByRole('checkbox', { name: `开放 ${basename(project)}` }).click()
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

test('设备连接：连接端在侧栏看到授权项目里的会话（别的项目看不到、直接要也被拒）；打开后看到脱敏的历史（图片只说带了几张）、实时看到对方正在跑的这一轮；只读；往前翻页；跑到一半中转重启，重连后不丢不重；两边逐轮内容一致；撤销后看到离线', async () => {
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
    await pair(host, guest, granted)

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

    // 打开：最近 10 轮，密钥脱敏，只读
    await remoteTasks.click()
    const remoteTask = guest.window.getByTestId('remote-task')
    await expect(remoteTask.getByTestId('remote-task-title')).toHaveText('远程看的任务')
    await expect(remoteTask.getByTestId('turn')).toHaveCount(10)
    await expect(remoteTask.getByRole('button', { name: '看更早的 2 轮' })).toBeVisible()
    await expect(remoteTask.getByRole('button', { name: '重新生成' })).toHaveCount(0)
    await expect(remoteTask.getByLabel('任务', { exact: true })).toHaveCount(0)
    await remoteTask.getByRole('button', { name: '看更早的 2 轮' }).click()
    await expect(remoteTask.getByTestId('turn')).toHaveCount(12)
    await expect(remoteTask).toContainText('第 1 轮回答，密钥是 [已脱敏：模型服务的 API Key]')
    await expect(remoteTask).not.toContainText(secret)
    await expect(remoteTask.getByTestId('turn').first()).toContainText('（带了 1 张图片，没有同步）')
    await expect(remoteTask.getByTestId('message-image')).toHaveCount(0)

    // 对方开始新的一轮：实时看到它在跑、回答到了
    await send(host.window, '实时的一轮')
    await expect(remoteTask.getByTestId('remote-task-running')).toBeVisible()
    await expect(remoteTask.getByTestId('turn')).toHaveCount(13)
    await expect(remoteTask).toContainText('实时回答到了', { timeout: 15_000 })
    await waitTaskDone(host.window)
    await expect(remoteTask.getByTestId('remote-task-running')).toHaveCount(0)
    await guest.window.screenshot({ path: 'test-results/devices-remote-task.png' })

    // 跑到一半中转重启：重连后重新订阅，回答只出现一次
    await send(host.window, '断线的一轮')
    await expect(remoteTask.getByTestId('turn')).toHaveCount(14)
    await expect(remoteTask).toContainText('断线前先说的话')
    await relay.close()
    await expect(guest.window.getByTestId('remote-offline')).toBeVisible()
    ;({ relay } = await startRelay(port))
    // 对方这一轮还没跑完时已经重连、重新订阅上了
    await expect(guest.window.getByTestId('remote-offline')).toHaveCount(0)
    await expect(remoteTask.getByTestId('remote-task-running')).toBeVisible()
    await expect(remoteTask).not.toContainText('断线后才回来的回答')
    await expect(remoteTask).toContainText('断线后才回来的回答', { timeout: 15_000 })
    await waitTaskDone(host.window)
    await expect(remoteTask.getByTestId('remote-task-running')).toHaveCount(0)
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
