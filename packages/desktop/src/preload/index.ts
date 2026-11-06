import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron'
import { type DiffraApi, IPC_CHANNELS, type UpdateStatus } from '../shared/ipc'

const api: DiffraApi = {
  getCoreStatus: () => ipcRenderer.invoke(IPC_CHANNELS.coreStatus),
  getAppVersion: () => ipcRenderer.invoke(IPC_CHANNELS.appVersion),
  getUpdateStatus: () => ipcRenderer.invoke(IPC_CHANNELS.updateStatus),
  onUpdateStatus: (listener) => {
    const handler = (_event: IpcRendererEvent, status: UpdateStatus) => listener(status)
    ipcRenderer.on(IPC_CHANNELS.updateStatusChanged, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.updateStatusChanged, handler)
  },
  checkForUpdates: () => ipcRenderer.invoke(IPC_CHANNELS.updateCheck),
  installUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.updateInstall),
}

contextBridge.exposeInMainWorld('diffra', api)
