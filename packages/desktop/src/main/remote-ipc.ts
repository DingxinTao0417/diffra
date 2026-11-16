import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { listSessions, remoteSnapshot } from '@diffra/core'
import { type PromptImage, PROMPT_IMAGE_TYPES } from '@diffra/core/types'
import { RELAY_HOST, RELAY_PATH } from '@diffra/relay/protocol'
import { askAnswersSchema, requestCallSchema } from '@diffra/remote/messages'
import { app, BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import { IPC_CHANNELS } from '../shared/ipc'
import { DEVICE_TRANSPORT, REMOTE_DEVICE_CONNECTION_ENABLED, type RemoteAction, type RemoteActionResult, type RemoteTaskCall, type RemoteTaskCallResult } from '../shared/remote'
import { coreConnection } from './core-process'
import { listBranches, switchBranch } from './project-branch'
import { parse } from './ipc-input'
import { onSessionEvent } from './session-events'
import { settlePermission } from './session-ipc'
import { DISCOVERY_PORT } from './remote/lan-discovery'
import { todoSync } from './todos-ipc'
import { type LanOptions, RemoteService } from './remote/service'
import { testOverridesAllowed } from './test-overrides'
import { deviceNameSchema, projectGrantSchema } from './remote/state'

const deviceId = z.string().regex(/^[0-9a-f]{32}$/)
const sessionId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/)
const promptText = z.string().trim().min(1).max(100_000)
const projects = z.array(projectGrantSchema).max(200)
const INVITE_TTL_SECONDS = 600
// 远程操作在本机界面上做，界面一直不回（比如卡住）时不让对方的请求和这里的记录一直挂着；连接端那边等 30 秒
const ACTION_TIMEOUT_MS = 30_000

const actionResultSchema = z.union([
  z.object({ ok: z.literal(true), sessionId: sessionId, queued: z.boolean() }),
  z.object({ ok: z.literal(false), error: z.string().max(2000) }),
])
const pendingActions = new Map<string, (result: RemoteActionResult) => void>()
// 压缩提问图片也交给界面（canvas 能解 WebP，主进程的 nativeImage 不能）；界面一直不回就当压不了
const COMPRESS_TIMEOUT_MS = 15_000
const compressResultSchema = z.array(z.object({ mimeType: z.enum(PROMPT_IMAGE_TYPES), data: z.base64() }).nullable())
const pendingCompress = new Map<string, (result: Array<PromptImage | null>) => void>()

function compressImages(images: PromptImage[]): Promise<Array<PromptImage | null>> {
  const window = BrowserWindow.getAllWindows()[0]
  if (!window) return Promise.resolve(images.map(() => null))
  return new Promise((resolve) => {
    const requestId = randomUUID()
    const timer = setTimeout(() => {
      pendingCompress.delete(requestId)
      resolve(images.map(() => null))
    }, COMPRESS_TIMEOUT_MS)
    pendingCompress.set(requestId, (result) => {
      clearTimeout(timer)
      resolve(result.length === images.length ? result : images.map(() => null))
    })
    window.webContents.send(IPC_CHANNELS.remoteCompress, { requestId, images })
  })
}

// 只有一个主窗口（关掉就退出），只交给它一个，免得同一个操作做两遍；还没有窗口（启动中、退出中）就做不了
function act(action: RemoteAction): Promise<RemoteActionResult> {
  const window = BrowserWindow.getAllWindows()[0]
  if (!window) return Promise.resolve({ ok: false, error: '对方的 Diffra 窗口没有打开，操作不了' })
  return new Promise((resolve) => {
    const requestId = randomUUID()
    const timer = setTimeout(() => {
      pendingActions.delete(requestId)
      resolve({ ok: false, error: '对方的 Diffra 界面没有回应' })
    }, ACTION_TIMEOUT_MS)
    pendingActions.set(requestId, (result) => {
      clearTimeout(timer)
      resolve(result)
    })
    window.webContents.send(IPC_CHANNELS.remoteAction, { requestId, action })
  })
}

// 远程设备读、操作任务：交给界面做（界面在后台载入任务，用本机的逻辑），一直不回就报错
const taskCallResultSchema = z.union([z.object({ ok: z.literal(true), value: z.unknown() }), z.object({ ok: z.literal(false), error: z.string().max(2000) })])
const pendingTaskCalls = new Map<string, (result: RemoteTaskCallResult) => void>()

function askHost(call: RemoteTaskCall): Promise<unknown> {
  const window = BrowserWindow.getAllWindows()[0]
  if (!window) return Promise.reject(new Error('对方的 Diffra 窗口没有打开'))
  return new Promise((resolve, reject) => {
    const requestId = randomUUID()
    const timer = setTimeout(() => {
      pendingTaskCalls.delete(requestId)
      reject(new Error('对方的 Diffra 界面没有回应'))
    }, ACTION_TIMEOUT_MS)
    pendingTaskCalls.set(requestId, (result) => {
      clearTimeout(timer)
      if (result.ok) resolve(result.value)
      else reject(new Error(result.error))
    })
    window.webContents.send(IPC_CHANNELS.remoteTaskCall, { requestId, call })
  })
}

