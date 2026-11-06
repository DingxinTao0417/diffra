import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { z } from 'zod'

export type JsonFileContent<T> = { state: 'missing' } | { state: 'loaded'; value: T } | { state: 'invalid'; error: unknown }

export async function readJsonFile<T>(path: string, schema: z.ZodType<T>): Promise<JsonFileContent<T>> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { state: 'missing' }
    throw error
  }
  try {
    return { state: 'loaded', value: schema.parse(JSON.parse(text)) }
  } catch (error) {
    return { state: 'invalid', error }
  }
}

// 先写临时文件再改名，写到一半断电也不会留下半截文件
export async function writeJsonFileAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, path)
}

// 同一个文件的写入按顺序执行，避免两次保存交错
export class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task)
    this.tail = result.catch(() => {})
    return result
  }
}
