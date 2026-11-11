import type { PromptImage } from '@diffra/core/types'

// 发给模型前先缩小、转成 WebP：长边超过 1600 的模型也会自己缩小，大图只是白占上下文和会话记录
const MAX_EDGE = 1600
const QUALITY = 0.9
// 转完还超过这么大（base64 字数）就不要了
const MAX_DATA_CHARS = 4_000_000
export const MAX_PROMPT_IMAGES = 6

// 设备连接：发给远程设备看的小图，长边 1024
const REMOTE_EDGE = 1024
const REMOTE_QUALITY = 0.7

export async function prepareImage(file: Blob): Promise<PromptImage> {
  if (!file.type.startsWith('image/')) throw new Error('只能添加图片')
  return encode(file, MAX_EDGE, QUALITY)
}

// 已经存在会话里的提问图片压成发给远程设备的小图
export async function shrinkImage(image: PromptImage): Promise<PromptImage> {
  // 不用 fetch(data:)：主窗口的 CSP 没放开 connect-src
  const bytes = Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0))
  return encode(new Blob([bytes], { type: image.mimeType }), REMOTE_EDGE, REMOTE_QUALITY)
}

async function encode(file: Blob, maxEdge: number, quality: number): Promise<PromptImage> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('读不了这张图片')
  })
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('读不了这张图片')
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const data = await toBase64(await canvas.convertToBlob({ type: 'image/webp', quality }))
  if (data.length > MAX_DATA_CHARS) throw new Error('图片太大')
  return { mimeType: 'image/webp', data }
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(reader.error ?? new Error('读不了这张图片'))
    reader.readAsDataURL(blob)
  })
}

export const imageUrl = (image: PromptImage) => `data:${image.mimeType};base64,${image.data}`
