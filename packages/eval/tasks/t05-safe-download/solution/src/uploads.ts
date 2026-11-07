import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

// 列出上传目录第一层的文件名
export async function listUploads(uploadDir: string): Promise<string[]> {
  const entries = await readdir(uploadDir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort()
}

// filename 来自用户请求：规范化后必须仍在上传目录里，否则当作不存在
export async function downloadFile(uploadDir: string, filename: string): Promise<Buffer | null> {
  const root = resolve(uploadDir)
  const target = resolve(root, filename)
  const inside = relative(root, target)
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null
  try {
    return await readFile(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
