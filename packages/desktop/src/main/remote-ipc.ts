import { hostname } from 'node:os'
import { listSessions, remoteSnapshot } from '@diffra/core'
import { RELAY_HOST, RELAY_PATH } from '@diffra/relay/protocol'
import { app, BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import { IPC_CHANNELS } from '../shared/ipc'
import { coreConnection } from './core-process'
import { parse } from './ipc-input'
import { onSessionEvent } from './session-events'
import { RemoteService } from './remote/service'
import { deviceNameSchema, projectGrantSchema } from './remote/state'

const deviceId = z.string().regex(/^[0-9a-f]{32}$/)
const sessionId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/)
const projects = z.array(projectGrantSchema).max(200)
const INVITE_TTL_SECONDS = 600

// 只在未打包时认环境变量：开发和 e2e 连本机的中转、缩短邀请串有效期（规则同 DIFFRA_UPDATE_URL）
function relayUrl(): string {
  const override = app.isPackaged ? undefined : process.env.DIFFRA_RELAY_URL
  return override || `wss://${RELAY_HOST}${RELAY_PATH}`
}

function inviteTtlMs(): number {
  const override = app.isPackaged ? NaN : Number(process.env.DIFFRA_INVITE_TTL_SECONDS)
  return (Number.isFinite(override) && override > 0 ? override : INVITE_TTL_SECONDS) * 1000
}

export function registerRemoteIpc(userDataDir: string): void {
  const opening = RemoteService.open(userDataDir, {
    relayUrl: relayUrl(),
    appVersion: app.getVersion(),
    inviteTtlMs: inviteTtlMs(),
    defaultName: hostname(),
    publish: (view) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send(IPC_CHANNELS.remoteState, view)
    },
    publishSync: (event) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send(IPC_CHANNELS.remoteEvent, event)
    },
    listSessions: async () => listSessions(await coreConnection()),
    snapshot: async (params) => remoteSnapshot(await coreConnection(), params),
  })
  opening.then(
    (service) => onSessionEvent((event) => service.sessionEvent(event)),
    (error: unknown) => console.error('[remote] 设备连接启动失败', error),
  )
  const service = () => opening

  ipcMain.handle(IPC_CHANNELS.remoteGetState, async () => (await service()).view())
  ipcMain.handle(IPC_CHANNELS.remoteSetAllowIncoming, async (_event, raw: unknown) => (await service()).setAllowIncoming(parse(z.boolean(), raw)))
  ipcMain.handle(IPC_CHANNELS.remoteSetName, async (_event, raw: unknown) => (await service()).setName(parse(deviceNameSchema, raw)))
  ipcMain.handle(IPC_CHANNELS.remoteCreateInvite, async () => (await service()).createInvite())
  ipcMain.handle(IPC_CHANNELS.remoteCancelInvite, async () => (await service()).cancelInvite())
  ipcMain.handle(IPC_CHANNELS.remoteRespond, async (_event, rawId: unknown, rawApproved: unknown, rawProjects: unknown) =>
    (await service()).respond(parse(deviceId, rawId), parse(z.boolean(), rawApproved), parse(projects, rawProjects)),
  )
  ipcMain.handle(IPC_CHANNELS.remoteUpdateGrant, async (_event, rawId: unknown, rawProjects: unknown) => (await service()).updateGrant(parse(deviceId, rawId), parse(projects, rawProjects)))
  ipcMain.handle(IPC_CHANNELS.remoteRevoke, async (_event, rawId: unknown) => (await service()).revoke(parse(deviceId, rawId)))
  ipcMain.handle(IPC_CHANNELS.remoteAddDevice, async (_event, rawInvite: unknown, rawName: unknown) => {
    const name = parse(z.string().trim().max(60).nullable(), rawName)
    return (await service()).addDevice(parse(z.string().max(200), rawInvite), name || null)
  })
  ipcMain.handle(IPC_CHANNELS.remoteCancelAdd, async () => (await service()).cancelAdd())
  ipcMain.handle(IPC_CHANNELS.remoteRemovePeer, async (_event, rawId: unknown) => (await service()).removePeer(parse(deviceId, rawId)))
  ipcMain.handle(IPC_CHANNELS.remoteResetIdentity, async () => (await service()).resetIdentity())
  ipcMain.handle(IPC_CHANNELS.remoteAudit, async () => (await service()).recentAudit())
  ipcMain.handle(IPC_CHANNELS.remoteList, async (_event, rawId: unknown) => (await service()).remoteList(parse(deviceId, rawId)))
  ipcMain.handle(IPC_CHANNELS.remoteSubscribe, async (_event, rawId: unknown, rawSession: unknown) => (await service()).remoteSubscribe(parse(deviceId, rawId), parse(sessionId, rawSession)))
  ipcMain.handle(IPC_CHANNELS.remotePage, async (_event, rawId: unknown, rawSession: unknown, rawBefore: unknown) =>
    (await service()).remotePage(parse(deviceId, rawId), parse(sessionId, rawSession), parse(z.number().int().nonnegative(), rawBefore)),
  )
  ipcMain.handle(IPC_CHANNELS.remoteUnsubscribe, async (_event, rawId: unknown, rawSession: unknown) => (await service()).remoteUnsubscribe(parse(deviceId, rawId), parse(sessionId, rawSession)))
}
