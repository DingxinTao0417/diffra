import { contextBridge, ipcRenderer } from 'electron'
import { type DiffraApi, IPC_CHANNELS } from '../shared/ipc'

const api: DiffraApi = {
  getCoreStatus: () => ipcRenderer.invoke(IPC_CHANNELS.coreStatus),
}

contextBridge.exposeInMainWorld('diffra', api)
