import { isProtectedFile } from '@diffra/core'
import { SECRET_FORMATS, type SessionUpdate, type StoredTurn, type ToolCallContent, TOOL_PREVIEW_META_KEY, VISUAL_META_KEY, VISUAL_SNAPSHOT_MAX_CHARS, VISUAL_SNAPSHOT_META_KEY, VISUAL_SNAPSHOT_TYPES } from '@diffra/core/types'
import { MAX_DIFF_CHARS, TOOL_PREVIEW_CHARS } from './messages.js'

// 设备连接发出会话前的脱敏和裁剪，只作用于发出去的副本。正则抓不全，只能尽力；真正的边界是授权了哪些项目。
// - 密钥：格式明确的（和安全检查共用 SECRET_FORMATS）、PEM 私钥整块、带引号的赋值、环境变量写法、Authorization 头、地址里的账号密码
// - 可能含密钥的文件（和工具的保护名单共用 isProtectedFile）：路径命中时这一项的文字全部不发
// - 图片、可视化代码不发；单段文字最多 64000 字
// - 可视化的快照照发（第 670 步，用户定的：压缩后同步给授权设备，对方不跑可视化的脚本也能看）：只认压过的小图，一轮合计有上限
// 改动卡片的 oldText、newText、base 不截断：界面按顺序重放改动还原全文，截了就对不上。脱敏不增删换行，重放照样按行对得上

export const MAX_TEXT_CHARS = 64_000
const OMITTED_FILE = '（可能含密钥的文件，内容未同步）'
const OMITTED_IMAGE = '（图片未同步）'
const OMITTED_VISUAL = '<p>（可视化内容未同步）</p>'
// 一页至少一轮：一轮几十张快照时，超出这么多字的换成占位，免得超过单条消息的上限
const TURN_SNAPSHOT_CHARS = 1_600_000
const TRUNCATED = '\n…（太长，已截断；完整内容在对方电脑上）'
// 改动卡片里不截断的字段
const DIFF_TEXT_KEYS = new Set(['oldText', 'newText', 'base'])

