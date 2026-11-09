import { createHash } from 'node:crypto'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PermissionOption } from '@agentclientprotocol/sdk'
import { tool, type ToolResultPart } from 'ai'
import { z } from 'zod'
import { PERMISSION_OPTIONS, type PromptImage } from '../protocol.js'
import { isUnderReadOnly } from '../tools/protected.js'
import { ToolError } from '../tools/types.js'
import { resolveInWorkspace, resolveToolPath } from '../tools/workspace.js'
import { isLocalHost } from '../urls.js'
import { CORE_VERSION } from '../version.js'
import { errorResult, type StepToolCall, textResult, toolContext, type TurnIO } from './loop.js'
import type { Session } from './session.js'

// 设计稿里的真实图片：模型给本地路径或 http(s) 网址，core 自己读取或下载、校验，再交给设计页填进节点。
// 图片数据不经过模型；下载的和项目外的图片在项目的 assets/ 里存一份，之后把设计转成代码时能直接引用
export const PLACE_IMAGE_TOOL = 'design_place_image'
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000
export const MAX_IMAGE_REDIRECTS = 3
const ASSETS_DIR = 'assets'
const MAX_LAYER_NAME_CHARS = 200

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'gif'

const EXTENSIONS: Record<ImageFormat, string> = { png: 'png', jpeg: 'jpg', webp: 'webp', gif: 'gif' }

const placeImageInput = z.object({
  id: z.string().min(1).describe('ID of the node to fill, usually a rectangle or frame placeholder sized and placed for the image'),
  source: z
    .string()
    .min(1)
    .describe('An http(s) URL of an image file (PNG, JPEG, WebP or GIF), or a local file path; relative paths are inside the project'),
  scale_mode: z
    .enum(['FILL', 'FIT', 'CROP', 'TILE'])
    .optional()
    .describe('How the image fits the node. Default FILL: cover the node and crop the overflow.'),
})

export const PLACE_IMAGE_DEFINITION = tool({
  description:
    'Put a real image (photo, illustration, logo) into a design node as its fill. Diffra downloads the URL or reads the file itself, so the image data never passes through you. ' +
    `Use it instead of drawing placeholders that pretend to be photos. Downloaded images and files from outside the project are saved under ${ASSETS_DIR}/ in the project, ` +
    'and the layer is renamed to include that path and the source. Images up to 10 MB.',
  inputSchema: placeImageInput,
})

interface ImageInfo {
  format: ImageFormat
  width: number | null
  height: number | null
}

// 按文件头认格式，顺便读出像素尺寸；认不出的不是这四种图片
export function sniffImage(bytes: Uint8Array): ImageInfo | null {
  const at = (offset: number) => bytes[offset] ?? 0
  const u16be = (offset: number) => (at(offset) << 8) | at(offset + 1)
  const u16le = (offset: number) => at(offset) | (at(offset + 1) << 8)
  const u24le = (offset: number) => at(offset) | (at(offset + 1) << 8) | (at(offset + 2) << 16)
  const u32be = (offset: number) => ((at(offset) << 24) >>> 0) + (at(offset + 1) << 16) + (at(offset + 2) << 8) + at(offset + 3)
  const ascii = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length))
  if (bytes.length >= 24 && at(0) === 0x89 && ascii(1, 3) === 'PNG') return { format: 'png', width: u32be(16), height: u32be(20) }
  if (bytes.length >= 10 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return { format: 'gif', width: u16le(6), height: u16le(8) }
  if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4)
    if (chunk === 'VP8 ') return { format: 'webp', width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff }
    if (chunk === 'VP8L') return { format: 'webp', width: 1 + (((at(22) & 0x3f) << 8) | at(21)), height: 1 + (((at(24) & 0x0f) << 10) | (at(23) << 2) | ((at(22) & 0xc0) >> 6)) }
    if (chunk === 'VP8X') return { format: 'webp', width: 1 + u24le(24), height: 1 + u24le(27) }
    return { format: 'webp', width: null, height: null }
  }
  if (bytes.length >= 4 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) {
    // 跳过各段找 SOF（帧头），里面是高和宽
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (at(offset) !== 0xff) {
        offset++
        continue
      }
      const marker = at(offset + 1)
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
        offset += marker === 0xff ? 1 : 2
        continue
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: 'jpeg', width: u16be(offset + 7), height: u16be(offset + 5) }
      }
      offset += 2 + u16be(offset + 2)
    }
    return { format: 'jpeg', width: null, height: null }
  }
  return null
}

function httpUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ToolError(`Not a valid URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ToolError(`Only http(s) image URLs can be downloaded, not ${url.protocol}`)
  return url
}

const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'application/octet-stream', 'binary/octet-stream', ''])

// 下载图片：最多跟 3 次跳转，15 秒超时（含读内容），超过 10MB 就停；内容类型明显不是图片的直接拒
export async function downloadImage(raw: string, signal: AbortSignal, timeoutMs = IMAGE_DOWNLOAD_TIMEOUT_MS): Promise<{ bytes: Buffer; finalUrl: string }> {
  let url = httpUrl(raw)
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = AbortSignal.any([signal, timeout])
  const failure = (error: unknown) => {
    if (signal.aborted) return new ToolError('Cancelled by the user.')
    if (timeout.aborted) return new ToolError(`Downloading the image took longer than ${timeoutMs / 1000} seconds: ${raw}`)
    if (error instanceof ToolError) return error
    return new ToolError(`Could not download the image: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    for (let redirects = 0; ; redirects++) {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: combined,
        headers: { accept: 'image/png,image/jpeg,image/webp,image/gif;q=0.9,*/*;q=0.1', 'user-agent': `Diffra/${CORE_VERSION} (design image download)` },
      })
      const location = response.headers.get('location')
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel()
        if (redirects >= MAX_IMAGE_REDIRECTS) throw new ToolError(`The image URL redirected more than ${MAX_IMAGE_REDIRECTS} times: ${raw}`)
        url = httpUrl(new URL(location, url).toString())
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new ToolError(`The image URL returned HTTP ${response.status}: ${url.toString()}`)
      }
      const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
      if (!ACCEPTED_TYPES.has(type)) {
        await response.body?.cancel()
        throw new ToolError(
          type.startsWith('text/html')
            ? `This URL is a web page, not an image file: ${url.toString()}. Use the image's own URL (browser_images lists them).`
            : `The URL is ${type}, not a PNG, JPEG, WebP or GIF image: ${url.toString()}`,
        )
      }
      const declared = Number(response.headers.get('content-length') ?? '')
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
        await response.body?.cancel()
        throw new ToolError(`The image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB: ${url.toString()}`)
      }
      const chunks: Uint8Array[] = []
      let total = 0
      const reader = response.body?.getReader()
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > MAX_IMAGE_BYTES) {
            await reader.cancel()
            throw new ToolError(`The image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB: ${url.toString()}`)
          }
          chunks.push(value)
        }
      }
      return { bytes: Buffer.concat(chunks), finalUrl: url.toString() }
    }
  } catch (error) {
    throw failure(error)
  }
}

// 文件名里能用的部分；中文名、空名用 image
function slugOf(name: string): string {
  const stem = basename(name, extname(name))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return stem || 'image'
}

// 存到项目的 assets/，文件名带内容哈希：同一张图只存一份。assets/ 是禁写目录或指到项目外时不存，返回 null
async function saveAsset(session: Session, bytes: Buffer, format: ImageFormat, nameHint: string): Promise<string | null> {
  const relativePath = `${ASSETS_DIR}/${slugOf(nameHint)}-${createHash('sha256').update(bytes).digest('hex').slice(0, 8)}.${EXTENSIONS[format]}`
  let target: { absolute: string }
  try {
    target = await resolveInWorkspace(session.cwd, relativePath)
  } catch (error) {
    if (error instanceof ToolError) return null
    throw error
  }
  if (isUnderReadOnly(session.cwd, target.absolute, session.config.readOnlyPaths)) return null
  const exists = await access(target.absolute).then(
    () => true,
    () => false,
  )
  if (!exists) {
    await mkdir(dirname(target.absolute), { recursive: true })
    await writeFile(target.absolute, bytes)
  }
  return relativePath
}

// 从网上下载图片按权限模式先问：完全放行、本地地址、本会话允许过的站点不问
async function allowDownload(session: Session, call: StepToolCall, url: URL, io: TurnIO): Promise<boolean> {
  const host = url.hostname.toLowerCase()
  const key = `image:${host}`
  if (isLocalHost(host) || session.permissionMode === 'full' || session.alwaysAllowed.has(key)) return true
  const options: PermissionOption[] = [
    { optionId: PERMISSION_OPTIONS.allowOnce, name: '允许一次', kind: 'allow_once' },
    { optionId: PERMISSION_OPTIONS.allowAlways, name: `本会话允许从 ${host} 下载图片`, kind: 'allow_always' },
    { optionId: PERMISSION_OPTIONS.reject, name: '拒绝', kind: 'reject_once' },
  ]
  const choice = await io.requestPermission({ toolCallId: call.toolCallId, title: `下载图片：${host}`, kind: 'fetch', status: 'pending', rawInput: call.input }, options)
  if (choice === PERMISSION_OPTIONS.allowAlways) session.alwaysAllowed.add(key)
  return choice === PERMISSION_OPTIONS.allowOnce || choice === PERMISSION_OPTIONS.allowAlways
}

interface LoadedImage extends ImageInfo {
  bytes: Buffer
  // 项目里的路径：项目里的文件就是它自己，下载的和项目外的是存下来的副本；没存时为 null
  asset: string | null
  // 图片从哪来：最终的网址，或项目外文件的路径；项目里的文件为 null
  origin: string | null
}

