import { open, readFile, stat, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, join, normalize, relative } from 'node:path'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { z } from 'zod'
import { IPC_CHANNELS, type ProjectFile } from '../shared/ipc'
import { parse } from './ipc-input'
import { pathInside } from './terminal-ipc'

// 回答里提到的文件（第 535、536、546 步）：查哪些在项目里、读出来编辑或复制、保存、用默认应用打开、在资源管理器里显示。只认项目目录里的文件

const MAX_PATHS = 100
// 预览和复制最多读这么多，超出的截掉
const MAX_READ_BYTES = 1024 * 1024
// 开头这么多字节里有 0 就当二进制
const BINARY_PROBE_BYTES = 8 * 1024

// 回答里引用的项目图片（第 640 步）。SVG 当图片显示时脚本不会跑
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
}

const projectSchema = z.string().min(1)
const pathSchema = z.string().min(1).max(4096)

// 回答里写的路径：相对项目，或者项目里的绝对路径
function inProject(project: string, path: string): string | null {
  const full = normalize(isAbsolute(path) ? path : join(project, path))
  return pathInside(project, full) ? full : null
}

async function resolveFile(project: string, path: string): Promise<ProjectFile | null> {
  const full = inProject(project, path)
  if (!full) return null
  const info = await stat(full).catch(() => null)
  return info?.isFile() ? { path: full, relative: relative(project, full).replace(/\\/g, '/') } : null
}

async function requireFile(project: string, path: string): Promise<string> {
  const file = await resolveFile(project, path)
  if (!file) throw new Error(`项目里没有这个文件：${path}`)
  return file.path
}

// 文件的版本：修改时间加大小。保存前比一下，读出来之后被智能体或别的程序改过就不直接覆盖
const versionOf = (info: { mtimeMs: number; size: number }) => `${info.mtimeMs}:${info.size}`

export function registerFileIpc(): void {
  // 提问里的「选文件」（第 673 步）：系统选择框从项目目录开始，只收项目里的文件，回相对路径；项目外的只数个数
  ipcMain.handle(IPC_CHANNELS.filePick, async (event, rawProject: unknown, rawMultiple: unknown) => {
    const project = parse(projectSchema, rawProject)
    const multiple = parse(z.boolean(), rawMultiple)
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = { defaultPath: project, properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'] }
    const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    const files = picked.canceled ? [] : await Promise.all(picked.filePaths.map((path) => resolveFile(project, path)))
    return { files: files.flatMap((file) => (file ? [file.relative] : [])), outside: files.filter((file) => !file).length }
  })

  ipcMain.handle(IPC_CHANNELS.fileResolve, async (_event, rawProject: unknown, rawPaths: unknown) => {
    const project = parse(projectSchema, rawProject)
    const paths = parse(z.array(pathSchema).max(MAX_PATHS), rawPaths)
    const files = await Promise.all(paths.map((path) => resolveFile(project, path)))
    return Object.fromEntries(paths.map((path, index) => [path, files[index]]))
  })

  ipcMain.handle(IPC_CHANNELS.fileRead, async (_event, rawProject: unknown, rawPath: unknown) => {
    const path = await requireFile(parse(projectSchema, rawProject), parse(pathSchema, rawPath))
    const handle = await open(path, 'r')
    try {
      const { size } = await handle.stat()
      const buffer = Buffer.alloc(Math.min(size, MAX_READ_BYTES))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const data = buffer.subarray(0, bytesRead)
      const binary = data.subarray(0, BINARY_PROBE_BYTES).includes(0)
      return { text: binary ? '' : data.toString('utf8'), binary, truncated: size > bytesRead, version: versionOf(await handle.stat()) }
    } finally {
      await handle.close()
    }
  })

  ipcMain.handle(IPC_CHANNELS.fileReadImage, async (_event, rawProject: unknown, rawPath: unknown) => {
    const path = await requireFile(parse(projectSchema, rawProject), parse(pathSchema, rawPath))
    const mimeType = IMAGE_TYPES[extname(path).slice(1).toLowerCase()]
    if (!mimeType) throw new Error(`不是图片：${rawPath as string}`)
    const { size } = await stat(path)
    if (size > MAX_IMAGE_BYTES) throw new Error(`图片太大（超过 ${MAX_IMAGE_BYTES / 1024 / 1024} MB）`)
    return { mimeType, data: (await readFile(path)).toString('base64') }
  })

  // 文件面板里编辑后保存。version 是读出来时的版本，对不上（外面改过了）就不写，交给界面问用户；null 是用户选了覆盖
  ipcMain.handle(IPC_CHANNELS.fileWrite, async (_event, rawProject: unknown, rawPath: unknown, rawText: unknown, rawVersion: unknown) => {
    const path = await requireFile(parse(projectSchema, rawProject), parse(pathSchema, rawPath))
    const text = parse(z.string().max(MAX_READ_BYTES * 4), rawText)
    const version = parse(z.string().nullable(), rawVersion)
    if (version !== null && versionOf(await stat(path)) !== version) return { saved: false as const }
    await writeFile(path, text, 'utf8')
    return { saved: true as const, version: versionOf(await stat(path)) }
  })

  ipcMain.handle(IPC_CHANNELS.fileOpen, async (_event, rawProject: unknown, rawPath: unknown) => {
    const message = await shell.openPath(await requireFile(parse(projectSchema, rawProject), parse(pathSchema, rawPath)))
    if (message) throw new Error(`打不开文件：${message}`)
  })

  ipcMain.handle(IPC_CHANNELS.fileReveal, async (_event, rawProject: unknown, rawPath: unknown) => {
    shell.showItemInFolder(await requireFile(parse(projectSchema, rawProject), parse(pathSchema, rawPath)))
  })
}