// 每条规则都有锚点（\b、行首或固定开头）和长度上限：工具输出里一长串字母、base64 时，不加上限会回溯成平方级，
// 64000 字就要几秒，卡住被连接端的主进程（测试里有这几种输入）
const FORMAT_PATTERNS = SECRET_FORMATS.map(({ name, pattern }) => ({ name, pattern: new RegExp(pattern.source, 'g') }))
// 私钥块：BEGIN 到最近的 END，中间最多 16000 字。不用 [\s\S]{0,16000}? 一条正则：每个配不上 END 的 BEGIN 都要往后扫 16000 字，
// 几千个只有开头的私钥头要一秒多（第 497 步，CI 上超时）；改成 BEGIN、END 各自往前找一遍，下一个 END 记着复用
const PRIVATE_KEY_BEGIN = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g
const PRIVATE_KEY_END = /-----END (?:[A-Z]+ )?PRIVATE KEY-----/g
const MAX_PRIVATE_KEY_BODY = 16_000
// 值带引号的才算，免得把代码里的 password: string 这类也换掉
const QUOTED_ASSIGNMENT = /\b([A-Za-z0-9_]{0,40}(?:password|passwd|pwd|secret|api_?key|access_?token|auth_?token|client_?secret|private_?key)["']?\s{0,10}[:=]\s{0,10}["'])([^"'\s]{8,1000})(?=["'])/gi
// 环境变量：行首、全大写的名字
const ENV_ASSIGNMENT = /^([ \t]{0,40}(?:export[ \t]+|set[ \t]+)?[A-Z0-9_]{0,40}(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)[A-Z0-9_]{0,40}[ \t]{0,10}=[ \t]{0,10})(\S{1,1000})/gm
const AUTHORIZATION = /(\bAuthorization\s{0,10}:\s{0,10}(?:Bearer|Basic|Token)\s{1,10})[^\s"',;]{1,4000}/gi
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/:@]{1,256}:[^\s/@]{1,256}@/gi

export function redactText(text: string, truncate = true): string {
  // 先换整段的值，再按格式找剩下的：反过来的话，「[已脱敏：模型服务的 API Key]」会被赋值规则从空格处截断
  let result = redactPrivateKeys(text)
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

// 发给能操作的设备的权限请求：工具参数里同样可能有密钥
export function redactToolCall<T extends object>(toolCall: T): T {
  return walk(toolCall, false) as T
}

// 提问带的图片不发，记下有几张
// 重新生成之前的版本（第 676 步）不同步：远程只看当前这一次
export function redactTurn(turn: StoredTurn): StoredTurn & { omittedImages?: number } {
  const { images, versions: _versions, ...rest } = turn
  const redacted = walk(rest, false) as Omit<StoredTurn, 'images'>
  return { ...redacted, updates: withinSnapshotBudget(redacted.updates), images: [], ...(images.length > 0 ? { omittedImages: images.length } : {}) }
}

function withinSnapshotBudget(updates: SessionUpdate[]): SessionUpdate[] {
  let budget = TURN_SNAPSHOT_CHARS
  return updates.map((update) => {
    const diffra = update._meta?.diffra as Record<string, unknown> | undefined
    const snapshot = diffra?.[VISUAL_SNAPSHOT_META_KEY] as { data?: unknown } | undefined
    if (typeof snapshot?.data !== 'string') return update
    if (snapshot.data.length <= budget) {
      budget -= snapshot.data.length
      return update
    }
    return { ...update, _meta: { ...update._meta, diffra: { ...diffra, [VISUAL_SNAPSHOT_META_KEY]: { type: 'text', text: OMITTED_IMAGE } } } }
  })
}

function isVisualSnapshot(object: Record<string, unknown>): object is { type: 'image'; mimeType: string; data: string } {
  return (
    object.type === 'image' &&
    (VISUAL_SNAPSHOT_TYPES as readonly unknown[]).includes(object.mimeType) &&
    typeof object.data === 'string' &&
    object.data.length <= VISUAL_SNAPSHOT_MAX_CHARS &&
    BASE64.test(object.data)
  )
}

// 发出去的副本不带本机的目录结构：项目里的绝对路径换成相对项目的，用户目录换成 ~（不暴露 Windows 用户名）。
// 路径字段（改动块的 path、locations、工具参数里的路径）在项目外时只留文件名；普通文字（标题、输出、消息）里只换这两个前缀，
// 别的绝对路径只能尽力不管。改动卡片的 oldText、newText、base 不动：界面要按原文重放改动。在 redact* 之后做（保护文件按原路径认）
export interface PathRoots {
  project: string | null
  home: string | null
}

const PATH_KEYS = new Set(['path', 'file_path', 'filePath', 'cwd'])
const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/])/

interface Root {
  // 「根目录 + 分隔符」和「根目录本身（后面不再接路径字符）」
  nested: RegExp
  bare: RegExp
  replacement: string
}

function rootOf(path: string | null, replacement: string): Root | null {
  const trimmed = path?.replace(/[\\/]+$/, '')
  if (!trimmed) return null
  const pattern = trimmed
    .split(/[\\/]/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\\\/]')
  return { nested: new RegExp(`${pattern}[\\\\/]`, 'gi'), bare: new RegExp(`${pattern}(?![\\w.-])`, 'gi'), replacement }
}

export function hidePaths<T>(value: T, roots: PathRoots): T {
  // 项目在用户目录里时先换项目
  const list = [rootOf(roots.project, ''), rootOf(roots.home, '~')].filter((root): root is Root => root !== null)
  return hideIn(value, list) as T
}

function hideText(text: string, roots: Root[]): string {
  let result = text
  for (const root of roots) {
    result = result.replace(root.nested, root.replacement ? `${root.replacement}/` : '').replace(root.bare, root.replacement || '.')
  }
  return result
}

function hidePath(path: string, roots: Root[]): string {
  if (!ABSOLUTE.test(path)) return path
  const hidden = hideText(path, roots)
  if (hidden !== path) return hidden.replace(/\\/g, '/') || '.'
  return `…/${path.split(/[\\/]/).filter(Boolean).at(-1) ?? ''}`
}

function hideIn(value: unknown, roots: Root[], key?: string): unknown {
  // 快照的 base64 里可能碰巧有像路径的片段
  if (key === VISUAL_SNAPSHOT_META_KEY) return value
  if (typeof value === 'string') {
    if (key && DIFF_TEXT_KEYS.has(key)) return value
    return key && PATH_KEYS.has(key) ? hidePath(value, roots) : hideText(value, roots)
  }
  if (Array.isArray(value)) return value.map((item) => hideIn(item, roots))
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, hideIn(item, roots, name)]))
}

// 任务改动的差异（git diff-tree -p，每个文件以 diff --git 开头）：可能含密钥的文件只留文件头和一行说明（界面照常能解析），
// 其余按文字脱敏、不截单段；整份超过上限时截在文件边界，末尾说一句
const DIFF_TRUNCATED = 'diff --git a/（太长，后面的文件没有同步） b/（太长，后面的文件没有同步）\n'

