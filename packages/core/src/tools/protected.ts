import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fromMsysPath } from './workspace.js'

// 可能含有密钥的文件：agent 不能读、不能改、搜不到，命令里提到它们时要用户确认
const PROTECTED_NAMES = new Set(['.env', '.npmrc', '.pypirc', '.netrc', '.git-credentials'])
// 示例配置一般会提交进仓库，不含真实密钥
const ENV_EXAMPLES = new Set(['.env.example', '.env.sample', '.env.template', '.env.dist'])
const PROTECTED_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx']
const PRIVATE_KEY = /^id_(rsa|ed25519|ecdsa)(?!.*\.pub$)/

// 给 ripgrep 和 git 用的排除规则。比上面的判断更宽：示例配置和 .pub 公钥也一并排除
export const PROTECTED_GLOBS = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa*',
  'id_ed25519*',
  'id_ecdsa*',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
]

export function isProtectedFile(path: string): boolean {
  const name = (path.replace(/\\/g, '/').split('/').at(-1) ?? '').toLowerCase()
  if (ENV_EXAMPLES.has(name)) return false
  if (PROTECTED_NAMES.has(name) || name.startsWith('.env.')) return true
  if (PROTECTED_EXTENSIONS.some((extension) => name.endsWith(extension))) return true
  return PRIVATE_KEY.test(name)
}

// 禁写目录统一成相对项目根目录、/ 分隔、不带首尾斜杠（保留大小写，git 排除规则要用）
export function cleanReadOnlyPath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+|\/+$/g, '')
}

// 比较时 Windows 上不分大小写
function comparable(path: string): string {
  const cleaned = cleanReadOnlyPath(path)
  return process.platform === 'win32' ? cleaned.toLowerCase() : cleaned
}

// path 可以是绝对路径、相对 cwd 的路径或 Git Bash 风格路径
export function isUnderReadOnly(cwd: string, path: string, readOnlyPaths: string[]): boolean {
  if (readOnlyPaths.length === 0) return false
  const relativePath = relative(cwd, resolve(cwd, fromMsysPath(path)))
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) return false
  const target = comparable(relativePath.split(sep).join('/'))
  return readOnlyPaths.some((dir) => {
    const root = comparable(dir)
    return root !== '' && (target === root || target.startsWith(`${root}/`))
  })
}
