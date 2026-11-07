import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { inspectPlugin } from '@diffra/core'
import type { PluginRef } from '@diffra/core/types'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { z } from 'zod'
import { IPC_CHANNELS } from '../shared/ipc'
import type { InstalledPlugin, PluginView } from '../shared/settings'
import { coreConnection } from './core-process'
import { parse } from './ipc-input'
import type { SettingsStore } from './settings-store'

const execFileAsync = promisify(execFile)
const CLONE_TIMEOUT_MS = 120_000

export function enabledPlugins(settings: SettingsStore): PluginRef[] {
  return settings
    .get()
    .plugins.filter((plugin) => plugin.enabled)
    .map((plugin) => ({ name: plugin.name, dir: plugin.dir }))
}

export function registerPluginsIpc(settings: SettingsStore, userDataDir: string): void {
  // 从 Git 装的插件克隆到这里；删除插件时只删这里面的目录
  const pluginsRoot = join(userDataDir, 'plugins')
  const ownsDir = (dir: string) => {
    const path = relative(pluginsRoot, resolve(dir))
    return path !== '' && !path.startsWith('..') && !path.includes(':')
  }

  const views = async (): Promise<PluginView[]> => {
    const connection = await coreConnection()
    return Promise.all(
      settings.get().plugins.map(async (plugin) => {
        try {
          return { ...plugin, info: await inspectPlugin(connection, plugin.dir), error: null }
        } catch (error) {
          return { ...plugin, info: null, error: error instanceof Error ? error.message : String(error) }
        }
      }),
    )
  }

  // 读清单拿到名字，重名的不装
  const register = async (dir: string, source: InstalledPlugin['source'], url: string | null, id = randomUUID()) => {
    const info = await inspectPlugin(await coreConnection(), dir)
    const existing = settings.get().plugins
    if (existing.some((plugin) => resolve(plugin.dir).toLowerCase() === resolve(dir).toLowerCase())) throw new Error('这个插件已经装过了')
    if (existing.some((plugin) => plugin.name.toLowerCase() === info.name.toLowerCase())) throw new Error(`已经装了名为「${info.name}」的插件`)
    const plugin: InstalledPlugin = { id, name: info.name, dir, source, url, enabled: true }
    await settings.update((current) => ({ ...current, plugins: [...current.plugins, plugin] }))
  }

  ipcMain.handle(IPC_CHANNELS.pluginsList, () => views())

  // 从文件夹装：就地使用那个文件夹，不复制；删除插件时也不动它
  ipcMain.handle(IPC_CHANNELS.pluginInstallFolder, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = { title: '选择插件文件夹', properties: ['openDirectory' as const] }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    const dir = result.canceled ? undefined : result.filePaths[0]
    if (!dir) return null
    await register(dir, 'folder', null)
    return views()
  })

  ipcMain.handle(IPC_CHANNELS.pluginInstallGit, async (_event, rawUrl: unknown) => {
    const url = parse(z.string().trim().regex(/^(https:\/\/|ssh:\/\/|git@|file:\/\/)\S+$/, '地址要以 https://、ssh://、git@ 或 file:// 开头'), rawUrl)
    const id = randomUUID()
    const dir = join(pluginsRoot, id)
    await mkdir(pluginsRoot, { recursive: true })
    try {
      await execFileAsync('git', ['clone', '--depth', '1', '--', url, dir], { timeout: CLONE_TIMEOUT_MS, windowsHide: true })
    } catch (error) {
      await rm(dir, { recursive: true, force: true })
      const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr).trim() : ''
      throw new Error(`克隆失败：${stderr || (error instanceof Error ? error.message : String(error))}`)
    }
    try {
      await register(dir, 'git', url, id)
    } catch (error) {
      await rm(dir, { recursive: true, force: true })
      throw error
    }
    return views()
  })

  ipcMain.handle(IPC_CHANNELS.pluginSetEnabled, async (_event, rawId: unknown, rawEnabled: unknown) => {
    const id = parse(z.string().min(1), rawId)
    const enabled = parse(z.boolean(), rawEnabled)
    await settings.update((current) => ({ ...current, plugins: current.plugins.map((plugin) => (plugin.id === id ? { ...plugin, enabled } : plugin)) }))
    return views()
  })

  ipcMain.handle(IPC_CHANNELS.pluginDelete, async (_event, rawId: unknown) => {
    const id = parse(z.string().min(1), rawId)
    const plugin = settings.get().plugins.find((item) => item.id === id)
    if (!plugin) return views()
    await settings.update((current) => ({ ...current, plugins: current.plugins.filter((item) => item.id !== id) }))
    if (plugin.source === 'git' && ownsDir(plugin.dir)) await rm(plugin.dir, { recursive: true, force: true })
    return views()
  })
}
