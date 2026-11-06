import type { SessionNotification } from '@diffra/core/types'
import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron'
import { type DiffraApi, IPC_CHANNELS, type PermissionRequestEvent, type UpdateStatus } from '../shared/ipc'

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T) => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: DiffraApi = {
  getCoreStatus: () => ipcRenderer.invoke(IPC_CHANNELS.coreStatus),
  getAppVersion: () => ipcRenderer.invoke(IPC_CHANNELS.appVersion),
  getUpdateStatus: () => ipcRenderer.invoke(IPC_CHANNELS.updateStatus),
  onUpdateStatus: (listener) => subscribe<UpdateStatus>(IPC_CHANNELS.updateStatusChanged, listener),
  checkForUpdates: () => ipcRenderer.invoke(IPC_CHANNELS.updateCheck),
  installUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.updateInstall),
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
  saveProvider: (input) => ipcRenderer.invoke(IPC_CHANNELS.providerSave, input),
  deleteProvider: (providerId) => ipcRenderer.invoke(IPC_CHANNELS.providerDelete, providerId),
  setRole: (role, ref) => ipcRenderer.invoke(IPC_CHANNELS.roleSet, role, ref),
  listProviderModels: (providerId) => ipcRenderer.invoke(IPC_CHANNELS.modelsList, providerId),
  testProviderModel: (providerId, modelId) => ipcRenderer.invoke(IPC_CHANNELS.modelsTest, providerId, modelId),
  pickProject: () => ipcRenderer.invoke(IPC_CHANNELS.projectPick),
  getLastProject: () => ipcRenderer.invoke(IPC_CHANNELS.projectLast),
  saveProjectChecks: (path, checks) => ipcRenderer.invoke(IPC_CHANNELS.projectSaveChecks, path, checks),
  createSession: (projectPath) => ipcRenderer.invoke(IPC_CHANNELS.sessionCreate, projectPath),
  sendPrompt: (sessionId, turnId, text) => ipcRenderer.invoke(IPC_CHANNELS.sessionPrompt, sessionId, turnId, text),
  cancelSession: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.sessionCancel, sessionId),
  onSessionUpdate: (listener) => subscribe<SessionNotification>(IPC_CHANNELS.sessionUpdate, listener),
  onPermissionRequest: (listener) => subscribe<PermissionRequestEvent>(IPC_CHANNELS.sessionPermission, listener),
  respondPermission: (requestId, optionId) => ipcRenderer.invoke(IPC_CHANNELS.sessionPermissionRespond, requestId, optionId),
  previewCheckpoint: (sessionId, turnId) => ipcRenderer.invoke(IPC_CHANNELS.checkpointPreview, sessionId, turnId),
  restoreCheckpoint: (sessionId, turnId) => ipcRenderer.invoke(IPC_CHANNELS.checkpointRestore, sessionId, turnId),
}

contextBridge.exposeInMainWorld('diffra', api)
