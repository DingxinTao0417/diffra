import { join } from 'node:path'
import {
  architectureAdd,
  architectureAnalyze,
  architectureBundle,
  architectureCancel,
  architectureInterpret,
  architectureInterpretModule,
  architectureList,
  architectureProposeTarget,
  architectureRemove,
  architectureRunning,
  architectureSaveDiagram,
  architectureSaveLayout,
  architectureSaveTarget,
  architectureSource,
  architectureStale,
  type SessionModel,
} from '@diffra/core'
import { INTERPRET_PARTS } from '@diffra/core/architecture'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { z } from 'zod'
import { IPC_CHANNELS } from '../shared/ipc'
import { coreConnection } from './core-process'
import { parse } from './ipc-input'

const projectId = z.string().min(1).max(64)
const relativePath = z.string().max(4096)

// 架构功能：请求原样转给 core，数据和分析都在 core；这里只管选文件夹、选模型、用系统程序打开文件
export function registerArchitectureIpc(architectureModel: () => Promise<SessionModel>): void {
  ipcMain.handle(IPC_CHANNELS.architectureList, async () => architectureList(await coreConnection()))
  ipcMain.handle(IPC_CHANNELS.architectureAdd, async (_event, raw: unknown) => architectureAdd(await coreConnection(), parse(z.string().min(1).max(4096), raw)))
  ipcMain.handle(IPC_CHANNELS.architecturePick, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = { title: '选择要分析的项目文件夹', properties: ['openDirectory' as const] }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    const path = result.canceled ? undefined : result.filePaths[0]
    return path ? architectureAdd(await coreConnection(), path) : null
  })
  ipcMain.handle(IPC_CHANNELS.architectureRemove, async (_event, raw: unknown) => architectureRemove(await coreConnection(), parse(projectId, raw)))
  ipcMain.handle(IPC_CHANNELS.architectureAnalyze, async (_event, raw: unknown) => architectureAnalyze(await coreConnection(), parse(projectId, raw)))
  ipcMain.handle(IPC_CHANNELS.architectureCancel, async (_event, raw: unknown) => architectureCancel(await coreConnection(), parse(projectId, raw)))
  ipcMain.handle(IPC_CHANNELS.architectureRunning, async () => architectureRunning(await coreConnection()))
  ipcMain.handle(IPC_CHANNELS.architectureBundle, async (_event, raw: unknown) => architectureBundle(await coreConnection(), parse(projectId, raw)))
  ipcMain.handle(IPC_CHANNELS.architectureStale, async (_event, raw: unknown) => (await architectureStale(await coreConnection(), parse(projectId, raw))).stale)
  ipcMain.handle(IPC_CHANNELS.architectureInterpret, async (_event, rawId: unknown, rawParts: unknown) =>
    architectureInterpret(await coreConnection(), parse(projectId, rawId), await architectureModel(), parse(z.array(z.enum(INTERPRET_PARTS)).min(1), rawParts)),
  )
  // 架构图的结构由 core 校验
  ipcMain.handle(IPC_CHANNELS.architectureSaveDiagram, async (_event, rawId: unknown, rawDiagram: unknown) =>
    architectureSaveDiagram(await coreConnection(), parse(projectId, rawId), rawDiagram as Parameters<typeof architectureSaveDiagram>[2]),
  )
  ipcMain.handle(IPC_CHANNELS.architectureInterpretModule, async (_event, rawId: unknown, rawPath: unknown) =>
    architectureInterpretModule(await coreConnection(), parse(projectId, rawId), parse(relativePath, rawPath), await architectureModel()),
  )
  ipcMain.handle(IPC_CHANNELS.architectureProposeTarget, async (_event, rawId: unknown, rawPrinciples: unknown) =>
    architectureProposeTarget(await coreConnection(), parse(projectId, rawId), parse(z.string().max(10_000), rawPrinciples), await architectureModel()),
  )
  // 目标架构和布局的结构由 core 校验
  ipcMain.handle(IPC_CHANNELS.architectureSaveTarget, async (_event, rawId: unknown, rawTarget: unknown) =>
    architectureSaveTarget(await coreConnection(), parse(projectId, rawId), rawTarget as Parameters<typeof architectureSaveTarget>[2]),
  )
  ipcMain.handle(IPC_CHANNELS.architectureSaveLayout, async (_event, rawId: unknown, rawLayout: unknown) =>
    architectureSaveLayout(await coreConnection(), parse(projectId, rawId), rawLayout as Parameters<typeof architectureSaveLayout>[2]),
  )
  ipcMain.handle(IPC_CHANNELS.architectureSource, async (_event, rawId: unknown, rawPath: unknown) => architectureSource(await coreConnection(), parse(projectId, rawId), parse(relativePath.min(1), rawPath)))
  ipcMain.handle(IPC_CHANNELS.architectureOpenFile, async (_event, rawId: unknown, rawPath: unknown) => {
    const connection = await coreConnection()
    const id = parse(projectId, rawId)
    const path = parse(relativePath.min(1), rawPath)
    // 先让 core 确认这是分析里列出的文件，再打开
    await architectureSource(connection, id, path)
    const project = (await architectureList(connection)).find((item) => item.id === id)
    if (!project) throw new Error('架构列表里没有这个项目')
    const message = await shell.openPath(join(project.path, path))
    if (message) throw new Error(`打不开文件：${message}`)
  })
}
