import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { isProtectedFile } from '../tools/protected.js'

// 命令输出里的密钥值换成占位（第 625 步）：完全访问模式不再因为命令可能读到 .env 而先问（第 495 步），
// 评测里智能体把 cat .env 串在一长串查看命令里，密钥原样进了对话、发给了模型服务商。
// 这里不猜格式，直接取项目里受保护文件（.env、.npmrc、私钥这类，见 tools/protected.ts）里的值，命令输出里出现就换掉：
// 不管是 cat、python、调试脚本还是程序自己打出来的都挡得住，也不会误伤别的内容。三种权限模式都一样

// 扫项目找受保护文件的上限：大仓库里不能每条命令都走一遍全部文件
const MAX_SCAN_ENTRIES = 20_000
const MAX_FILES = 50
const MAX_FILE_BYTES = 64 * 1024
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.venv', 'venv', '__pycache__', 'target'])
// 同一个项目这么久内复用上一次的结果
const CACHE_MS = 15_000
// 名字像密钥的变量，值再短也换；别的只换看起来像随机串的长值，免得把 localhost、3000 这种也藏掉，智能体看不懂配置
const SECRET_NAME = /pass|secret|token|key|auth|cred|private|signature|salt|dsn|cookie|session/i
const MIN_SECRET_CHARS = 6
const MIN_RANDOM_CHARS = 16

export interface SecretValue {
  value: string
  // 给模型和用户看的出处，比如 value of DB_PASSWORD in .env
  label: string
}

const cache = new Map<string, { at: number; values: SecretValue[] }>()

async function protectedFiles(root: string): Promise<string[]> {
  const found: string[] = []
  const pending = [root]
  let seen = 0
  while (pending.length > 0 && found.length < MAX_FILES && seen < MAX_SCAN_ENTRIES) {
    const dir = pending.pop()!
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      seen++
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) pending.push(path)
      } else if (entry.isFile() && isProtectedFile(path)) found.push(path)
    }
  }
  return found
}

const looksRandom = (value: string) => value.length >= MIN_RANDOM_CHARS && /[A-Za-z]/.test(value) && /\d/.test(value) && !/\s/.test(value)

// 从一个受保护文件里取出值：KEY=VALUE、KEY: VALUE（.env、.npmrc），.netrc 的 password，私钥正文的每一行
export function secretValuesOf(name: string, text: string): SecretValue[] {
  const values: SecretValue[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (/^[A-Za-z0-9+/=]{20,}$/.test(trimmed)) {
      values.push({ value: trimmed, label: `private key in ${name}` })
      continue
    }
    const netrc = /\bpassword\s+(\S+)/.exec(trimmed)
    if (netrc?.[1] && netrc[1].length >= MIN_SECRET_CHARS) values.push({ value: netrc[1], label: `password in ${name}` })
    const assignment = /^(?:export\s+)?([A-Za-z_./:@-][\w./:@-]*)\s*[=:]\s*(.*)$/.exec(trimmed)
    if (!assignment) continue
    const key = assignment[1] ?? ''
    let value = (assignment[2] ?? '').trim()
    const quoted = /^(["'])(.*)\1$/.exec(value)
    value = quoted ? (quoted[2] ?? '') : value.replace(/\s+#.*$/, '').trim()
    if (value.length < MIN_SECRET_CHARS) continue
    if (SECRET_NAME.test(key) || looksRandom(value)) values.push({ value, label: `value of ${key} in ${name}` })
  }
  return values
}

export async function projectSecretValues(cwd: string, now = Date.now()): Promise<SecretValue[]> {
  const cached = cache.get(cwd)
  if (cached && now - cached.at < CACHE_MS) return cached.values
  const values: SecretValue[] = []
  for (const path of await protectedFiles(cwd)) {
    try {
      if ((await stat(path)).size > MAX_FILE_BYTES) continue
      values.push(...secretValuesOf(relative(cwd, path).replace(/\\/g, '/'), await readFile(path, 'utf8')))
    } catch {
      // 读不了的文件（权限、刚被删）跳过
    }
  }
  // 长的先换：一个值是另一个值的一部分时，先换短的会把长的拆坏
  const unique = [...new Map(values.map((item) => [item.value, item])).values()].sort((a, b) => b.value.length - a.value.length)
  cache.set(cwd, { at: now, values: unique })
  return unique
}

// 命令输出里受保护文件的历史内容（第 631 步）：git show、git log -p、git diff 里那个文件的 diff 段，git grep 的「提交:路径:内容」行。
// 评测里智能体用 git show <提交> 翻出早就删掉的 .env：命令没写文件名、工作区也没有这个文件，前两条路都认不出来
const ANSI = /\x1b\[[0-9;]*m/g
const DIFF_HEADER = /^diff --(git|cc|combined) (.*)$/
const FILE_HEADER = /^(?:---|\+\+\+) (?:[ab]\/)?(.+?)\t?$/
const GREP_LINE = /^(?:[^\s:]+:)?([^\s:][^:]*?)(?::\d+)?[:-](.*)$/

export function historySecretValues(text: string): SecretValue[] {
  const values: SecretValue[] = []
  let file: string | null = null
  let prefix = 1
  let lines: string[] = []
  const flush = () => {
    if (file && lines.length > 0) values.push(...secretValuesOf(file, lines.join('\n')))
    lines = []
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(ANSI, '')
    const diff = DIFF_HEADER.exec(line)
    if (diff) {
      flush()
      file = (diff[2] ?? '').split(' ').map((part) => part.replace(/^"?[ab]\//, '').replace(/"$/, '')).find(isProtectedFile) ?? null
      prefix = diff[1] === 'git' ? 1 : 2
      continue
    }
    const header = FILE_HEADER.exec(line)
    if (header && isProtectedFile(header[1] ?? '')) {
      flush()
      file = header[1] ?? null
      continue
    }
    if (file && /^[+\- ]/.test(line)) {
      lines.push(line.slice(prefix))
      continue
    }
    if (file && (line.startsWith('@@') || line.startsWith('\\') || header)) continue
    flush()
    file = null
    const grep = GREP_LINE.exec(line)
    if (grep?.[1] && isProtectedFile(grep[1])) values.push(...secretValuesOf(grep[1], grep[2] ?? ''))
  }
  flush()
  return values
}

export function redactSecretValues(text: string, values: SecretValue[]): string {
  let result = text
  // 长的先换：一个值是另一个值的一部分时，先换短的会把长的拆坏
  for (const { value, label } of [...values].sort((a, b) => b.value.length - a.value.length)) {
    if (result.includes(value)) result = result.split(value).join(`[hidden by Diffra: ${label}]`)
  }
  return result
}
