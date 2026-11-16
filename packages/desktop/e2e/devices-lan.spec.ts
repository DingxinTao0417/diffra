import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, waitTaskDone } from './flows'
import { freeUdpPort, lanEnv, launchDevice, openDevices } from './lan'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

// 局域网设备连接（v2 · M6）：同一台机器上两个实例（见 lan.ts）
test('局域网设备连接：发现对方、核对证书指纹、输入 6 位配对码，对方选项目后允许；只连局域网地址，证书钉住；连接端看到授权项目里的任务、能远程发消息；对方重启后自动连回来；撤销后马上离线', async () => {
  test.setTimeout(240_000)
  const [hostPort, guestPort] = [await freeUdpPort(), await freeUdpPort()]
  const workspace = mkdtempSync(join(tmpdir(), 'diffra-e2e-lan-'))
  const project = join(workspace, 'shared-project')
  execFileSync('git', ['init', '-q', project])
  writeFileSync(join(project, 'README.md'), '项目')
  const model = await startScriptedModel([{ text: '本机先回一句' }, { text: '收到远程来的消息' }])
  let host = await launchDevice(lanEnv(hostPort, guestPort))
  const guest = await launchDevice(lanEnv(guestPort, hostPort))
  try {
    // 被连接端：先有一个任务；打开「允许连接本机」、起名、生成配对码
    await configureCoderModel(host.window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(host.app, host.window, project)
    await startTask(host.window, '本机的任务')
    await waitTaskDone(host.window)
    await openDevices(host.window, '允许连接本机')
    await host.window.getByRole('switch', { name: '允许连接本机' }).click()
    await expect(host.window.getByTestId('relay-status')).toHaveText('局域网服务已开')
    await host.window.getByLabel('本机名称').fill('主机')
    await host.window.getByLabel('本机名称').press('Enter')
    const certificate = ((await host.window.getByTestId('host-certificate').textContent()) ?? '').trim()
    expect(certificate).toMatch(/^[0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4}$/)
    await host.window.getByRole('button', { name: '生成配对码' }).click()
    const code = ((await host.window.getByTestId('invite-text').textContent()) ?? '').trim()
    expect(code).toMatch(/^\d{3} \d{3}$/)
    await host.window.screenshot({ path: 'test-results/devices-lan-host.png' })

    // 连接端：局域网里看到「主机」在等配对，证书指纹和对方页面上的一样；选中、输入配对码
    await openDevices(guest.window, '连接其他设备')
    await guest.window.getByRole('button', { name: '添加设备' }).click()
    const found = guest.window.getByTestId('lan-device').filter({ hasText: '主机' })
    await expect(found).toContainText('等配对', { timeout: 15_000 })
    await expect(found).toContainText(certificate)
    await expect(found).toContainText('127.0.0.1')
    await found.click()
    await expect(guest.window.getByRole('dialog')).toContainText(`对方「允许连接本机」页上的证书指纹应该是 ${certificate}`)
    await guest.window.getByLabel('配对码').fill(code)
    await guest.window.screenshot({ path: 'test-results/devices-lan-add.png' })
    await guest.window.getByRole('button', { name: '添加', exact: true }).click()
    const guestFingerprint = ((await guest.window.getByTestId('self-fingerprint').textContent()) ?? '').trim()

    // 被连接端核对对方指纹、开放项目（可查看和操作），允许
    const request = host.window.getByTestId('pair-request')
    await expect(request).toBeVisible({ timeout: 30_000 })
    await expect(request.getByTestId('pair-request-fingerprint')).toHaveText(guestFingerprint)
    await request.getByRole('checkbox', { name: `开放 ${basename(project)}` }).click()
    await request.getByRole('radio', { name: '可查看和操作' }).click()
    await request.getByRole('button', { name: '允许' }).click()

    const peers = guest.window.getByTestId('peers')
    await expect(peers.getByTestId('peer')).toContainText('主机')
    await expect(peers.getByTestId('device-online')).toBeVisible({ timeout: 15_000 })
    const grants = host.window.getByTestId('grants')
    await expect(grants.getByTestId('device-online')).toBeVisible()
    // 配对码用过就作废；证书指纹钉在配对记录里，证书私钥加密存放
    await expect(host.window.getByTestId('invite-text')).toHaveCount(0)
    const hostState = JSON.parse(readFileSync(join(host.userDataDir, 'remote', 'state.json'), 'utf8')) as { grants: Array<{ tls?: string }> }
    const guestState = JSON.parse(readFileSync(join(guest.userDataDir, 'remote', 'state.json'), 'utf8')) as { peers: Array<{ tls?: string; lan?: { address: string } }> }
    expect(hostState.grants[0]?.tls).toMatch(/^[0-9a-f]{64}$/)
    expect(guestState.peers[0]?.tls?.slice(0, 16).toUpperCase()).toBe(certificate.replaceAll(' ', ''))
    expect(guestState.peers[0]?.lan?.address).toBe('127.0.0.1')
    for (const device of [host, guest]) expect(readFileSync(join(device.userDataDir, 'remote', 'tls.json'), 'utf8')).not.toContain('PRIVATE KEY')

    // 连接端：侧栏里有对方开放的项目和任务，打开看到内容，能远程发消息（对方执行）
    await guest.window.getByRole('button', { name: '返回' }).click()
    const sidebar = guest.window.getByTestId('sidebar')
    await expect(sidebar.getByTestId('sidebar-remote-project')).toContainText(basename(project), { timeout: 15_000 })
    const remoteTask = guest.window.getByTestId('remote-task')
    await sidebar.getByTestId('sidebar-remote-task').filter({ hasText: '本机的任务' }).click({ timeout: 15_000 })
    await expect(remoteTask.getByTestId('task-title')).toHaveText('本机的任务')
    await expect(remoteTask).toContainText('本机先回一句')
    await expect(remoteTask.getByTestId('remote-task-level')).toHaveText('可操作')
    const composer = remoteTask.getByLabel('任务', { exact: true })
    await composer.fill('远程发的消息')
    await composer.press('Control+Enter')
    await expect(remoteTask).toContainText('收到远程来的消息', { timeout: 30_000 })
    await guest.window.screenshot({ path: 'test-results/devices-lan-remote-task.png' })

    // 被连接端重启：连接端看到离线，又自动连回来（对方换了端口，发现服务里报新的）
    await openDevices(guest.window, '连接其他设备')
    await host.app.close()
    await expect(peers.getByTestId('device-offline')).toBeVisible({ timeout: 15_000 })
    host = await launchDevice(host.env, host.userDataDir)
    await expect(peers.getByTestId('device-online')).toBeVisible({ timeout: 30_000 })

    // 撤销：连接端马上离线，连不回来
    await openDevices(host.window, '允许连接本机')
    await host.window.getByTestId('grants').getByRole('button', { name: '撤销' }).click()
    await host.window.getByRole('alertdialog').getByRole('button', { name: '撤销' }).click()
    await expect(peers.getByTestId('device-offline')).toBeVisible({ timeout: 15_000 })
    await guest.window.waitForTimeout(3000)
    await expect(peers.getByTestId('device-offline')).toBeVisible()
  } finally {
    for (const device of [host, guest]) {
      await device.app.close().catch(() => {})
      rmSync(device.userDataDir, { recursive: true, force: true })
    }
    await model.close()
    rmSync(workspace, { recursive: true, force: true })
  }
})
