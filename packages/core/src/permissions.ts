import { basename } from 'node:path'
import { parse } from 'shell-quote'

export type CommandDecision = { level: 'allow' } | { level: 'ask' } | { level: 'deny'; reason: string }

// 只读命令：不改文件、不联网、不执行别的程序
const READ_ONLY = new Set([
  'basename', 'cat', 'cut', 'date', 'df', 'diff', 'dirname', 'du', 'echo', 'false', 'file', 'grep', 'head',
  'ls', 'printf', 'pwd', 'realpath', 'rg', 'sort', 'stat', 'tail', 'tree', 'true', 'uniq', 'wc', 'which', 'whoami',
])

const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'grep'])

const DENY_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bgit\s+push\b.*\s(--force|-f|--force-with-lease)\b/, reason: '强制推送' },
  { pattern: /\b(mkfs|shutdown|reboot|format|diskpart)\b/i, reason: '系统级危险命令' },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/, reason: '下载脚本直接执行' },
  { pattern: /:\(\)\s*\{/, reason: 'fork 炸弹' },
]

// 把命令拆成若干段（&& || ; |），每段都是只读或在白名单里才自动放行
export function classifyCommand(command: string, trusted: string[], alwaysAllowed: ReadonlySet<string>): CommandDecision {
  const trimmed = command.trim()
  for (const { pattern, reason } of DENY_PATTERNS) {
    if (pattern.test(trimmed)) return { level: 'deny', reason }
  }
  if (splitSegments(trimmed, true)?.some(isRecursiveDeleteOfRoot)) {
    return { level: 'deny', reason: '递归删除根目录、用户目录、上级目录或整个项目' }
  }
  if (trusted.some((item) => item.trim() === trimmed)) return { level: 'allow' }
  // 命令替换、反引号里可以藏任何命令，交给用户确认
  if (/\$\(|`|<\(|>\(/.test(trimmed)) return { level: 'ask' }

  const segments = splitSegments(trimmed)
  if (segments === null) return { level: 'ask' }
  const allowed = segments.every(
    (argv) => isReadOnly(argv) || alwaysAllowed.has(commandKey(argv)) || trusted.some((item) => item.trim() === argv.join(' ')),
  )
  return allowed ? { level: 'allow' } : { level: 'ask' }
}

// 「本会话内允许同类命令」的粒度：程序名，加上不以 - 开头的第一个子命令（如 pnpm test、git commit）
export function commandKey(argv: string[]): string {
  const program = programName(argv[0] ?? '')
  const sub = argv[1]
  return sub && !sub.startsWith('-') ? `${program} ${sub}` : program
}

// 整条命令的同类键；有多段时每段都要被允许，这里只取需要用户确认的那些段
export function commandKeys(command: string): string[] {
  const segments = splitSegments(command.trim())
  if (segments === null) return []
  return segments.filter((argv) => !isReadOnly(argv)).map(commandKey)
}

const DANGEROUS_RM_TARGETS = new Set(['/', '/*', '~', '~/', '~/*', '$HOME', '$HOME/', '..', '../', '.', './', '*'])

function isRecursiveDeleteOfRoot(argv: string[]): boolean {
  if (programName(argv[0] ?? '') !== 'rm') return false
  const args = argv.slice(1)
  const recursive = args.some((arg) => arg === '--recursive' || /^-[a-zA-Z]*[rR]/.test(arg))
  return recursive && args.some((arg) => DANGEROUS_RM_TARGETS.has(arg))
}

// 返回 null 表示含有重定向、后台执行、子 shell 等需要人工确认的写法；
// loose 为 true 时把这些写法也当分隔符，只用来做危险命令检查
function splitSegments(command: string, loose = false): string[][] | null {
  const tokens = parse(command, (key) => `$${key}`)
  const segments: string[][] = [[]]
  for (const token of tokens) {
    if (typeof token === 'string') {
      segments.at(-1)?.push(token)
      continue
    }
    if ('comment' in token) continue
    if ('op' in token && token.op === 'glob') {
      segments.at(-1)?.push(token.pattern)
      continue
    }
    if (loose || ('op' in token && ['&&', '||', ';', '|'].includes(token.op))) {
      segments.push([])
      continue
    }
    return null
  }
  return segments.filter((argv) => argv.length > 0)
}

function isReadOnly(argv: string[]): boolean {
  const program = programName(argv[0] ?? '')
  if (program === 'git') return READ_ONLY_GIT.has(argv[1] ?? '')
  if (program === 'find') return !argv.some((arg) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint'].includes(arg))
  if (program === 'sort') return !argv.some((arg) => arg === '-o' || arg.startsWith('--output'))
  return READ_ONLY.has(program)
}

function programName(token: string): string {
  return basename(token).toLowerCase().replace(/\.exe$/, '')
}