function relayUrl(): string {
  const override = testOverridesAllowed() ? process.env.DIFFRA_RELAY_URL : undefined
  return override || `wss://${RELAY_HOST}${RELAY_PATH}`
}

// 局域网版的监听和发现。测试（只在测试数据目录里认）：DIFFRA_LAN_BIND 换成 127.0.0.1 不惊动防火墙，DIFFRA_LAN_DISCOVERY_PORT 各用各的端口，
// DIFFRA_LAN_ANNOUNCE_TO（「地址:端口」逗号分隔）单独发给另一个实例，DIFFRA_LAN_BROADCAST=0 不发组播、广播
function lanOptions(): LanOptions {
  const env = testOverridesAllowed() ? process.env : {}
  const discoveryPort = Number(env.DIFFRA_LAN_DISCOVERY_PORT)
  return {
    bind: env.DIFFRA_LAN_BIND || '0.0.0.0',
    port: 0,
    discoveryPort: Number.isInteger(discoveryPort) && discoveryPort > 0 ? discoveryPort : DISCOVERY_PORT,
    discoveryTargets: (env.DIFFRA_LAN_ANNOUNCE_TO ?? '').split(',').flatMap((item) => {
      const match = /^([\d.]+):(\d+)$/.exec(item.trim())
      return match ? [{ address: match[1]!, port: Number(match[2]) }] : []
    }),
    broadcast: env.DIFFRA_LAN_BROADCAST !== '0',
  }
}

function inviteTtlMs(): number {
  const override = testOverridesAllowed() ? Number(process.env.DIFFRA_INVITE_TTL_SECONDS) : NaN
  return (Number.isFinite(override) && override > 0 ? override : INVITE_TTL_SECONDS) * 1000
}

