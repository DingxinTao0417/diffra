import { tool, type ToolResultPart } from 'ai'
import { z } from 'zod'
import { STOCK_PHOTOS_META_KEY, type StockPhotoParams, type StockPhotoResult } from '../protocol.js'
import { PLACE_IMAGE_TOOL } from './design-image.js'
import { errorResult, type StepToolCall, textResult, type TurnIO } from './loop.js'
import type { Session } from './session.js'
import { toolDefinitionChars } from './tools.js'

// 设计任务里找图（v2 · M11）：用户在设置里填了 Pexels 或 Unsplash 的 API Key 才有这个工具。
// 搜索由客户端做（Key 只在客户端的 SecretStore 里，core 和模型都拿不到），结果的缩略图显示在对话的卡片里，
// 给模型的是图片地址、尺寸、说明和摄影师，放进画布用 design_place_image
export const FIND_PHOTOS_TOOL = 'design_find_photos'
export const STOCK_PHOTOS_TIMEOUT_MS = 30_000

const findPhotosInput = z.object({
  query: z.string().trim().min(1).max(100).describe('What the photo shows, in English works best (e.g. "coffee shop interior", "mountain lake sunrise")'),
  orientation: z.enum(['landscape', 'portrait', 'square']).optional(),
  count: z.number().int().min(1).max(12).optional().describe('How many results (default 8)'),
})

export const FIND_PHOTOS_DEFINITION = tool({
  description:
    `Search free stock photos (Pexels / Unsplash, with the user's own API key). Returns image URLs with size, description and photographer; the user sees thumbnails. ` +
    `Place a chosen photo with ${PLACE_IMAGE_TOOL} using its url, put the photographer credit in the layer name, and tell the user which photos you used and who took them.`,
  inputSchema: findPhotosInput,
})

export const FIND_PHOTOS_CHARS = toolDefinitionChars({ [FIND_PHOTOS_TOOL]: FIND_PHOTOS_DEFINITION })

export function findPhotosEnabled(session: Session): boolean {
  return session.design !== null && session.config.stockPhotos === true
}

export async function runFindPhotos(session: Session, call: StepToolCall, signal: AbortSignal, io: TurnIO): Promise<{ result: ToolResultPart; edited: boolean }> {
  const parsed = findPhotosInput.safeParse(call.input)
  const title = `找图 ${parsed.success ? parsed.data.query : ''}`.trim()
  await io.update({ sessionUpdate: 'tool_call', toolCallId: call.toolCallId, title, kind: 'search', status: 'in_progress', rawInput: call.input })
  const fail = async (message: string) => {
    await io.update({ sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: message } }] })
    return { result: errorResult(call, message), edited: false }
  }
  if (!parsed.success) return fail(`Invalid arguments: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
  if (!io.stockPhotos) return fail('Stock photo search is not available in this client.')
  const params: Omit<StockPhotoParams, 'sessionId'> = { query: parsed.data.query, orientation: parsed.data.orientation ?? null, count: parsed.data.count ?? 8 }
  let result: StockPhotoResult
  try {
    result = await io.stockPhotos(params, AbortSignal.any([signal, AbortSignal.timeout(STOCK_PHOTOS_TIMEOUT_MS)]))
  } catch (error) {
    return fail(`Photo search failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (result.photos.length === 0) return fail(`No photos found for "${params.query}"${result.errors.length ? ` (${result.errors.join('; ')})` : ''}. Try other keywords.`)
  const lines = result.photos.map(
    (photo, index) => `${index + 1}. ${photo.provider} ${photo.width}x${photo.height}${photo.alt ? ` "${photo.alt}"` : ''} by ${photo.photographer} — url: ${photo.url}`,
  )
  const text = [`Found ${result.photos.length} photos for "${params.query}" (the user sees the thumbnails):`, ...lines, ...(result.errors.length ? [`Some providers failed: ${result.errors.join('; ')}`] : []), `Credit: photos from ${[...new Set(result.photos.map((photo) => (photo.provider === 'pexels' ? 'Pexels' : 'Unsplash')))].join(' and ')}; name the photographer when you use one.`].join('\n')
  await io.update({
    sessionUpdate: 'tool_call_update',
    toolCallId: call.toolCallId,
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text } }],
    _meta: { diffra: { [STOCK_PHOTOS_META_KEY]: result.photos.map(({ provider, thumb, alt, photographer, photographerUrl, pageUrl, width, height }) => ({ provider, thumb, alt, photographer, photographerUrl, pageUrl, width, height })) } },
  })
  return { result: textResult(call, text), edited: false }
}
