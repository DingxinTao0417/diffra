import { basename } from 'node:path'
import { parse } from 'shell-quote'
import type { PermissionMode } from './protocol.js'
import { isUnderReadOnly } from './tools/protected.js'

export type CommandDecision = { level: 'allow' } | { level: 'ask' } | { level: 'deny'; reason: string }


export interface CommandPolicy {
  cwd: string
  // 用户配置的检查命令，整条完全一致时自动放行
  trusted: string[]
  // 「本会话内允许同类命令」记下的命令键
  alwaysAllowed: ReadonlySet<string>
  readOnlyPaths: string[]
  mode: PermissionMode
}

// 命令里出现受保护文件的名字就要用户确认，哪怕是只读命令（cat .env 会把密钥读给模型）
const MENTIONS_SECRET = /\.env|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_rsa|id_ed25519|id_ecdsa|\.(pem|key|p12|pfx)\b/i

// 和 tools/protected.ts 的判断保持一致：这些文件名可能含密钥
const PROTECTED_NAMES = ['.env', '.npmrc', '.pypirc', '.netrc', '.git-credentials', 'id_rsa', 'id_ed25519', 'id_ecdsa']
const PROTECTED_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx']

// 会读出文件内容的只读命令
const CONTENT_READERS = new Set(['cat', 'head', 'tail', 'strings', 'xxd', 'od', 'base64', 'nl', 'tac', 'grep', 'rg', 'awk', 'sed', 'cut', 'sort', 'uniq', 'diff'])
// grep 递归时不看 .gitignore，.env 这类文件也会被读到；rg 关掉忽略规则或加上 --hidden 时同理
const GREP_RECURSIVE = /^-{1,2}([a-zA-Z]*[rR][a-zA-Z]*|recursive|dereference-recursive)$/
const IGNORE_OFF_FLAG = /^-{1,2}([a-zA-Z]*u[a-zA-Z]*|no-ignore|hidden|no-ignore-vcs|no-ignore-parent|no-ignore-global)$/

// 只读命令：不改文件、不联网、不执行别的程序
const READ_ONLY = new Set([
  'basename', 'cat', 'cut', 'date', 'df', 'diff', 'dirname', 'du', 'echo', 'false', 'file', 'grep', 'head',
  'ls', 'printf', 'pwd', 'realpath', 'rg', 'sort', 'stat', 'tail', 'tree', 'true', 'uniq', 'wc', 'which', 'whoami',
])

const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'grep'])

// 整条命令里危险的是这几条管道写法（下载即执行、fork 炸弹）和强制推送
const PIPELINE_DENY: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bgit\s+push\b.*\s(--force|-f|--force-with-lease)\b/, reason: '强制推送' },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/, reason: '下载脚本直接执行' },
  { pattern: /:\(\)\s*\{/, reason: 'fork 炸弹' },
]

// 系统级危险命令按「命令位置」判断：整条字符串匹配会把 `pnpm run format`、
// `git log --format=oneline`、`git commit -m "fix shutdown"` 这类普通命令误杀；
// 按段判断又会把 `echo x > format` 里的文件名当成命令
const SYSTEM_DANGEROUS =
  /(?:^|[;&|]\s*|\bsudo\s+|\bxargs\s+)(mkfs(?:\.\w+)?|shutdown|reboot|halt|poweroff|diskpart|format|fdisk|sfdisk|parted)(?:\s|$)/i

// 删文件的命令不记「同类命令始终允许」：批准一次 rm 文件不该等于允许 rm -rf 目录
const NEVER_REMEMBER = new Set(['rm', 'rmdir'])
// 项目设置里手填的「始终允许的命令」也过这一道，填了 rm 不生效
export const canRememberCommand = (key: string): boolean => !NEVER_REMEMBER.has(key.split(' ')[0] ?? '')

