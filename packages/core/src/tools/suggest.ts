// 文件或命令找不到时给模型几个候选，免得它接着瞎猜路径和命令名。只是提示，找不到候选也不影响原来的报错
import { readdir } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import { runProcess } from '../process.js'
import { isProtectedFile } from './protected.js'
import type { ToolContext } from './types.js'

const MAX_SUGGESTIONS = 3
// 名字差这么多个字母以内算拼错；太短的名字差一两个字母就是另一个东西了
const MAX_TYPO_DISTANCE = 2
const MIN_TYPO_LENGTH = 4
const LIST_TIMEOUT_MS = 10_000

// 项目里可能想要的文件：同名的（多半是目录写错了）、只差扩展名的、名字拼错一两个字母的。
// 名字越接近越靠前，再按和请求路径共有的上级目录多少排。列文件用 ripgrep，跳过忽略的文件和受保护的文件
export async function similarPaths(context: Pick<ToolContext, 'cwd' | 'rgPath' | 'signal'>, display: string): Promise<string[]> {
  if (isAbsolute(display)) return []
  const listed = await runProcess(context.rgPath, ['--files', '--hidden', '--glob', '!.git', '--path-separator', '/'], {
    cwd: context.cwd,
    timeoutMs: LIST_TIMEOUT_MS,
    signal: context.signal,
  }).catch(() => null)
  if (!listed || listed.exitCode !== 0) return []
  const wanted = basename(display).toLowerCase()
  const wantedDirs = display.toLowerCase().split('/').slice(0, -1)
  const candidates: Array<{ path: string; closeness: number; shared: number }> = []
  for (const path of listed.output.split(/\r?\n/)) {
    if (!path || isProtectedFile(path)) continue
    const name = basename(path).toLowerCase()
    const closeness =
      name === wanted ? 0 : stem(name) === stem(wanted) ? 1 : extname(name) === extname(wanted) && isTypo(stem(name), stem(wanted)) ? 2 : null
    if (closeness === null) continue
    const dirs = path.toLowerCase().split('/').slice(0, -1)
    candidates.push({ path, closeness, shared: dirs.filter((dir) => wantedDirs.includes(dir)).length })
  }
  return candidates
    .filter((candidate) => candidate.path.toLowerCase() !== display.toLowerCase())
    .sort((a, b) => a.closeness - b.closeness || b.shared - a.shared || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, MAX_SUGGESTIONS)
    .map((candidate) => candidate.path)
}

// bash 的 PATH 里名字接近的命令（python3 → python、拼错一两个字母）。
// 不用 compgen -c：Windows 上它要逐个检查 PATH 里的文件，实测十几秒；这里只让 bash 报出 PATH，目录自己列
export async function similarCommands(context: Pick<ToolContext, 'cwd' | 'signal'>, bashPath: string, env: NodeJS.ProcessEnv, name: string): Promise<string[]> {
  const windows = process.platform === 'win32'
  const printed = await runProcess(bashPath, ['-c', windows ? 'cygpath -w -p "$PATH"' : 'printf %s "$PATH"'], {
    cwd: context.cwd,
    timeoutMs: LIST_TIMEOUT_MS,
    signal: context.signal,
    env,
  }).catch(() => null)
  if (!printed || printed.exitCode !== 0) return []
  const dirs = new Set(printed.output.trim().split(windows ? ';' : ':').filter(Boolean))
  const entries = (await Promise.all([...dirs].map((dir) => readdir(dir).catch(() => [])))).flat()
  const wanted = name.toLowerCase()
  // Git Bash 里 foo.exe 可以直接写 foo，.cmd、.bat 要写全名
  const commands = new Set(entries.map((entry) => (windows ? entry.replace(/\.exe$/i, '') : entry)))
  return [...commands]
    .map((command) => ({ command, distance: commandDistance(command.toLowerCase().replace(/\.(cmd|bat)$/, ''), wanted) }))
    .filter((item): item is { command: string; distance: number } => item.distance !== null)
    .sort((a, b) => a.distance - b.distance || a.command.localeCompare(b.command))
    .slice(0, MAX_SUGGESTIONS)
    .map((item) => item.command)
}

function commandDistance(command: string, wanted: string): number | null {
  if (command === wanted) return null
  if (command === wanted.replace(/\d+$/, '') || wanted === command.replace(/\d+$/, '')) return 0
  return isTypo(command, wanted) ? editDistance(command, wanted) : null
}

function stem(name: string): string {
  const extension = extname(name)
  return extension ? name.slice(0, -extension.length) : name
}

function isTypo(a: string, b: string): boolean {
  return Math.min(a.length, b.length) >= MIN_TYPO_LENGTH && Math.abs(a.length - b.length) <= MAX_TYPO_DISTANCE && editDistance(a, b) <= MAX_TYPO_DISTANCE
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    previous = current
  }
  return previous[b.length]!
}
