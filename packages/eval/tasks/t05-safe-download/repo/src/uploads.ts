import { readdir } from 'node:fs/promises'

// 列出上传目录第一层的文件名
export async function listUploads(uploadDir: string): Promise<string[]> {
  const entries = await readdir(uploadDir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort()
}