// 把命令拆成若干段（&& || ; |），每段都是只读或在白名单里才自动放行
export function classifyCommand(command: string, policy: CommandPolicy): CommandDecision {
  const trimmed = command.trim()
  for (const { pattern, reason } of PIPELINE_DENY) {
    if (pattern.test(trimmed)) return { level: 'deny', reason }
  }
  const loose = splitSegments(trimmed, true) ?? []
  if (SYSTEM_DANGEROUS.test(trimmed)) {
    return { level: 'deny', reason: '系统级危险命令' }
  }
  if (loose.some(isRecursiveDeleteOfRoot)) {
    return { level: 'deny', reason: '递归删除根目录、用户目录、上级目录或整个项目' }
  }
  if (policy.trusted.some((item) => item.trim() === trimmed)) return { level: 'allow' }
  // 通配符、递归搜索、关掉忽略规则都能读到 .env 这类受保护文件，不只是字面写出名字
  if (mayReadSecret(loose)) return { level: 'ask' }
  if (MENTIONS_SECRET.test(trimmed)) return { level: 'ask' }
  // 涉及禁写目录的非只读命令，哪种模式、之前选没选过「同类命令始终允许」都要再问；
  // 重定向也按分隔符拆开，echo x > data/db.json 的目标路径同样算在内
  const touchesReadOnly = (argv: string[]) =>
    !isReadOnly(argv) && argv.some((arg) => argumentPaths(arg).some((path) => isUnderReadOnly(policy.cwd, path, policy.readOnlyPaths)))
  if (loose.some(touchesReadOnly)) return { level: 'ask' }
  // 命令替换、反引号里可以藏任何命令
  const substitution = /\$\(|`|<\(|>\(/.test(trimmed)

  if (policy.mode === 'full') return { level: 'allow' }
  if (policy.mode === 'auto') return substitution || loose.some(isRisky) ? { level: 'ask' } : { level: 'allow' }

  if (substitution) return { level: 'ask' }
  const segments = splitSegments(trimmed)
  if (segments === null) return { level: 'ask' }
  const allowed = segments.every(
    (argv) =>
      isReadOnly(argv) ||
      policy.alwaysAllowed.has(commandKey(argv)) ||
      policy.trusted.some((item) => item.trim() === argv.join(' ')),
  )
  return allowed ? { level: 'allow' } : { level: 'ask' }
}

const RISKY_GIT = new Set(['push', 'reset', 'clean', 'rebase', 'restore', 'checkout'])
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'uv', 'poetry', 'cargo', 'go', 'gem', 'composer'])
const PACKAGE_CHANGES = new Set(['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'un', 'update', 'upgrade', 'up', 'ci', 'get', 'dlx'])
const NETWORK = new Set(['curl', 'wget', 'invoke-webrequest', 'iwr', 'scp', 'ssh', 'rsync', 'ftp'])

// 自动审批模式下仍要询问的命令：改 git 历史或远端、装卸依赖、下载即执行、联网传输、递归删除、提权
function isRisky(argv: string[]): boolean {
  const program = programName(argv[0] ?? '')
  const sub = (argv[1] ?? '').toLowerCase()
  if (program === 'git') return RISKY_GIT.has(sub)
  if (PACKAGE_MANAGERS.has(program)) return PACKAGE_CHANGES.has(sub)
  if (program === 'npx' || program === 'bunx' || program === 'sudo') return true
  if (NETWORK.has(program)) return true
  if (program === 'rm') return argv.slice(1).some((arg) => arg === '--recursive' || /^-[a-zA-Z]*[rR]/.test(arg))
  if (program === 'rmdir') return true
  return false
}

// 参数本身和 --flag=value 里的 value 都可能是路径
function argumentPaths(arg: string): string[] {
  return [arg, ...arg.split('=').slice(1)].filter(Boolean)
}

// 「本会话内允许同类命令」的粒度：程序名，加上不以 - 开头的第一个子命令（如 pnpm test、git commit）。
// rm/rmdir 不记：批准一次删某个文件，不该等于允许之后 rm -rf 任何目录
export function commandKey(argv: string[]): string {
  const program = programName(argv[0] ?? '')
  const sub = argv[1]
  return sub && !sub.startsWith('-') ? `${program} ${sub}` : program
}

// 整条命令的同类键；有多段时每段都要被允许，这里只取需要用户确认的那些段
export function commandKeys(command: string): string[] {
  const segments = splitSegments(command.trim())
  if (segments === null) return []
  return segments.filter((argv) => !isReadOnly(argv)).map(commandKey).filter(canRememberCommand)
}

// 命令里每段 git 的子命令，跳过 -C 路径、-c 键=值和其他全局参数；用来认出提交和推送
export function gitSubcommands(command: string): string[] {
  return (splitSegments(command.trim(), true) ?? []).flatMap((argv) => {
    if (programName(argv[0] ?? '') !== 'git') return []
    for (let index = 1; index < argv.length; index++) {
      const arg = argv[index]!
      if (arg === '-C' || arg === '-c') index++
      else if (!arg.startsWith('-')) return [arg.toLowerCase()]
    }
    return []
  })
}

const DANGEROUS_RM_TARGETS =new Set(['/', '/*', '~', '~/', '~/*', '$HOME', '$HOME/', '..', '../', '.', './', '*'])

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

// 只读命令也可能读到受保护文件：cat .e* 用通配符绕过字面名字，rg -uuu / grep -r 会扫到 .env。
// 这两种情况都要问一下，不能当成安全只读命令直接放行
function mayReadSecret(segments: string[][]): boolean {
  for (const argv of segments) {
    const program = programName(argv[0] ?? '')
    if (!CONTENT_READERS.has(program)) continue
    const args = argv.slice(1)
    if (program === 'grep' && args.some((arg) => GREP_RECURSIVE.test(arg))) return true
    if (program === 'rg' && args.some((arg) => IGNORE_OFF_FLAG.test(arg))) return true
    // grep/rg 的第一个非选项参数是搜索模式，可能带正则里的 *；只看它后面的文件参数
    const firstValue = args.findIndex((arg) => !arg.startsWith('-'))
    const files = program === 'grep' || program === 'rg' ? args.slice(firstValue + 1) : args
    if (files.some((arg) => !arg.startsWith('-') && /[*?]/.test(arg) && couldMatchProtected(arg))) return true
  }
  return false
}

// 通配符能匹配到受保护的名字吗（cat .e* → .env；*.pem → 任何 pem）
function couldMatchProtected(pattern: string): boolean {
  const name = pattern.replace(/\\/g, '/').split('/').at(-1) ?? ''
  return PROTECTED_NAMES.some((item) => globMatches(name, item)) || PROTECTED_EXTENSIONS.some((extension) => globMatches(name, `x${extension}`))
}

function globMatches(pattern: string, name: string): boolean {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  try {
    return new RegExp(`^${source}$`, 'i').test(name)
  } catch {
    return true
  }
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
