import { createHash, randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  cancelSession,
  type CoreClientHandlers,
  createSession,
  previewCheckpoint,
  restoreCheckpoint,
  type SessionChecks,
  sendPrompt,
} from '@diffra/core'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { z } from 'zod'
import { IPC_CHANNELS, type PermissionRequestEvent, type ProjectState, type SessionHandle } from '../shared/ipc'
import { coreConnection } from './core-process'
import { parse } from './ipc-input'
import type { SecretStore } from './secret-store'
import { providerEndpoint } from './settings-ipc'
import { sessionChecksSchema, type SettingsStore } from './settings-store'

const NO_CHECKS: SessionChecks = { afterEdit: null, beforeFinish: null }

interface PendingPermission {
  sessionId: string
  resolve(optionId: string | null): void
}

const pendingPermissions = new Map<string, PendingPermission>()

function broadcast(channel: string, payload: unknown): number {
  const windows = BrowserWindow.getAllWindows()
  for (const window of windows) window.webContents.send(channel, payload)
  return windows.length
}

// core 推来的会话更新原样转给界面；权限请求等界面回复后再答复 core
export const coreClientHandlers: CoreClientHandlers = {
  onSessionUpdate: (notification) => {
    broadcast(IPC_CHANNELS.sessionUpdate, notification)
  },
  onPermissionRequest: (request) =>
    new Promise((resolve) => {
      const requestId = randomUUID()
      pendingPermissions.set(requestId, {
        sessionId: request.sessionId,
        resolve: (optionId) =>
          resolve({ outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } }),
      })
      const event: PermissionRequestEvent = {
        requestId,
        sessionId: request.sessionId,
        toolCall: request.toolCall,
        options: request.options,
      }
      // 没有窗口能回答时直接按取消处理，不让 core 一直等
      if (broadcast(IPC_CHANNELS.sessionPermission, event) === 0) settlePermission(requestId, null)
    }),
}

function settlePermission(requestId: string, optionId: string | null): void {
  const pending = pendingPermissions.get(requestId)
  if (!pending) return
  pendingPermissions.delete(requestId)
  pending.resolve(optionId)
}

export function registerSessionIpc(settings: SettingsStore, secrets: SecretStore, userDataDir: string): void {
  const projectState = (path: string): ProjectState => ({ path, checks: settings.get().projects[path]?.checks ?? NO_CHECKS })

  const rememberProject = (path: string) => settings.update((current) => ({ ...current, lastProject: path }))

  ipcMain.handle(IPC_CHANNELS.projectPick, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = { title: '选择项目文件夹', properties: ['openDirectory' as const] }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    const path = result.canceled ? undefined : result.filePaths[0]
    if (!path) return null
    await rememberProject(path)
    return projectState(path)
  })

  ipcMain.handle(IPC_CHANNELS.projectLast, async () => {
    const path = settings.get().lastProject
    if (!path) return null
    // 上次的目录可能已经被删掉或移走
    const info = await stat(path).catch(() => null)
    return info?.isDirectory() ? projectState(path) : null
  })

  ipcMain.handle(IPC_CHANNELS.projectSaveChecks, async (_event, rawPath: unknown, rawChecks: unknown) => {
    const path = parse(z.string().min(1), rawPath)
    const checks = parse(sessionChecksSchema, rawChecks)
    await settings.update((current) => ({ ...current, projects: { ...current.projects, [path]: { checks } } }))
    return projectState(path)
  })

  ipcMain.handle(IPC_CHANNELS.sessionCreate, async (_event, rawPath: unknown): Promise<SessionHandle> => {
    const path = parse(z.string().min(1), rawPath)
    const { roles, providers } = settings.get()
    const coder = roles.coder
    if (!coder) throw new Error('还没有给「编码」角色分配模型，请先到「模型」页设置')
    const provider = providers.find((item) => item.id === coder.providerId)
    const model = provider?.models.find((item) => item.id === coder.modelId)
    if (!provider || !model) throw new Error('「编码」角色指向的模型不存在，请到「模型」页重新分配')
    const target = await providerEndpoint(settings, secrets, provider.id)
    if (!target.ok) throw new Error(`「${provider.name}」${target.error.message}`)

    const { sessionId, info } = await createSession(await coreConnection(), path, {
      model: { endpoint: target.endpoint, modelId: model.id, contextWindow: model.contextWindow },
      checks: projectState(path).checks,
      checkpointDir: join(userDataDir, 'checkpoints', projectKey(path)),
    })
    await rememberProject(path)
    return { sessionId, info, modelLabel: `${provider.name} / ${model.id}` }
  })

  ipcMain.handle(IPC_CHANNELS.sessionPrompt, async (_event, rawSessionId: unknown, rawTurnId: unknown, rawText: unknown) => {
    const sessionId = parse(z.string().min(1), rawSessionId)
    const turnId = parse(z.string().min(1), rawTurnId)
    const text = parse(z.string().trim().min(1, '任务内容不能为空'), rawText)
    const response = await sendPrompt(await coreConnection(), sessionId, turnId, text)
    return response.stopReason
  })

  ipcMain.handle(IPC_CHANNELS.sessionCancel, async (_event, rawSessionId: unknown) => {
    const sessionId = parse(z.string().min(1), rawSessionId)
    // 正在等用户确认的请求一并按取消答复
    for (const [requestId, pending] of pendingPermissions) {
      if (pending.sessionId === sessionId) settlePermission(requestId, null)
    }
    await cancelSession(await coreConnection(), sessionId)
  })

  ipcMain.handle(IPC_CHANNELS.sessionPermissionRespond, (_event, rawRequestId: unknown, rawOptionId: unknown) => {
    settlePermission(parse(z.string().min(1), rawRequestId), parse(z.string().min(1).nullable(), rawOptionId))
  })

  ipcMain.handle(IPC_CHANNELS.checkpointPreview, async (_event, rawSessionId: unknown, rawTurnId: unknown) =>
    previewCheckpoint(await coreConnection(), parse(z.string().min(1), rawSessionId), parse(z.string().min(1), rawTurnId)),
  )

  ipcMain.handle(IPC_CHANNELS.checkpointRestore, async (_event, rawSessionId: unknown, rawTurnId: unknown) =>
    restoreCheckpoint(await coreConnection(), parse(z.string().min(1), rawSessionId), parse(z.string().min(1), rawTurnId)),
  )
}

// 每个项目一个检查点仓库；Windows 路径不分大小写
function projectKey(path: string): string {
  const normalized = process.platform === 'win32' ? path.toLowerCase() : path
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}
