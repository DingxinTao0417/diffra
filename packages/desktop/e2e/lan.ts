import { createSocket } from 'node:dgram'
import { type ElectronApplication, expect, type Page } from '@playwright/test'
import { settingsNav } from './flows'
import { launchApp, makeUserDataDir } from './launch'

// 局域网设备连接（v2）的 e2e 公用部分：同一台机器上两个实例，都只听 127.0.0.1（不惊动防火墙），发现消息互相单发（不发组播、广播）
export interface Device {
  app: ElectronApplication
  window: Page
  userDataDir: string
  env: Record<string, string>
}

export async function freeUdpPort(): Promise<number> {
  const socket = createSocket('udp4')
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve))
  const port = socket.address().port
  await new Promise<void>((resolve) => socket.close(() => resolve()))
  return port
}

export const lanEnv = (own: number, other: number) => ({ DIFFRA_LAN_BIND: '127.0.0.1', DIFFRA_LAN_BROADCAST: '0', DIFFRA_LAN_DISCOVERY_PORT: String(own), DIFFRA_LAN_ANNOUNCE_TO: `127.0.0.1:${other}` })

export async function launchDevice(env: Record<string, string>, userDataDir = makeUserDataDir()): Promise<Device> {
  const app = await launchApp(userDataDir, env)
  return { app, window: await app.firstWindow(), userDataDir, env }
}

export async function openDevices(window: Page, tab: '连接其他设备' | '允许连接本机'): Promise<void> {
  if (!(await settingsNav(window).isVisible())) await window.getByTestId('sidebar').getByRole('button', { name: '设置', exact: true }).click()
  await settingsNav(window).getByRole('button', { name: '设备连接' }).click()
  await window.getByRole('radio', { name: tab }).click()
}

// 被连接端打开「允许连接本机」、起名、生成配对码；连接端在局域网里找到它、输入配对码。返回时被连接端的配对确认已经弹出来了
export async function requestPairing(host: Device, guest: Device, hostName: string): Promise<{ certificate: string; guestFingerprint: string }> {
  await openDevices(host.window, '允许连接本机')
  await host.window.getByRole('switch', { name: '允许连接本机' }).click()
  await expect(host.window.getByTestId('relay-status')).toHaveText('局域网服务已开')
  await host.window.getByLabel('本机名称').fill(hostName)
  await host.window.getByLabel('本机名称').press('Enter')
  const certificate = ((await host.window.getByTestId('host-certificate').textContent()) ?? '').trim()
  await host.window.getByRole('button', { name: '生成配对码' }).click()
  const code = ((await host.window.getByTestId('invite-text').textContent()) ?? '').trim()

  await openDevices(guest.window, '连接其他设备')
  await guest.window.getByRole('button', { name: '添加设备' }).click()
  const found = guest.window.getByTestId('lan-device').filter({ hasText: hostName })
  await expect(found).toContainText('等配对', { timeout: 15_000 })
  await expect(found).toContainText(certificate)
  await found.click()
  await guest.window.getByLabel('配对码').fill(code)
  await guest.window.getByRole('button', { name: '添加', exact: true }).click()
  const guestFingerprint = ((await guest.window.getByTestId('self-fingerprint').textContent()) ?? '').trim()
  await expect(host.window.getByTestId('pair-request')).toBeVisible({ timeout: 30_000 })
  return { certificate, guestFingerprint }
}
