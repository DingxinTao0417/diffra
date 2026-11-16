import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { inspectPlugin } from '@diffra/core'
import type { PluginRef } from '@diffra/core/types'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { z } from 'zod'
import { catalogPlugin } from '../shared/extensions'
import { IPC_CHANNELS, type PluginPrepared, type PluginUpdateCheck, type PluginUpdatePrepared } from '../shared/ipc'
import type { InstalledPlugin, PluginView } from '../shared/settings'
import { loadCatalog } from './catalog'
import { catalogOverrides } from './extensions-ipc'
import { coreConnection } from './core-process'
import { parse } from './ipc-input'
import { diffDirs, recoverBackups, swapDir } from './plugin-swap'
import type { SettingsStore } from './settings-store'

const execFileAsync = promisify(execFile)
const CLONE_TIMEOUT_MS = 120_000
// 查新版本只问远端的提交号，不该很久
const LS_REMOTE_TIMEOUT_MS = 30_000
// 仓库里的子目录：相对路径，/ 分隔，不能有 . 和 .. 段
const SUBDIR = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)*$/
const gitUrlSchema = z.string().trim().regex(/^(https:\/\/|ssh:\/\/|git@|file:\/\/)\S+$/, '地址要以 https://、ssh://、git@ 或 file:// 开头')
const subdirSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
  .refine((value) => value === '' || SUBDIR.test(value), '子目录要写仓库里的相对路径，比如 plugins/feature-dev')

const prepareSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('folder') }),
  z.object({ kind: z.literal('git'), url: gitUrlSchema, subdir: subdirSchema }),
  z.object({ kind: z.literal('catalog'), id: z.string().min(1) }),
])

// 交给 core 的插件：用户允许过、而且现在还是那份钩子的，才带上钩子指纹（core 会再核对一次）
export function enabledPlugins(settings: SettingsStore): PluginRef[] {
  return settings
    .get()
    .plugins.filter((plugin) => plugin.enabled)
    .map((plugin) => ({ name: plugin.name, dir: plugin.dir, ...(plugin.hooksApproved ? { hooks: plugin.hooksApproved } : {}) }))
}

// 取回、读过还没装的插件：用户看过内容（尤其是钩子）点「安装」才登记。从 Git 来的先克隆到 plugins/.staging 下
interface Staged {
  id: string
  dir: string
  // 从 Git 来的：克隆所在的目录，装上时挪到 plugins/<id>
  clone: string | null
  source: InstalledPlugin['source']
  url: string | null
  subdir: string | null
  fingerprint: string | null
  // 插件更新取回的新版本：要换掉的插件 id（v2）
  updateOf?: string
}

// git 失败时用它的标准错误说原因
function gitFailure(error: unknown): string {
  const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr).trim() : ''
  return stderr || (error instanceof Error ? error.message : String(error))
}

