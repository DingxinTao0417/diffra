import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import { isProtectedFile } from '@diffra/core'
import { ipcMain } from 'electron'
import { z } from 'zod'
import { MAX_ATTACHMENT_PATH_LENGTH, MAX_PROMPT_FILE_REFERENCES, type FileReference } from '../shared/attachments'
import { IPC_CHANNELS } from '../shared/ipc'
import { parse } from './ipc-input'

const pathsSchema = z.array(z.string().min(1).max(MAX_ATTACHMENT_PATH_LENGTH).refine(isAbsolute, '必须是本地绝对路径')).max(MAX_PROMPT_FILE_REFERENCES)

// 这里只读路径元数据；绝不读取内容、不递归目录、不因拖放授予文件工具访问权。
export async function describeAttachments(raw: unknown): Promise<FileReference[]> {
  const paths = parse(pathsSchema, raw)
  const result: FileReference[] = []
  for (const path of paths) {
    const canonical = await realpath(path)
    if (isProtectedFile(path) || isProtectedFile(canonical)) throw new Error(`${basename(path)} 可能包含密钥，不能添加，请不要拖入凭据文件`)
    const info = await stat(canonical)
    if (!info.isFile() && !info.isDirectory()) throw new Error('只能添加普通文件或文件夹')
    if (!result.some((item) => item.path === canonical)) result.push({ path: canonical, name: basename(canonical), kind: info.isDirectory() ? 'directory' : 'file' })
  }
  return result
}

export function registerAttachmentIpc(): void {
  ipcMain.handle(IPC_CHANNELS.attachmentDescribe, (_event, raw: unknown) => describeAttachments(raw))
}