export function registerRemoteIpc(userDataDir: string): void {
  // 设备连接已下线：不启动中转连接，也不注册任何远程 IPC 接口。恢复时见 shared/remote.ts 的开关
  if (!REMOTE_DEVICE_CONNECTION_ENABLED) return
  const opening = RemoteService.open(userDataDir, {
    transport: DEVICE_TRANSPORT,
    todos: todoSync,
    lan: lanOptions(),
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
    act,
    ask: askHost,
    branches: listBranches,
    switchBranch,
    answerPermission: settlePermission,
    compressImages,
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
  ipcMain.handle(IPC_CHANNELS.remoteRespond, async (_event, rawId: unknown, rawApproved: unknown, rawProjects: unknown, rawTodos: unknown) =>
    (await service()).respond(parse(deviceId, rawId), parse(z.boolean(), rawApproved), parse(projects, rawProjects), parse(z.boolean().optional(), rawTodos) ?? false),
  )
  ipcMain.handle(IPC_CHANNELS.remoteUpdateGrant, async (_event, rawId: unknown, rawProjects: unknown, rawTodos: unknown) =>
    (await service()).updateGrant(parse(deviceId, rawId), parse(projects, rawProjects), parse(z.boolean().optional(), rawTodos)),
  )
  ipcMain.handle(IPC_CHANNELS.remoteSetPeerTodos, async (_event, rawId: unknown, rawEnabled: unknown) => (await service()).setPeerTodos(parse(deviceId, rawId), parse(z.boolean(), rawEnabled)))
  ipcMain.handle(IPC_CHANNELS.remoteRevoke, async (_event, rawId: unknown) => (await service()).revoke(parse(deviceId, rawId)))
  ipcMain.handle(IPC_CHANNELS.remoteAddDevice, async (_event, rawInvite: unknown, rawName: unknown) => {
    const name = parse(z.string().trim().max(60).nullable(), rawName)
    return (await service()).addDevice(parse(z.string().max(200), rawInvite), name || null)
  })
  ipcMain.handle(IPC_CHANNELS.remoteAddLanDevice, async (_event, rawId: unknown, rawCode: unknown, rawName: unknown) => {
    const name = parse(z.string().trim().max(60).nullable(), rawName)
    return (await service()).addLanDevice(parse(deviceId, rawId), parse(z.string().max(20), rawCode), name || null)
  })
  ipcMain.handle(IPC_CHANNELS.remoteCancelAdd, async () => (await service()).cancelAdd())
  ipcMain.handle(IPC_CHANNELS.remoteBrowse, async (_event, raw: unknown) => (await service()).browse(parse(z.boolean(), raw)))
  ipcMain.handle(IPC_CHANNELS.remoteRemovePeer, async (_event, rawId: unknown) => (await service()).removePeer(parse(deviceId, rawId)))
  ipcMain.handle(IPC_CHANNELS.remoteResetIdentity, async () => (await service()).resetIdentity())
  ipcMain.handle(IPC_CHANNELS.remoteAudit, async () => (await service()).recentAudit())
  ipcMain.handle(IPC_CHANNELS.remoteList, async (_event, rawId: unknown) => (await service()).remoteList(parse(deviceId, rawId)))
  ipcMain.handle(IPC_CHANNELS.remoteSubscribe, async (_event, rawId: unknown, rawSession: unknown, rawResume: unknown) =>
    (await service()).remoteSubscribe(parse(deviceId, rawId), parse(sessionId, rawSession), parse(z.object({ epoch: z.string().max(64), seq: z.number().int().nonnegative() }).optional(), rawResume)),
  )
  ipcMain.handle(IPC_CHANNELS.remotePage, async (_event, rawId: unknown, rawSession: unknown, rawBefore: unknown) =>
    (await service()).remotePage(parse(deviceId, rawId), parse(sessionId, rawSession), parse(z.number().int().nonnegative(), rawBefore)),
  )
  ipcMain.handle(IPC_CHANNELS.remoteToolOutput, async (_event, rawId: unknown, rawSession: unknown, rawTurn: unknown, rawTurnId: unknown, rawToolCallId: unknown) =>
    (await service()).remoteToolOutput(
      parse(deviceId, rawId),
      parse(sessionId, rawSession),
      parse(z.number().int().nonnegative(), rawTurn),
      parse(z.string().min(1).max(128), rawTurnId),
      parse(z.string().min(1).max(128), rawToolCallId),
    ),
  )
  ipcMain.handle(IPC_CHANNELS.remoteUnsubscribe, async (_event, rawId: unknown, rawSession: unknown) => (await service()).remoteUnsubscribe(parse(deviceId, rawId), parse(sessionId, rawSession)))
  ipcMain.handle(IPC_CHANNELS.remotePrompt, async (_event, rawId: unknown, rawSession: unknown, rawText: unknown) =>
    (await service()).remotePrompt(parse(deviceId, rawId), parse(sessionId, rawSession), parse(promptText, rawText)),
  )
  ipcMain.handle(IPC_CHANNELS.remoteCreate, async (_event, rawId: unknown, rawProject: unknown, rawText: unknown) =>
    (await service()).remoteCreate(parse(deviceId, rawId), parse(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), rawProject), parse(promptText, rawText)),
  )
  ipcMain.handle(IPC_CHANNELS.remoteCancel, async (_event, rawId: unknown, rawSession: unknown) => (await service()).remoteCancel(parse(deviceId, rawId), parse(sessionId, rawSession)))
  ipcMain.handle(IPC_CHANNELS.remotePermission, async (_event, rawId: unknown, rawRequest: unknown, rawOption: unknown, rawAnswers: unknown) =>
    (await service()).remoteRespondPermission(
      parse(deviceId, rawId),
      parse(z.string().regex(/^[A-Za-z0-9-]{1,64}$/), rawRequest),
      parse(z.union([z.enum(['allow_once', 'reject']), z.string().regex(/^ask-user-(?:option-\d{1,2}|submit|skip)$/)]), rawOption),
      parse(askAnswersSchema.optional(), rawAnswers),
    ),
  )
  ipcMain.handle(IPC_CHANNELS.remoteCompressRespond, (_event, rawRequestId: unknown, rawResult: unknown) => {
    const requestId = parse(z.string().min(1), rawRequestId)
    const resolve = pendingCompress.get(requestId)
    if (!resolve) return
    pendingCompress.delete(requestId)
    resolve(parse(compressResultSchema, rawResult))
  })
  ipcMain.handle(IPC_CHANNELS.remoteCall, async (_event, rawId: unknown, rawCall: unknown) => (await service()).remoteCall(parse(deviceId, rawId), parse(requestCallSchema, rawCall)))
  // 本机是被连接端：界面回的任务读取、操作结果
  ipcMain.handle(IPC_CHANNELS.remoteTaskCallRespond, (_event, rawRequestId: unknown, rawResult: unknown) => {
    const requestId = parse(z.string().min(1), rawRequestId)
    const resolve = pendingTaskCalls.get(requestId)
    if (!resolve) return
    pendingTaskCalls.delete(requestId)
    resolve(parse(taskCallResultSchema, rawResult))
  })
  // 本机是被连接端：界面做完远程操作回的结果
  ipcMain.handle(IPC_CHANNELS.remoteActionRespond, (_event, rawRequestId: unknown, rawResult: unknown) => {
    const requestId = parse(z.string().min(1), rawRequestId)
    const resolve = pendingActions.get(requestId)
    if (!resolve) return
    pendingActions.delete(requestId)
    resolve(parse(actionResultSchema, rawResult))
  })
}
