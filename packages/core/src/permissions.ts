import { type Dirent, readdirSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { parse } from 'shell-quote'
import type { PermissionMode } from './protocol.js'
import { isProtectedFile, isUnderReadOnly } from './tools/protected.js'
import { fromMsysPath } from './tools/workspace.js'

export type CommandDecision = { level: 'allow' } | { level: 'ask' } | { level: 'deny'; reason: string }


export interface CommandPolicy {
  cwd: string
  // 用户配置的检查命令，整条完全一致时自动放行
  trusted: string[]
  // 「本会话内允许同类命令」记下的命令键
  alwaysAllowed: ReadonlySet<string>
  readOnlyPaths: string[]
  mode: PermissionMode
  // 命令在哪个目录跑（exec_command 的 workdir），相对路径按它算；不给就是 cwd
  workdir?: string
  // 项目外也能直接读的目录：Skill、被截短的命令输出（和读文件工具的 readRoots 一样）
  readRoots?: string[]
}

// 命令里出现受保护文件的名字就要用户确认，哪怕是只读命令（cat .env 会把密钥读给模型）；完全访问模式不问（第 495 步）
export const MENTIONS_SECRET = /\.env|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_rsa|id_ed25519|id_ecdsa|\.(pem|key|p12|pfx)\b/i

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
  'ls', 'nl', 'printf', 'pwd', 'realpath', 'rg', 'sort', 'stat', 'tail', 'tree', 'true', 'uniq', 'wc', 'which', 'whoami',
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
  const parsed = splitSegments(trimmed, true)
  if (SYSTEM_DANGEROUS.test(trimmed)) {
    return { level: 'deny', reason: '系统级危险命令' }
  }
  // 换了变量写法还拆不开的命令：看不清要做什么，下面的检查都做不了，哪种模式都先问
  if (parsed === null) return { level: 'ask' }
  const loose = parsed
  if (loose.some(isRecursiveDeleteOfRoot)) {
    return { level: 'deny', reason: '递归删除根目录、用户目录、上级目录或整个项目' }
  }
  if (policy.trusted.some((item) => item.trim() === trimmed)) return { level: 'allow' }
  if (loose.some(killsByName)) return { level: 'ask' }
  // 涉及禁写目录的非只读命令，哪种模式、之前选没选过「同类命令始终允许」都要再问；
  // 重定向也按分隔符拆开，echo x > data/db.json 的目标路径同样算在内
  const touchesReadOnly = (argv: string[]) =>
    !isReadOnly(argv) && argv.some((arg) => argumentPaths(arg).some((path) => isUnderReadOnly(policy.cwd, path, policy.readOnlyPaths)))
  // 完全访问只剩上面的直接拒绝和禁写目录（第 495 步）：和 Claude Code 的 bypassPermissions、Codex 的完全访问一样，
  // 不因为命令可能读到 .env 再问。apply_patch 改不了受保护文件这条另算，不受模式影响
  if (policy.mode === 'full') return loose.some(touchesReadOnly) ? { level: 'ask' } : { level: 'allow' }
  // 命令实际在哪跑：带了 workdir 就从那里算（第 628 步，回放题里 npx tsc 带 workdir 跑在子包里，按项目根找不到本地命令）
  const runDir = resolve(policy.cwd, policy.workdir ?? '.')
  // 通配符、递归搜索、关掉忽略规则能读到 .env 这类受保护文件：真会读到才问，要搜的地方没有就放行
  if (mayReadSecret(loose, runDir)) return { level: 'ask' }
  if (mentionsSecret(trimmed, splitSegments(trimmed, true))) return { level: 'ask' }
  if (loose.some(touchesReadOnly)) return { level: 'ask' }
  // 命令替换、反引号里可以藏任何命令
  const substitution = /\$\(|`|<\(|>\(/.test(trimmed)

  if (policy.mode === 'auto') return substitution || hasRiskySegment(loose, runDir) ? { level: 'ask' } : { level: 'allow' }

  if (substitution) return { level: 'ask' }
  const segments = splitSegments(trimmed)
  if (segments === null) return { level: 'ask' }
  // 每次询问模式下，只读命令读到项目外（../、绝对路径、~）也要先问（第 549 步）：换内核前读项目外的文件要授权，换成命令读文件后漏了
  if (segments.some((argv) => isReadOnly(argv) && readsOutside(argv, policy))) return { level: 'ask' }
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
// 按进程名、按条件结束进程（taskkill /IM、/FI，pkill，killall）：会把用户别的程序一起结束。
// 第 525 步：评测里模型停不掉自己起的服务，跑了 taskkill //IM node.exe。哪种模式、选没选过「同类命令始终允许」都要问；按 PID 结束的不在此列
function killsByName(argv: string[]): boolean {
  const program = programName(argv[0] ?? '')
  if (program === 'pkill' || program === 'killall') return true
  return program === 'taskkill' && argv.slice(1).some((arg) => /^[-/]+(im|fi)$/i.test(arg))
}

// 第 628 步：评测里回放 Diffra 自己的提交，自动审批下平均每题要点 3 次确认，大多是 npx vitest、npx tsc 这种跑项目里已装好的命令。
// npx 要跑的命令在当前目录或上级目录的 node_modules/.bin 里有、又没让它另装包（-p、--package、-c）时不会下载，和 npm test 一样放行
const NPX_PACKAGE_OPTIONS = /^(-p|--package|-c|--call)(=|$)/
function npxRunsLocalBin(argv: string[], dir: string | null): boolean {
  if (dir === null) return false
  // 只看命令名前面的参数：后面的是那个命令自己的（npx tsc -p tsconfig.json 的 -p 不是 npx 的）
  const args = argv.slice(1)
  const binIndex = args.findIndex((arg) => !arg.startsWith('-'))
  if (binIndex < 0 || args.slice(0, binIndex).some((arg) => NPX_PACKAGE_OPTIONS.test(arg))) return false
  const bin = args[binIndex]!
  if (!/^[\w.@-]+$/.test(bin) || bin.includes('@', 1)) return false
  for (let current = dir; ; current = dirname(current)) {
    const binDir = resolve(current, 'node_modules', '.bin')
    if (['', '.cmd', '.ps1'].some((extension) => statSync(resolve(binDir, `${bin}${extension}`), { throwIfNoEntry: false })?.isFile())) return true
    if (dirname(current) === current) return false
  }
}

// 整条命令里有没有要询问的段；跟着 cd 走，npx 跑本地命令时按所在目录找
function hasRiskySegment(segments: string[][], cwd: string): boolean {
  let dir: string | null = cwd
  for (const argv of segments) {
    const program = programName(argv[0] ?? '')
    if (program === 'cd') {
      const target = argv[1]
      dir = dir !== null && target !== undefined && isKnownPath(target) ? resolve(dir, fromMsysPath(target)) : null
      continue
    }
    if ((program === 'npx' || program === 'bunx') && npxRunsLocalBin(argv, dir)) continue
    if (isRisky(argv)) return true
  }
  return false
}

// grep、rg 的搜索模式里写了 .env 只是在搜这几个字，不读那个文件（第 628 步）：要读的路径和 -g、--include 这类挑文件的规则照旧算。
// 会不会真读到受保护文件由 mayReadSecret 看；读到了，输出里的值也会被换掉（第 625 步）
const FILE_FILTER_OPTIONS = new Set(['-g', '--glob', '--iglob', '--include', '--exclude'])
function mentionsSecret(command: string, segments: string[][] | null): boolean {
  if (segments === null) return MENTIONS_SECRET.test(command)
  return segments.some((argv) => {
    const program = programName(argv[0] ?? '')
    if (program !== 'grep' && program !== 'rg') return MENTIONS_SECRET.test(argv.join(' '))
    const args = argv.slice(1)
    const filters = args.flatMap((arg, index) => {
      if (FILE_FILTER_OPTIONS.has(arg)) return [args[index + 1] ?? '']
      const [option, ...value] = arg.split('=')
      return option && FILE_FILTER_OPTIONS.has(option) && value.length > 0 ? [value.join('=')] : []
    })
    return [...searchPaths(program, args), ...filters].some((arg) => MENTIONS_SECRET.test(arg))
  })
}

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

// shell-quote 遇到 ${}、${h.endedAt} 这种写法直接抛 Bad substitution（第 632 步）：以前这个异常把整轮当成模型出错停掉了。
// bash 也只在跑到那一段时才报错，前面几段照样执行，所以把这些换成普通变量再拆一次，危险命令检查照做
function parseShell(command: string): ReturnType<typeof parse> | null {
  try {
    return parse(command, (key) => `$${key}`)
  } catch {
    try {
      return parse(command.replace(/\$\{[^}]*\}?/g, '$__'), (key) => `$${key}`)
    } catch {
      return null
    }
  }
}

// 返回 null 表示含有重定向、后台执行、子 shell 等需要人工确认的写法；
// loose 为 true 时把这些写法也当分隔符，只用来做危险命令检查；两种都在拆不开时返回 null
function splitSegments(command: string, loose = false): string[][] | null {
  const tokens = parseShell(command)
  if (tokens === null) return null
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
// 第 495 步起只在真会读到时才问：看递归搜索要搜的目录、通配符能匹配到的文件里有没有受保护文件。
// cd 会换后面几段的目录；目录写成 ~、$HOME 这类没法确定的，按会读到处理
function mayReadSecret(segments: string[][], cwd: string): boolean {
  let dir: string | null = cwd
  for (const argv of segments) {
    const program = programName(argv[0] ?? '')
    if (program === 'cd') {
      const target = argv[1]
      dir = dir !== null && target !== undefined && isKnownPath(target) ? resolve(dir, fromMsysPath(target)) : null
      continue
    }
    if (!CONTENT_READERS.has(program)) continue
    const args = argv.slice(1)
    const recursive = (program === 'grep' && args.some((arg) => GREP_RECURSIVE.test(arg))) || (program === 'rg' && args.some((arg) => IGNORE_OFF_FLAG.test(arg)))
    const files = program === 'grep' || program === 'rg' ? searchPaths(program, args) : args.filter((arg) => !arg.startsWith('-'))
    // grep -r、rg 不写路径时搜当前目录
    if (recursive && (files.length > 0 ? files : ['.']).some((arg) => reachesProtected(dir, arg, true))) return true
    if (files.some((arg) => /[*?]/.test(arg) && couldMatchProtected(arg) && reachesProtected(dir, arg, false))) return true
  }
  return false
}

// 参数是要读的路径的只读命令；ls 这几个不写路径时读的是当前目录
const PATH_READERS = new Set([...CONTENT_READERS, 'ls', 'tree', 'stat', 'file', 'wc', 'du', 'find'])
const LISTS_CURRENT_DIR = new Set(['ls', 'tree', 'du', 'find', 'rg'])

// 这条只读命令要读的路径：grep、rg 跳过搜索模式和选项的值，awk、sed 跳过脚本，find 只看开头的起点
function readPaths(program: string, args: string[]): string[] {
  if (program === 'grep' || program === 'rg') return searchPaths(program, args)
  const positional = args.filter((arg) => !arg.startsWith('-'))
  if (program === 'awk' || program === 'sed') return positional.slice(1)
  if (program === 'find') {
    const end = args.findIndex((arg) => arg.startsWith('-') || arg === '(' || arg === '!')
    return end < 0 ? args : args.slice(0, end)
  }
  return positional
}

const isInsideDir = (dir: string, target: string) => {
  const rel = relative(dir, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// 读到项目外了吗：落在 readRoots（Skill、命令输出）里的不算；~、$HOME 这类看不出在哪的按项目外算
function readsOutside(argv: string[], policy: CommandPolicy): boolean {
  const program = programName(argv[0] ?? '')
  if (!PATH_READERS.has(program)) return false
  const dir = resolve(policy.cwd, policy.workdir ?? '.')
  const paths = readPaths(program, argv.slice(1))
  const targets = paths.length > 0 ? paths : LISTS_CURRENT_DIR.has(program) ? ['.'] : []
  return targets.some((arg) => {
    if (!isKnownPath(arg)) return true
    const target = resolve(dir, fromMsysPath(arg))
    return !isInsideDir(policy.cwd, target) && !(policy.readRoots ?? []).some((root) => isInsideDir(root, target))
  })
}

// grep、rg 后面要跟一个值的选项：值是过滤规则、行数、文件类型，不是要读的路径（rg -g '!**/x/**' 里的 * 不是在读文件）
const SEARCH_VALUE_OPTIONS: Record<'grep' | 'rg', Set<string>> = {
  grep: new Set(['-e', '-f', '-m', '-A', '-B', '-C', '-d', '-D', '--regexp', '--file', '--max-count', '--after-context', '--before-context', '--context', '--include', '--exclude', '--exclude-dir', '--label', '--binary-files', '--devices', '--directories', '--color', '--colour']),
  rg: new Set([
    '-e', '-f', '-g', '-m', '-A', '-B', '-C', '-M', '-t', '-T', '-j', '-E', '-r', '-d',
    '--regexp', '--file', '--glob', '--iglob', '--max-count', '--after-context', '--before-context', '--context', '--max-columns', '--type', '--type-not',
    '--threads', '--encoding', '--replace', '--max-depth', '--type-add', '--type-clear', '--sort', '--sortr', '--color', '--colors', '--path-separator',
    '--pre', '--pre-glob', '--max-filesize', '--ignore-file', '--engine', '--context-separator', '--field-match-separator', '--field-context-separator',
  ]),
}

// grep、rg 要读的路径：跳过选项和它们的值；第一个剩下的是搜索模式，除非用 -e、-f 给了模式，或者 rg --files 只列文件
function searchPaths(program: 'grep' | 'rg', args: string[]): string[] {
  const positional: string[] = []
  let patternGiven = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--') {
      positional.push(...args.slice(index + 1))
      break
    }
    if (!arg.startsWith('-') || arg === '-') {
      positional.push(arg)
      continue
    }
    if (/^(-e|-f|--regexp|--file)(=|$)/.test(arg) || /^-[ef]./.test(arg) || (program === 'rg' && (arg === '--files' || arg === '--type-list'))) patternGiven = true
    if (SEARCH_VALUE_OPTIONS[program].has(arg)) index++
  }
  return patternGiven ? positional : positional.slice(1)
}

// 递归搜索、通配符最多看这么多个目录项，看不完就当会读到受保护文件。一万项在本机几十毫秒，普通项目（跳过依赖和 .git）够用
export const MAX_SCAN_ENTRIES = 10_000
const SKIPPED_DIRS = new Set(['node_modules', '.git'])

const isKnownPath = (arg: string) => !/[$~`]/.test(arg)

// 这个参数在 dir 下（递归时连同子目录）能碰到受保护文件吗
function reachesProtected(dir: string | null, arg: string, recursive: boolean): boolean {
  if (dir === null || !isKnownPath(arg)) return true
  const path = resolve(dir, fromMsysPath(arg))
  if (/[*?[]/.test(arg)) {
    // 通配符只认最后一段，前面的目录里还有通配符就不细看了
    const base = dirname(path)
    if (/[*?[]/.test(base)) return true
    const pattern = basename(path)
    if (recursive) return scanForProtected(base, () => true)
    return scanForProtected(base, (name) => globMatches(pattern, name), false)
  }
  let stats
  try {
    stats = statSync(path)
  } catch {
    // 不存在的路径读不到东西
    return false
  }
  if (!stats.isDirectory()) return isProtectedFile(path)
  return recursive && scanForProtected(path, () => true)
}

// 在 root 里找名字符合 match 的受保护文件；超过 MAX_SCAN_ENTRIES 还没看完按找到处理
function scanForProtected(root: string, match: (name: string) => boolean, recursive = true): boolean {
  const pending = [root]
  let seen = 0
  while (pending.length > 0) {
    const dir = pending.pop()!
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (++seen > MAX_SCAN_ENTRIES) return true
      if (entry.isDirectory()) {
        if (recursive && !SKIPPED_DIRS.has(entry.name)) pending.push(resolve(dir, entry.name))
      } else if (match(entry.name) && isProtectedFile(entry.name)) {
        return true
      }
    }
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

// 整条命令都是只读的（每一段都是只读命令，没有重定向、命令替换、后台执行）：只读的智能体只能跑这种（第 508 步）
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim()
  if (/\$\(|`|<\(|>\(/.test(trimmed)) return false
  const segments = splitSegments(trimmed)
  return segments !== null && segments.length > 0 && segments.every(isReadOnly)
}

function isReadOnly(argv: string[]): boolean {
  const program = programName(argv[0] ?? '')
  if (program === 'git') return READ_ONLY_GIT.has(argv[1] ?? '')
  if (program === 'find') return !argv.some((arg) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint'].includes(arg))
  if (program === 'sort') return !argv.some((arg) => arg === '-o' || arg.startsWith('--output'))
  if (program === 'sed') return isSedPrint(argv)
  return READ_ONLY.has(program)
}

// sed 只认 -n 'N,Mp' 这种按行号打印一段的写法（第 508 步起读文件靠它，和 Codex 早先的安全命令表一样）；
// -i、w、e 这些会改文件、跑命令的写法都不算
function isSedPrint(argv: string[]): boolean {
  const args = argv.slice(1)
  if (!args.includes('-n') || args.some((arg) => arg.startsWith('-') && arg !== '-n')) return false
  const [script, ...files] = args.filter((arg) => arg !== '-n')
  return script !== undefined && /^(\d+|\$)(,(\d+|\$))?p$/.test(script) && files.length > 0
}

function programName(token: string): string {
  return basename(token).toLowerCase().replace(/\.exe$/, '')
}
