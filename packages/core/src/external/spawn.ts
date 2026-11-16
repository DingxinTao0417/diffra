import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, extname, isAbsolute, join } from 'node:path'

// 命令行智能体常见的安装位置：图形界面启动的 Diffra 拿到的 PATH 可能不全（Mac 从访达打开时没有 shell 里加的路径），
// npm 全局目录、Claude Code 的原生安装目录、Homebrew 这些不在 PATH 里时也找一遍
export function commonBinDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir()
  if (process.platform === 'win32') {
    const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming')
    const localAppData = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    return [
      join(appData, 'npm'),
      join(home, '.local', 'bin'),
      join(localAppData, 'pnpm'),
      join(home, 'scoop', 'shims'),
      join(home, '.bun', 'bin'),
      join(localAppData, 'Volta', 'bin'),
      join(env.ProgramFiles ?? 'C:\\Program Files', 'nodejs'),
    ]
  }
  return [
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.claude', 'local'),
    process.platform === 'darwin' ? join(home, 'Library', 'pnpm') : join(home, '.local', 'share', 'pnpm'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ]
}

function pathOf(env: NodeJS.ProcessEnv): string {
  // Windows 上环境变量名不分大小写，复制出来的对象里可能叫 Path
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH')
  return (key ? env[key] : undefined) ?? ''
}

async function isFile(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) return false
  if (process.platform === 'win32') return true
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  )
}

// 按 PATH 和常见安装位置找命令，返回可执行文件的完整路径；找不到是 null。
// Windows 上只认 PATHEXT 里的扩展名：npm 全局目录里同名的无扩展名文件是给 sh 用的脚本，直接起会失败
export async function locateCommand(command: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const windows = process.platform === 'win32'
  const extensions = windows ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((ext) => ext.toLowerCase()) : ['']
  const candidates = (base: string) => (windows && !extensions.includes(extname(base).toLowerCase()) ? extensions.map((ext) => base + ext) : [base])
  if (isAbsolute(command) || command.includes('/') || (windows && command.includes('\\'))) {
    for (const candidate of candidates(command)) if (await isFile(candidate)) return candidate
    return null
  }
  const dirs = [...pathOf(env).split(delimiter), ...commonBinDirs(env)].filter(Boolean)
  for (const dir of dirs) {
    for (const candidate of candidates(join(dir, command))) if (await isFile(candidate)) return candidate
  }
  return null
}

// cmd 的元字符，参照 cross-spawn：先按 CommandLineToArgvW 的规则加引号，再给元字符加 ^
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

function escapeCmdArgument(arg: string): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`
  return quoted.replace(CMD_META, '^$1')
}

export interface SpawnOptions {
  cwd: string
  env: NodeJS.ProcessEnv
}

// Windows 上 .cmd、.bat（npm 装的命令都是）不能直接 spawn（Node 为防注入会报 EINVAL），经 cmd.exe 起，参数逐个转义。
// 命令所在目录放到 PATH 最前面：在常见安装位置里找到的 npm 命令，它的脚本要在同一目录里找 node 之外的东西。
// 非 Windows 上自成一个进程组，结束时连它拉起的子进程一起结束
export function spawnCommand(path: string, args: string[], options: SpawnOptions): ChildProcessWithoutNullStreams {
  const pathKey = Object.keys(options.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
  const env = { ...options.env, [pathKey]: [dirname(path), pathOf(options.env)].filter(Boolean).join(delimiter) }
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(path)) {
    const line = [path.replace(CMD_META, '^$1'), ...args.map(escapeCmdArgument)].join(' ')
    return spawn(env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { cwd: options.cwd, env, windowsVerbatimArguments: true, windowsHide: true, stdio: 'pipe' })
  }
  return spawn(path, args, { cwd: options.cwd, env, windowsHide: true, stdio: 'pipe', detached: process.platform !== 'win32' })
}

// 结束进程和它拉起的子进程：Windows 用 taskkill /T，其他系统结束整个进程组
export function killTree(child: ChildProcessWithoutNullStreams): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  const pid = child.pid
  setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }, 2000).unref()
}
