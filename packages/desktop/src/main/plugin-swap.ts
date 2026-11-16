import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// 插件更新（v2 · M4）里换目录和比文件的部分。不引 Electron，scripts/plugin-swap.test.ts 直接测

// 换目录：旧的先挪到备份，新的挪过去，再验证（读插件、改设置）；任何一步失败都把旧的挪回来再抛错。
// 挪回去也失败时备份留着，下次启动 recoverBackups 处理
export async function swapDir(target: string, replacement: string, backup: string, verify: () => Promise<void>): Promise<void> {
  await rm(backup, { recursive: true, force: true })
  await mkdir(dirname(backup), { recursive: true })
  await rename(target, backup)
  try {
    await rename(replacement, target)
    await verify()
  } catch (error) {
    try {
      await rm(target, { recursive: true, force: true })
      await rename(backup, target)
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], `更新失败，恢复原来的版本也失败了，备份在 ${backup}，下次启动时会再试`)
    }
    throw error
  }
  await rm(backup, { recursive: true, force: true }).catch((error: unknown) => console.warn('[plugins] 删除更新前的备份失败', error))
}

// 启动时：上次换到一半（比如应用崩了）留下的备份。原位置没有了就挪回去，有就删掉备份。返回挪回去的名字
export async function recoverBackups(root: string, backupRoot: string): Promise<string[]> {
  const names = await readdir(backupRoot).catch(() => [])
  const restored: string[] = []
  for (const name of names) {
    const backup = join(backupRoot, name)
    const target = join(root, name)
    if (await exists(target)) await rm(backup, { recursive: true, force: true })
    else {
      await rename(backup, target)
      restored.push(name)
    }
  }
  return restored
}

const exists = (path: string) => stat(path).then(() => true, () => false)

// 两个版本之间哪些文件加了、删了、改了（按内容哈希，不看 .git）；最多列 limit 个，多的算进 truncated
export interface DirDiff {
  added: string[]
  removed: string[]
  modified: string[]
  truncated: boolean
}

const MAX_FILES = 5000

async function hashes(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  const walk = async (dir: string, prefix: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || result.size >= MAX_FILES) continue
      const path = join(dir, entry.name)
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(path, name)
      else if (entry.isFile()) result.set(name, createHash('sha256').update(await readFile(path)).digest('hex'))
    }
  }
  await walk(root, '')
  return result
}

export async function diffDirs(before: string, after: string, limit = 30): Promise<DirDiff> {
  const [old, next] = await Promise.all([hashes(before), hashes(after)])
  const added = [...next.keys()].filter((name) => !old.has(name)).sort()
  const removed = [...old.keys()].filter((name) => !next.has(name)).sort()
  const modified = [...next.keys()].filter((name) => old.has(name) && old.get(name) !== next.get(name)).sort()
  const truncated = added.length > limit || removed.length > limit || modified.length > limit || old.size >= MAX_FILES || next.size >= MAX_FILES
  return { added: added.slice(0, limit), removed: removed.slice(0, limit), modified: modified.slice(0, limit), truncated }
}
