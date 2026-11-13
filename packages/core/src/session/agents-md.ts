import { readFile, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

// 项目说明文件（第 511 步，参照 Codex 的 AGENTS.md 规则）：从项目根（往上找到有 .git 的那一级，找不到就是任务目录）到任务目录，
// 每一级按 AGENTS.override.md → AGENTS.md → CLAUDE.md 只取第一个不是空的；按从根到叶的顺序拼起来，合计不超过 32 KiB。
// 子目录里更深的说明文件不自动读，提示词里让模型改到那里时自己去看
const FILE_NAMES = ['AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md']
export const AGENTS_MD_MAX_BYTES = 32 * 1024

export interface ProjectDoc {
  // 相对任务目录的路径，用 / 分隔
  path: string
  text: string
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

// 从 cwd 往上找带 .git 的目录；找不到就只看 cwd
async function projectRoot(cwd: string): Promise<string> {
  let dir = resolve(cwd)
  for (;;) {
    if (await exists(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return resolve(cwd)
    dir = parent
  }
}

export async function loadProjectDocs(cwd: string): Promise<{ docs: ProjectDoc[]; truncated: boolean }> {
  const root = await projectRoot(cwd)
  const levels: string[] = []
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    levels.unshift(dir)
    if (dir === root || dirname(dir) === dir) break
  }
  const found = await Promise.all(
    levels.map(async (dir) => {
      for (const name of FILE_NAMES) {
        const text = await readFile(join(dir, name), 'utf8').catch(() => null)
        if (text?.trim()) return { path: relative(cwd, join(dir, name)).replace(/\\/g, '/'), text: text.trim() }
      }
      return null
    }),
  )
  const docs: ProjectDoc[] = []
  let budget = AGENTS_MD_MAX_BYTES
  let truncated = false
  for (const doc of found) {
    if (!doc) continue
    if (budget <= 0) {
      truncated = true
      break
    }
    const bytes = Buffer.byteLength(doc.text)
    if (bytes <= budget) {
      docs.push(doc)
      budget -= bytes
      continue
    }
    // 按字节截：中文一个字三个字节，宁可少留
    const keep = Math.floor(doc.text.length * (budget / bytes))
    docs.push({ path: doc.path, text: doc.text.slice(0, keep) })
    truncated = true
    budget = 0
  }
  return { docs, truncated }
}

export function renderProjectDocs(cwd: string, loaded: { docs: ProjectDoc[]; truncated: boolean }): string | null {
  if (loaded.docs.length === 0) return null
  const body = loaded.docs.map((doc) => `--- ${doc.path} ---\n${doc.text}`).join('\n\n')
  const note = loaded.truncated ? `\n\n(The instruction files exceed ${AGENTS_MD_MAX_BYTES / 1024} KiB in total; the rest was left out.)` : ''
  return `# AGENTS.md instructions for ${cwd}\n\n<INSTRUCTIONS>\n${body}${note}\n</INSTRUCTIONS>`
}