export function redactDiff(diff: string): string {
  let result = ''
  for (const section of diff.split(/(?=^diff --git )/m)) {
    const path = /^diff --git a\/(.+?) b\//.exec(section)?.[1]
    const text = path && isProtectedFile(path) ? `${section.split('\n', 1)[0]}\n@@ -0,0 +1 @@\n+${OMITTED_FILE}\n` : redactText(section, false)
    if (result.length + text.length > MAX_DIFF_CHARS) return result + DIFF_TRUNCATED
    result += text
  }
  return result
}

// 快照里读取、执行、搜索这几类工具的文字输出只留开头（界面默认折叠，展开时连接端再要全文），在脱敏之后做，记的是脱敏后的长度。
// 改动块不截（界面要按顺序重放改动），完成、计划、审查这类默认展开的卡片原样发
const PREVIEW_KINDS = new Set(['read', 'execute', 'search'])

export function previewTurn<T extends StoredTurn>(turn: T): T {
  // 种类只在 tool_call 上，之后的 tool_call_update 不一定带
  const kinds = new Map<string, string>()
  const updates = turn.updates.map((update) => {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return update
    if (update.kind) kinds.set(update.toolCallId, update.kind)
    const kind = kinds.get(update.toolCallId)
    if (!kind || !PREVIEW_KINDS.has(kind) || !update.content) return update
    return { ...update, content: update.content.map(previewContent) }
  })
  return { ...turn, updates }
}

function previewContent(content: ToolCallContent): ToolCallContent {
  if (content.type !== 'content' || content.content.type !== 'text' || content.content.text.length <= TOOL_PREVIEW_CHARS) return content
  const { text } = content.content
  return { ...content, content: { ...content.content, text: text.slice(0, TOOL_PREVIEW_CHARS), _meta: { ...content.content._meta, [TOOL_PREVIEW_META_KEY]: text.length } } }
}

function walk(value: unknown, omit: boolean, key?: string): unknown {
  if (typeof value === 'string') {
    if (omit && key !== 'type' && key !== 'path') return OMITTED_FILE
    return redactText(value, !(key && DIFF_TEXT_KEYS.has(key)))
  }
  if (Array.isArray(value)) return value.map((item) => walk(item, omit))
  if (typeof value !== 'object' || value === null) return value
  const object = value as Record<string, unknown>
  if (key === VISUAL_SNAPSHOT_META_KEY) return isVisualSnapshot(object) ? { type: 'image', mimeType: object.mimeType, data: object.data } : { type: 'text', text: OMITTED_IMAGE }
  if (object.type === 'image' && typeof object.data === 'string') return { type: 'text', text: OMITTED_IMAGE }
  if (key === VISUAL_META_KEY && typeof object.code === 'string') return { ...object, title: typeof object.title === 'string' ? redactText(object.title) : object.title, code: OMITTED_VISUAL }
  const protectedPath = typeof object.path === 'string' && isProtectedFile(object.path)
  return Object.fromEntries(Object.entries(object).map(([name, item]) => [name, walk(item, omit || protectedPath, name)]))
}

// 换成「[已脱敏：私钥]」，保留原来的行数
function redactPrivateKeys(text: string): string {
  let result = ''
  let copied = 0
  // 下一个 END；undefined 是还没找，null 是后面再也没有
  let end: RegExpExecArray | null | undefined
  PRIVATE_KEY_BEGIN.lastIndex = 0
  for (let begin = PRIVATE_KEY_BEGIN.exec(text); begin; begin = PRIVATE_KEY_BEGIN.exec(text)) {
    const bodyStart = begin.index + begin[0].length
    if (end === undefined || (end !== null && end.index < bodyStart)) {
      PRIVATE_KEY_END.lastIndex = bodyStart
      end = PRIVATE_KEY_END.exec(text)
    }
    if (end === null) break
    if (end.index - bodyStart > MAX_PRIVATE_KEY_BODY) continue
    const blockEnd = end.index + end[0].length
    result += `${text.slice(copied, begin.index)}[已脱敏：私钥]${'\n'.repeat(text.slice(begin.index, blockEnd).split('\n').length - 1)}`
    copied = blockEnd
    PRIVATE_KEY_BEGIN.lastIndex = blockEnd
    end = undefined
  }
  return result + text.slice(copied)
}