export function registerPluginsIpc(settings: SettingsStore, userDataDir: string): void {
  // 从 Git 装的插件克隆到这里；删除插件时只删这里面的目录
  const pluginsRoot = join(userDataDir, 'plugins')
  const stagingRoot = join(pluginsRoot, '.staging')
  // 插件更新时旧版本暂放这里，换上新版本、验证过才删；换到一半应用崩了，下次启动挪回去
  const backupRoot = join(pluginsRoot, '.backup')
  const staged = new Map<string, Staged>()
  const ownsDir = (dir: string) => {
    const path = relative(pluginsRoot, resolve(dir))
    return path !== '' && !path.startsWith('..') && !path.includes(':')
  }
  // 克隆目录：plugins/<id>；以前的插件 dir 就是它，有子目录的插件 dir 在它下面
  const cloneDir = (plugin: InstalledPlugin) => join(pluginsRoot, plugin.id)
  // 暂存目录里只有取回了、没装也没取消的克隆（比如看钩子时关了应用），启动时清掉
  rm(stagingRoot, { recursive: true, force: true }).catch((error: unknown) => console.error('[plugins] 清理暂存的插件克隆失败', error))
  recoverBackups(pluginsRoot, backupRoot).then(
    (restored) => restored.length > 0 && console.warn(`[plugins] 上次更新到一半，恢复了原来的版本：${restored.join('、')}`),
    (error: unknown) => console.error('[plugins] 恢复更新前的备份失败', error),
  )
  // 不弹凭据输入：私有仓库要密码时直接失败，不卡到超时
  const gitOutput = async (args: string[], timeout: number) =>
    (await execFileAsync('git', args, { timeout, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim()

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

  const discard = async (token: string) => {
    const item = staged.get(token)
    staged.delete(token)
    if (item?.clone) await rm(item.clone, { recursive: true, force: true })
  }

  // 读清单拿到名字，重名、装过的不装
  const stage = async (item: Omit<Staged, 'fingerprint'>): Promise<PluginPrepared> => {
    try {
      const info = await inspectPlugin(await coreConnection(), item.dir)
      const existing = settings.get().plugins
      if (item.source === 'folder' && existing.some((plugin) => resolve(plugin.dir).toLowerCase() === resolve(item.dir).toLowerCase())) throw new Error('这个插件已经装过了')
      if (existing.some((plugin) => plugin.name.toLowerCase() === info.name.toLowerCase())) throw new Error(`已经装了名为「${info.name}」的插件`)
      const token = randomUUID()
      staged.set(token, { ...item, fingerprint: info.hooksFingerprint })
      return { token, info, source: item.source, location: item.source === 'git' ? [item.url, item.subdir].filter(Boolean).join(' · ') : item.dir }
    } catch (error) {
      if (item.clone) await rm(item.clone, { recursive: true, force: true })
      throw error
    }
  }

  // 只取要的子目录：浅克隆、不先下载文件内容，再稀疏检出那个目录
  const clone = async (url: string, subdir: string | null): Promise<Omit<Staged, 'fingerprint'>> => {
    const id = randomUUID()
    const dir = join(stagingRoot, id)
    await mkdir(stagingRoot, { recursive: true })
    const git = (args: string[]) => execFileAsync('git', args, { timeout: CLONE_TIMEOUT_MS, windowsHide: true })
    try {
      await git(['clone', '--depth', '1', ...(subdir ? ['--filter=blob:none', '--sparse'] : []), '--', url, dir])
      if (subdir) await git(['-C', dir, 'sparse-checkout', 'set', '--', subdir])
    } catch (error) {
      await rm(dir, { recursive: true, force: true })
      const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr).trim() : ''
      throw new Error(`克隆失败：${stderr || (error instanceof Error ? error.message : String(error))}`)
    }
    const pluginDir = subdir ? join(dir, ...subdir.split('/')) : dir
    if (!(await stat(pluginDir).then((info) => info.isDirectory(), () => false))) {
      await rm(dir, { recursive: true, force: true })
      throw new Error(`仓库里没有 ${subdir} 这个目录`)
    }
    return { id, dir: pluginDir, clone: dir, source: 'git', url, subdir }
  }

  ipcMain.handle(IPC_CHANNELS.pluginsList, () => views())

  // 第一步：取回并读出插件里有什么，给用户看；从文件夹装时就地使用那个文件夹，不复制
  ipcMain.handle(IPC_CHANNELS.pluginPrepare, async (event, raw: unknown): Promise<PluginPrepared | null> => {
    const source = parse(prepareSchema, raw)
    if (source.kind === 'folder') {
      const window = BrowserWindow.fromWebContents(event.sender)
      const options = { title: '选择插件文件夹', properties: ['openDirectory' as const] }
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      const dir = result.canceled ? undefined : result.filePaths[0]
      if (!dir) return null
      return stage({ id: randomUUID(), dir, clone: null, source: 'folder', url: null, subdir: null })
    }
    if (source.kind === 'git') return stage(await clone(source.url, source.subdir || null))
    const entry = catalogPlugin(source.id, (await loadCatalog('cached')).plugins)
    if (!entry) throw new Error('目录里没有这个插件')
    const override = catalogOverrides().plugins[entry.id]
    return stage(await clone(override?.repo ?? entry.repo, override ? override.path : entry.path))
  })

  // 第二步：用户看过点了安装。allowHooks 是用户勾了「允许钩子」，记下当时钩子的指纹
  ipcMain.handle(IPC_CHANNELS.pluginCommit, async (_event, rawToken: unknown, rawAllowHooks: unknown) => {
    const token = parse(z.string().min(1), rawToken)
    const allowHooks = parse(z.boolean(), rawAllowHooks)
    const item = staged.get(token)
    if (!item || item.updateOf) throw new Error('安装已经取消或过期了，请重新安装')
    staged.delete(token)
    let dir = item.dir
    if (item.clone) {
      const target = join(pluginsRoot, item.id)
      await rename(item.clone, target)
      dir = item.subdir ? join(target, ...item.subdir.split('/')) : target
    }
    try {
      const info = await inspectPlugin(await coreConnection(), dir)
      if (settings.get().plugins.some((plugin) => plugin.name.toLowerCase() === info.name.toLowerCase())) throw new Error(`已经装了名为「${info.name}」的插件`)
      const hooksApproved = allowHooks && info.hooksFingerprint === item.fingerprint ? info.hooksFingerprint : null
      const plugin: InstalledPlugin = { id: item.id, name: info.name, dir, source: item.source, url: item.url, subdir: item.subdir, enabled: true, hooksApproved }
      await settings.update((current) => ({ ...current, plugins: [...current.plugins, plugin] }))
    } catch (error) {
      if (item.clone) await rm(join(pluginsRoot, item.id), { recursive: true, force: true })
      throw error
    }
    return views()
  })

  ipcMain.handle(IPC_CHANNELS.pluginDiscard, async (_event, rawToken: unknown) => {
    await discard(parse(z.string().min(1), rawToken))
  })

  ipcMain.handle(IPC_CHANNELS.pluginSetEnabled, async (_event, rawId: unknown, rawEnabled: unknown) => {
    const id = parse(z.string().min(1), rawId)
    const enabled = parse(z.boolean(), rawEnabled)
    await settings.update((current) => ({ ...current, plugins: current.plugins.map((plugin) => (plugin.id === id ? { ...plugin, enabled } : plugin)) }))
    return views()
  })

  // 允许或撤销钩子；允许时记下现在的钩子，之后再变要重新允许
  ipcMain.handle(IPC_CHANNELS.pluginSetHooks, async (_event, rawId: unknown, rawAllowed: unknown) => {
    const id = parse(z.string().min(1), rawId)
    const allowed = parse(z.boolean(), rawAllowed)
    const plugin = settings.get().plugins.find((item) => item.id === id)
    if (!plugin) return views()
    const hooksApproved = allowed ? (await inspectPlugin(await coreConnection(), plugin.dir)).hooksFingerprint : null
    await settings.update((current) => ({ ...current, plugins: current.plugins.map((item) => (item.id === id ? { ...item, hooksApproved } : item)) }))
    return views()
  })

  // 插件更新（v2）：只管从 Git 装的；本地文件夹的由用户自己改
  ipcMain.handle(IPC_CHANNELS.pluginCheckUpdates, async (): Promise<PluginUpdateCheck[]> =>
    Promise.all(
      settings
        .get()
        .plugins.filter((plugin) => plugin.source === 'git' && plugin.url)
        .map(async (plugin): Promise<PluginUpdateCheck> => {
          try {
            const [current, remote] = await Promise.all([
              gitOutput(['-C', cloneDir(plugin), 'rev-parse', 'HEAD'], LS_REMOTE_TIMEOUT_MS),
              gitOutput(['ls-remote', '--', plugin.url!, 'HEAD'], LS_REMOTE_TIMEOUT_MS),
            ])
            const latest = remote.split(/\s+/)[0]
            if (!latest) throw new Error('远端仓库没有默认分支')
            return { pluginId: plugin.id, state: latest === current ? 'latest' : 'available', current, latest, error: null }
          } catch (error) {
            console.warn(`[plugins] 检查 ${plugin.name} 的新版本失败`, error)
            return { pluginId: plugin.id, state: 'error', current: null, latest: null, error: gitFailure(error) }
          }
        }),
    ),
  )

  // 取回新版本：克隆到暂存目录读一遍，和装着的比；名字变了不算更新
  ipcMain.handle(IPC_CHANNELS.pluginPrepareUpdate, async (_event, rawId: unknown): Promise<PluginUpdatePrepared> => {
    const id = parse(z.string().min(1), rawId)
    const plugin = settings.get().plugins.find((item) => item.id === id)
    if (!plugin || plugin.source !== 'git' || !plugin.url) throw new Error('只有从 Git 装的插件能更新')
    const item = await clone(plugin.url, plugin.subdir)
    try {
      const connection = await coreConnection()
      const [before, info] = await Promise.all([inspectPlugin(connection, plugin.dir).catch(() => null), inspectPlugin(connection, item.dir)])
      if (info.name.toLowerCase() !== plugin.name.toLowerCase()) throw new Error(`新版本的插件名是「${info.name}」，和装着的「${plugin.name}」不一样，不能当成更新；要用就删掉再装`)
      const [fromCommit, toCommit, diff] = await Promise.all([
        gitOutput(['-C', cloneDir(plugin), 'rev-parse', 'HEAD'], LS_REMOTE_TIMEOUT_MS).catch(() => null),
        gitOutput(['-C', item.clone!, 'rev-parse', 'HEAD'], LS_REMOTE_TIMEOUT_MS).catch(() => null),
        diffDirs(plugin.dir, item.dir),
      ])
      const hooks = info.hooksFingerprint === null ? 'none' : info.hooksFingerprint === plugin.hooksApproved ? 'same' : 'changed'
      const token = randomUUID()
      staged.set(token, { ...item, fingerprint: info.hooksFingerprint, updateOf: plugin.id })
      return { token, pluginId: plugin.id, info, fromVersion: before?.version || null, fromCommit, toCommit, ...diff, hooks }
    } catch (error) {
      await rm(item.clone!, { recursive: true, force: true })
      throw error
    }
  })

  // 换上新版本：旧的挪到备份，新的挪过去，读一遍、改设置；哪步失败都恢复原来的版本。
  // 钩子：和允许时一样的照旧允许；新的或变了的，用户这次勾了才允许
  ipcMain.handle(IPC_CHANNELS.pluginCommitUpdate, async (_event, rawToken: unknown, rawAllowHooks: unknown) => {
    const token = parse(z.string().min(1), rawToken)
    const allowHooks = parse(z.boolean(), rawAllowHooks)
    const item = staged.get(token)
    if (!item?.updateOf || !item.clone) throw new Error('更新已经取消或过期了，请重新检查更新')
    staged.delete(token)
    const plugin = settings.get().plugins.find((entry) => entry.id === item.updateOf)
    const target = plugin ? cloneDir(plugin) : null
    if (!plugin || !target || !ownsDir(target)) {
      await rm(item.clone, { recursive: true, force: true })
      throw new Error('这个插件已经删了')
    }
    try {
      await swapDir(target, item.clone, join(backupRoot, plugin.id), async () => {
        const info = await inspectPlugin(await coreConnection(), plugin.dir)
        if (info.name.toLowerCase() !== plugin.name.toLowerCase()) throw new Error(`新版本的插件名变成了「${info.name}」`)
        const fingerprint = info.hooksFingerprint
        const hooksApproved = fingerprint !== null && (fingerprint === plugin.hooksApproved || (allowHooks && fingerprint === item.fingerprint)) ? fingerprint : null
        await settings.update((current) => ({ ...current, plugins: current.plugins.map((entry) => (entry.id === plugin.id ? { ...entry, hooksApproved } : entry)) }))
      })
    } catch (error) {
      await rm(item.clone, { recursive: true, force: true })
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
      // Windows 上目录里的文件被别的进程开着（比如任务里正在跑它的 MCP 服务器）时挪不动
      const reason = ['EPERM', 'EBUSY', 'EACCES'].includes(code) ? '插件的文件正被占用，可能有任务在用它的 MCP 服务器，关掉这些任务再更新' : error instanceof Error ? error.message : String(error)
      throw new Error(`更新失败，还是原来的版本：${reason}`)
    }
    return views()
  })

  ipcMain.handle(IPC_CHANNELS.pluginDelete, async (_event, rawId: unknown) => {
    const id = parse(z.string().min(1), rawId)
    const plugin = settings.get().plugins.find((item) => item.id === id)
    if (!plugin) return views()
    await settings.update((current) => ({ ...current, plugins: current.plugins.filter((item) => item.id !== id) }))
    if (plugin.source === 'git' && ownsDir(cloneDir(plugin))) await rm(cloneDir(plugin), { recursive: true, force: true })
    return views()
  })
}
