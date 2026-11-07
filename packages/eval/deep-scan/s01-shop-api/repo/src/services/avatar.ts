import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '../config.ts'

const MAX_AVATAR_BYTES = 2 * 1024 * 1024

export async function saveAvatar(userId: string, url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`下载头像失败：${response.status}`)
  if (!response.headers.get('content-type')?.startsWith('image/')) throw new Error('链接不是图片')
  const body = Buffer.from(await response.arrayBuffer())
  if (body.length > MAX_AVATAR_BYTES) throw new Error('图片太大')
  const target = join(config.avatarDir, `${userId}.jpg`)
  await writeFile(target, body)
  return target
}
