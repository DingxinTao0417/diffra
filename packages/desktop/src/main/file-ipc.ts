import { open, stat } from 'node:fs/promises'
import { isAbsolute, join, normalize, relative } from 'node:path'
import { ipcMain, shell } from 'electron'
import { z } from 'zod'
import { IPC_CHANNELS, type ProjectFile } from '../shared/ipc'
import { parse } from './ipc-input'
import { pathInside } from './terminal-ipc'

// 回答里提到的文件（第 535、536 步）：查哪些在项目里、读出来预览或复制、用默认应用打开、在资源管理器里显示。只认项目目录里的文件

const MAX_PATHS = 100
// 预览和复制最多读这么多，超出的截掉
const MAX_READ_BYTES = 1024 * 1024
// 开头这么多字节里有 0 就当二进制
const BINARY_PROBE_BYTES = 8 * 1024

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

export function registerFileIpc(): void {
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
      return { text: binary ? '' : data.toString('utf8'), binary, truncated: size > bytesRead }
    } finally {
      await handle.close()
    }
  })

  ipcMain.handle(IPC_CHANNELS.fileOpen, async (_event, rawProject: unknown, rawPath: unknown) => {
    const message = await shell.openPath(await requireFile(parse(projectSchema, rawProject), parse(pathSchema, rawPath)))
    if (message) throw new Error(`打不开文件：${message}`)
  })

  ipcMain.handle(IPC_CHANNELS.fileReveal, async (_event, rawProject: unknown, rawPath: unknown) => {
    shell.showItemInFolder(await requireFile(parse(projectSchema, rawProject), parse(pathSchema, rawPath)))
  })
}
