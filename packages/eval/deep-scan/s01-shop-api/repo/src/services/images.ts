import { exec } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { config } from '../config.ts'

const run = promisify(exec)

// 按需生成商品缩略图，返回缩略图路径
export async function thumbnail(productId: string, size: string): Promise<string> {
  const source = join(config.imageDir, `${productId}.jpg`)
  const target = join(config.imageDir, 'thumbs', `${productId}.jpg`)
  await run(`convert ${source} -resize ${size} ${target}`, { timeout: 30_000 })
  return target
}
