import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import type { PromptImage } from '../protocol.js'
import { isProtectedFile } from './protected.js'
import { ToolError, type ToolContext, type ToolOutput } from './types.js'
import { resolveToolPath } from './workspace.js'

// 看一张本地图片（第 510 步，参照 Codex 的 view_image）：截图、设计稿、报错截图。只给能看图的模型
const MIME: Record<string, PromptImage['mimeType']> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

export async function viewImageTool(context: ToolContext, input: { path: string }): Promise<ToolOutput> {
  const target = await resolveToolPath(context, input.path, 'read')
  if (isProtectedFile(target.display)) throw new ToolError(`${target.display} is protected because it may contain secrets.`)
  const mimeType = MIME[extname(target.absolute).toLowerCase()]
  if (!mimeType) throw new ToolError(`${target.display} is not a supported image (png, jpg, gif, webp).`)
  const info = await stat(target.absolute).catch(() => null)
  if (!info?.isFile()) throw new ToolError(`File not found: ${target.display}`)
  if (info.size > MAX_IMAGE_BYTES) throw new ToolError(`${target.display} is too large (${info.size} bytes).`)
  const data = (await readFile(target.absolute)).toString('base64')
  return { text: `${target.display} is attached in the next message.`, title: `查看图片 ${target.display}`, image: { data, mimeType } }
}
