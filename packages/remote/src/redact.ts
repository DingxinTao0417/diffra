import { isProtectedFile } from '@diffra/core'
import { SECRET_FORMATS, type SessionUpdate, type StoredTurn, VISUAL_META_KEY } from '@diffra/core/types'

// 设备连接发出会话前的脱敏和裁剪，只作用于发出去的副本。正则抓不全，只能尽力；真正的边界是授权了哪些项目。
// - 密钥：格式明确的（和安全检查共用 SECRET_FORMATS）、PEM 私钥整块、带引号的赋值、环境变量写法、Authorization 头、地址里的账号密码
// - 可能含密钥的文件（和工具的保护名单共用 isProtectedFile）：路径命中时这一项的文字全部不发
// - 图片、可视化代码不发；单段文字最多 64000 字
// 改动卡片的 oldText、newText、base 不截断：界面按顺序重放改动还原全文，截了就对不上。脱敏不增删换行，重放照样按行对得上

export const MAX_TEXT_CHARS = 64_000
const OMITTED_FILE = '（可能含密钥的文件，内容未同步）'
const OMITTED_IMAGE = '（图片未同步）'
const OMITTED_VISUAL = '<p>（可视化内容未同步）</p>'
const TRUNCATED = '\n…（太长，已截断；完整内容在对方电脑上）'
// 改动卡片里不截断的字段
const DIFF_TEXT_KEYS = new Set(['oldText', 'newText', 'base'])

// 每条规则都有锚点（\b、行首或固定开头）和长度上限：工具输出里一长串字母、base64 时，不加上限会回溯成平方级，
// 64000 字就要几秒，卡住被连接端的主进程（测试里有这几种输入）
const FORMAT_PATTERNS = SECRET_FORMATS.map(({ name, pattern }) => ({ name, pattern: new RegExp(pattern.source, 'g') }))
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]{0,16000}?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g
// 值带引号的才算，免得把代码里的 password: string 这类也换掉
const QUOTED_ASSIGNMENT = /\b([A-Za-z0-9_]{0,40}(?:password|passwd|pwd|secret|api_?key|access_?token|auth_?token|client_?secret|private_?key)["']?\s{0,10}[:=]\s{0,10}["'])([^"'\s]{8,1000})(?=["'])/gi
// 环境变量：行首、全大写的名字
const ENV_ASSIGNMENT = /^([ \t]{0,40}(?:export[ \t]+|set[ \t]+)?[A-Z0-9_]{0,40}(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)[A-Z0-9_]{0,40}[ \t]{0,10}=[ \t]{0,10})(\S{1,1000})/gm
const AUTHORIZATION = /(\bAuthorization\s{0,10}:\s{0,10}(?:Bearer|Basic|Token)\s{1,10})[^\s"',;]{1,4000}/gi
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/:@]{1,256}:[^\s/@]{1,256}@/gi

export function redactText(text: string, truncate = true): string {
  // 先换整段的值，再按格式找剩下的：反过来的话，「[已脱敏：模型服务的 API Key]」会被赋值规则从空格处截断
  let result = text
    .replace(PRIVATE_KEY_BLOCK, (block) => `[已脱敏：私钥]${'\n'.repeat(block.split('\n').length - 1)}`)
    .replace(QUOTED_ASSIGNMENT, '$1[已脱敏]')
    .replace(ENV_ASSIGNMENT, '$1[已脱敏]')
    .replace(AUTHORIZATION, '$1[已脱敏]')
    .replace(URL_CREDENTIALS, '$1[已脱敏]@')
  for (const { name, pattern } of FORMAT_PATTERNS) result = result.replace(pattern, `[已脱敏：${name}]`)
  return truncate && result.length > MAX_TEXT_CHARS ? result.slice(0, MAX_TEXT_CHARS) + TRUNCATED : result
}

// 只换字符串的值、把图片换成同一位置上合法的文字内容，结构不变，所以结果仍是原来的类型
export function redactUpdate(update: SessionUpdate): SessionUpdate {
  return walk(update, false) as SessionUpdate
}

// 提问带的图片不发，记下有几张
export function redactTurn(turn: StoredTurn): StoredTurn & { omittedImages?: number } {
  const { images, ...rest } = turn
  const redacted = walk(rest, false) as Omit<StoredTurn, 'images'>
  return { ...redacted, images: [], ...(images.length > 0 ? { omittedImages: images.length } : {}) }
}

function walk(value: unknown, omit: boolean, key?: string): unknown {
  if (typeof value === 'string') {
    if (omit && key !== 'type' && key !== 'path') return OMITTED_FILE
    return redactText(value, !(key && DIFF_TEXT_KEYS.has(key)))
  }
  if (Array.isArray(value)) return value.map((item) => walk(item, omit))
  if (typeof value !== 'object' || value === null) return value
  const object = value as Record<string, unknown>
  if (object.type === 'image' && typeof object.data === 'string') return { type: 'text', text: OMITTED_IMAGE }
  if (key === VISUAL_META_KEY && typeof object.code === 'string') return { ...object, title: typeof object.title === 'string' ? redactText(object.title) : object.title, code: OMITTED_VISUAL }
  const protectedPath = typeof object.path === 'string' && isProtectedFile(object.path)
  return Object.fromEntries(Object.entries(object).map(([name, item]) => [name, walk(item, omit || protectedPath, name)]))
}