async function loadImage(session: Session, call: StepToolCall, source: string, signal: AbortSignal, io: TurnIO): Promise<LoadedImage> {
  if (/^https?:\/\//i.test(source)) {
    const url = httpUrl(source)
    if (!(await allowDownload(session, call, url, io))) throw new ToolError(`The user did not allow downloading images from ${url.hostname}. Do not retry it; ask the user for the image.`)
    const { bytes, finalUrl } = await downloadImage(source, signal)
    const info = sniffImage(bytes)
    if (!info) throw new ToolError(`The downloaded file is not a PNG, JPEG, WebP or GIF image: ${finalUrl}`)
    return { ...info, bytes, asset: await saveAsset(session, bytes, info.format, new URL(finalUrl).pathname), origin: finalUrl }
  }
  let path = source
  if (/^file:\/\//i.test(source)) path = fileURLToPath(source)
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source) || /^data:/i.test(source)) throw new ToolError('Use an http(s) image URL or a local file path.')
  const target = await resolveToolPath(toolContext(session, call, signal, io), path, 'read')
  const size = (await stat(target.absolute).catch(() => null))?.size
  if (size === undefined) throw new ToolError(`File not found: ${source}`)
  if (size > MAX_IMAGE_BYTES) throw new ToolError(`The image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB: ${source}`)
  const bytes = await readFile(target.absolute)
  const info = sniffImage(bytes)
  if (!info) throw new ToolError(`Not a PNG, JPEG, WebP or GIF image: ${source}`)
  const inProject = !isAbsolute(target.display)
  return {
    ...info,
    bytes,
    asset: inProject ? target.display : await saveAsset(session, bytes, info.format, target.absolute),
    origin: inProject ? null : target.display,
  }
}

// 设计页的工具出错时返回 {"error": ...}
function designError(text: string): string | null {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string') return value.error
  } catch {
    return null
  }
  return null
}

async function layerName(io: TurnIO, id: string, signal: AbortSignal): Promise<string> {
  try {
    const node: unknown = JSON.parse((await io.design!('get_node', { id, depth: 0 }, signal)).text)
    if (typeof node === 'object' && node !== null && 'name' in node && typeof node.name === 'string') return node.name
  } catch {
    // 读不到原来的名字就只写路径和来源
  }
  return ''
}

function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export async function runPlaceImage(
  session: Session,
  call: StepToolCall,
  signal: AbortSignal,
  io: TurnIO,
): Promise<{ result: ToolResultPart; edited: boolean; images?: PromptImage[] }> {
  const parsed = placeImageInput.safeParse(call.input)
  const source = parsed.success ? parsed.data.source : ''
  await io.update({
    sessionUpdate: 'tool_call',
    toolCallId: call.toolCallId,
    title: `设计 放入图片${source ? ` ${shorten(source, 80)}` : ''}`,
    kind: /^https?:\/\//i.test(source) ? 'fetch' : 'read',
    status: 'in_progress',
    rawInput: call.input,
  })
  const fail = async (message: string) => {
    await io.update({ sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: message } }] })
    return { result: errorResult(call, message), edited: false }
  }
  if (!parsed.success) return fail(`Invalid arguments: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
  if (!io.design) return fail('The design panel is not available in this client.')
  const { id, scale_mode: scaleMode = 'FILL' } = parsed.data
  try {
    const image = await loadImage(session, call, source, signal, io)
    const filled = await io.design('set_image_fill', { id, image_data: image.bytes.toString('base64'), scale_mode: scaleMode }, signal)
    const error = designError(filled.text)
    if (error) return fail(`Could not put the image into node ${id}: ${error}`)
    // 图层名接上图片在项目里的路径和来源；再次换图时去掉上次接的部分
    const original = (await layerName(io, id, signal)).split(' · ')[0]!.trim()
    const name = shorten([original, image.asset, image.origin].filter(Boolean).join(' · '), MAX_LAYER_NAME_CHARS)
    if (name) await io.design('rename_node', { id, name }, signal)
    const size = image.width && image.height ? `${image.width}x${image.height} ` : ''
    const copy = image.asset ? (image.origin ? ` Saved a copy at ${image.asset}.` : '') : ` Did not save a copy in the project: ${ASSETS_DIR}/ is read-only or points outside the project.`
    const text = `Placed the ${size}${image.format.toUpperCase()} image into node ${id} (scale mode ${scaleMode}).${copy} The layer is named "${name}".`
    await io.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: call.toolCallId,
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: `已放入${size ? ` ${size.trim()}` : ''} ${image.format.toUpperCase()} 图片 → 节点 ${id}${image.asset ? `\n项目里的文件：${image.asset}` : ''}${image.origin ? `\n来源：${image.origin}` : ''}` } }],
    })
    return { result: textResult(call, text), edited: false }
  } catch (error) {
    if (signal.aborted) return fail('Cancelled by the user.')
    if (error instanceof ToolError) return fail(error.message)
    console.error('[design] 放入图片失败', error)
    return fail(`Placing the image failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
