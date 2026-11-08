import { contextBridge, ipcRenderer } from 'electron'

// 设计页的 preload 只有一个只发不收的通道：文档改了，主进程据此自动保存。设计页放开了 eval，别的能力一概不给。
// 通道名同 IPC_CHANNELS.designChanged；不 import shared/ipc：两个 preload 共用模块会被拆成公共 chunk，沙箱里的 preload 加载不了
const DESIGN_CHANGED = 'design:changed'

contextBridge.exposeInMainWorld('diffraDesignHost', {
  changed: () => ipcRenderer.send(DESIGN_CHANGED),
})
