import { stripAnsi } from './ansi'

// 第 657 步：再认几种命令的输出——git、构建产物体积、HTTP 响应、数据库查询结果、带级别的日志。只认常见格式，认不出就照原样

const program = (command: string) => command.trim().replace(/^(?:cd \S+ && )+/, '')

// ---- git ----

export type GitFileGroup = 'staged' | 'unstaged' | 'untracked' | 'conflict'

export interface GitStatus {
  branch: string | null
  // 和上游比：领先、落后几个提交
  ahead: number
  behind: number
  files: Array<{ path: string; change: string; group: GitFileGroup }>
}

const STATUS_GROUPS: Array<[RegExp, GitFileGroup]> = [
  [/^Changes to be committed:/, 'staged'],
  [/^Changes not staged for commit:/, 'unstaged'],
  [/^Untracked files:/, 'untracked'],
  [/^Unmerged paths:/, 'conflict'],
]

const SHORT_CODES: Record<string, string> = { M: '修改', A: '新增', D: '删除', R: '改名', C: '复制', U: '冲突', '?': '未跟踪', T: '类型' }

export function parseGitStatus(command: string, output: string): GitStatus | null {
  if (!/^git status\b/.test(program(command))) return null
  const text = stripAnsi(output)
  const lines = text.split('\n')
  const branch = /^On branch (\S+)/m.exec(text)?.[1] ?? /^## ([^.\s]+)/m.exec(text)?.[1] ?? null
  const ahead = Number(/ahead (?:of '[^']+' by )?(\d+)/.exec(text)?.[1] ?? 0)
  const behind = Number(/behind (?:'[^']+' by )?(\d+)/.exec(text)?.[1] ?? 0)
  const files: GitStatus['files'] = []
  let group: GitFileGroup | null = null
  for (const line of lines) {
    const header = STATUS_GROUPS.find(([pattern]) => pattern.test(line))
    if (header) {
      group = header[1]
      continue
    }
    // 长格式：「\tmodified:   src/a.ts」，未跟踪的只有路径
    const long = /^\t(?:(new file|modified|deleted|renamed|both modified|both added|deleted by us|deleted by them|added by us|added by them|typechange):\s+)?(.+)$/.exec(line)
    if (long && group) {
      files.push({ path: long[2]!.trim(), change: long[1] ? changeName(long[1]) : '未跟踪', group })
      continue
    }
    // 短格式：「XY path」
    const short = /^([ MADRCU?!T])([ MADRCU?!T]) (.+)$/.exec(line)
    if (short && !line.startsWith('##')) {
      const [, x = ' ', y = ' ', path = ''] = short
      const conflict = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')
      const target = conflict ? 'conflict' : x === '?' ? 'untracked' : x !== ' ' ? 'staged' : 'unstaged'
      files.push({ path: path.replace(/^.* -> /, ''), change: SHORT_CODES[conflict ? 'U' : x !== ' ' && x !== '?' ? x : y] ?? '修改', group: target })
    }
  }
  if (!branch && files.length === 0) return null
  return { branch, ahead, behind, files }
}

function changeName(change: string): string {
  if (change === 'new file') return '新增'
  if (change === 'modified') return '修改'
  if (change === 'deleted') return '删除'
  if (change === 'renamed') return '改名'
  if (change === 'typechange') return '类型'
  return '冲突'
}

export interface GitCommit {
  hash: string
  refs: string[]
  message: string
}

// git log --oneline（可以带 --decorate、-n）
export function parseGitLog(command: string, output: string): GitCommit[] | null {
  if (!/^git log\b/.test(program(command)) || !/--oneline|--pretty=oneline|--format=oneline/.test(command)) return null
  const commits = stripAnsi(output)
    .split('\n')
    .filter(Boolean)
    .map((line) => /^([0-9a-f]{7,40})(?: \(([^)]*)\))? (.*)$/.exec(line))
  if (commits.length === 0 || commits.some((match) => !match)) return null
  return commits.map((match) => ({ hash: match![1]!, refs: match![2] ? match![2].split(', ') : [], message: match![3]! }))
}

export interface GitPush {
  remote: string | null
  updates: Array<{ from: string; to: string; range: string | null; rejected: boolean; reason: string | null; forced: boolean }>
  upToDate: boolean
}

// git push：「To github.com:x/y.git」，下面每行一个分支的结果；被拒的行以 ! 开头
export function parseGitPush(command: string, output: string): GitPush | null {
  if (!/^git push\b/.test(program(command))) return null
  const text = stripAnsi(output)
  const remote = /^To (\S+)/m.exec(text)?.[1] ?? null
  const updates: GitPush['updates'] = []
  for (const line of text.split('\n')) {
    const match = /^ ([ +\-*=!])\s*(\[[^\]]+\]|\S+\.\.\.?\S+)?\s*(\S+) -> (\S+)(?: \((.+)\))?/.exec(line)
    if (!match) continue
    const [, flag = ' ', range, from = '', to = '', reason] = match
    updates.push({ from, to, range: range && !range.startsWith('[') ? range : null, rejected: flag === '!', reason: reason ?? (range?.startsWith('[') ? range.slice(1, -1) : null), forced: flag === '+' })
  }
  const upToDate = /Everything up-to-date/.test(text)
  if (!remote && updates.length === 0 && !upToDate) return null
  return { remote, updates, upToDate }
}

// git diff / git show：内容就是 diff，交给改动视图
export function isGitDiff(command: string, output: string): boolean {
  return /^git (?:diff|show)\b/.test(program(command)) && /^diff --git /m.test(stripAnsi(output))
}

// ---- 构建产物体积 ----

export interface BuildAsset {
  path: string
  // 字节
  size: number
  gzip: number | null
}

const UNITS: Record<string, number> = { b: 1, kb: 1000, kib: 1024, mb: 1000 ** 2, mib: 1024 ** 2, gb: 1000 ** 3 }
const bytesOf = (value: string, unit: string) => Math.round(Number(value.replace(/,/g, '')) * (UNITS[unit.toLowerCase()] ?? 1))

// vite：「dist/assets/index-abc.js   123.45 kB │ gzip: 40.12 kB」；webpack 5：「asset main.js 120 KiB [emitted]」。至少认出三个文件才算
export function parseBuildAssets(output: string): BuildAsset[] | null {
  const assets: BuildAsset[] = []
  for (const line of stripAnsi(output).split('\n')) {
    const vite = /^\s*(\S+\.\w+)\s+([\d,.]+) (k?B|MB|GB)(?:\s*[│|]\s*gzip:\s*([\d,.]+) (k?B|MB))?/i.exec(line)
    if (vite) {
      assets.push({ path: vite[1]!, size: bytesOf(vite[2]!, vite[3]!), gzip: vite[4] ? bytesOf(vite[4], vite[5]!) : null })
      continue
    }
    const webpack = /^\s*asset (\S+) ([\d.]+) (bytes|KiB|MiB|kB|MB)\b/.exec(line)
    if (webpack) assets.push({ path: webpack[1]!, size: bytesOf(webpack[2]!, webpack[3] === 'bytes' ? 'b' : webpack[3]!), gzip: null })
  }
  return assets.length >= 3 ? assets : null
}

// ---- HTTP ----

export interface HttpResponse {
  method: string
  url: string | null
  status: number
  statusText: string
  headers: Array<[string, string]>
  body: string
}

// curl -i（或 -I、-v 里的响应头）：「HTTP/1.1 200 OK」开头，空行之后是正文；跟随重定向时取最后一段
export function parseHttp(command: string, output: string): HttpResponse | null {
  const trimmed = program(command)
  if (!/^curl\b/.test(trimmed)) return null
  const text = stripAnsi(output).replace(/\r\n/g, '\n')
  const starts = [...text.matchAll(/^(?:< )?HTTP\/[\d.]+ (\d{3})(?: ([^\n]*))?$/gm)]
  const last = starts.at(-1)
  if (!last) return null
  const rest = text.slice(last.index + last[0].length + 1)
  const blank = rest.search(/^(?:< )?$/m)
  const headerText = blank < 0 ? rest : rest.slice(0, blank)
  const headers = headerText
    .split('\n')
    .map((line) => /^(?:< )?([\w-]+):\s*(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match): [string, string] => [match[1]!, match[2]!])
  const body = blank < 0 ? '' : rest.slice(blank).replace(/^(?:< )?\n/, '')
  const method = /(?:-X|--request)\s+["']?(\w+)/.exec(trimmed)?.[1]?.toUpperCase() ?? (/\s(?:-d|--data(?:-raw|-binary)?|-F|--form)\s/.test(trimmed) ? 'POST' : /\s-I\b|--head\b/.test(trimmed) ? 'HEAD' : 'GET')
  const url = /(https?:\/\/[^\s"']+)/.exec(trimmed)?.[1] ?? null
  return { method, url, status: Number(last[1]), statusText: last[2]?.trim() ?? '', headers, body: body.replace(/^\* .*$\n?/gm, '') }
}

// ---- 数据库查询结果 ----

export interface QueryTable {
  columns: string[]
  rows: string[][]
  // 「(3 rows)」「3 rows in set」
  summary: string | null
  sql: string | null
}

// psql 的对齐格式（表头、----+----、(N rows)）和 mysql 的方框格式（+----+、| a | b |）
export function parseQueryTable(command: string, output: string): QueryTable | null {
  const trimmed = program(command)
  if (!/^(?:psql|mysql|mariadb|sqlite3|duckdb|clickhouse-client)\b/.test(trimmed)) return null
  const sql = /\s(?:-c|-e|--command|--execute)\s+(["'])([\s\S]+?)\1/.exec(trimmed)?.[2] ?? /\s(["'])((?:select|with|show|explain|insert|update|delete)\b[\s\S]*?)\1\s*$/i.exec(trimmed)?.[2] ?? null
  const lines = stripAnsi(output).split('\n')
  const cells = (line: string) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim())
  // mysql：边框行 +---+---+
  const border = lines.findIndex((line) => /^\+[-+]+\+$/.test(line.trim()))
  if (border >= 0 && lines[border + 1]?.trim().startsWith('|')) {
    const columns = cells(lines[border + 1]!)
    const rows = lines.slice(border + 3).filter((line) => line.trim().startsWith('|')).map(cells)
    const summary = lines.find((line) => /\brows? in set\b|Empty set/.test(line))?.trim() ?? null
    return { columns, rows, summary, sql }
  }
  // psql：第二行是 ----+----
  const divider = lines.findIndex((line) => /^-+(?:\+-+)*$/.test(line.trim()) && line.includes('-'))
  if (divider > 0) {
    const columns = cells(lines[divider - 1]!)
    const rows: string[][] = []
    for (const line of lines.slice(divider + 1)) {
      if (/^\(\d+ rows?\)$/.test(line.trim()) || line.trim() === '') break
      rows.push(cells(line))
    }
    const summary = lines.find((line) => /^\(\d+ rows?\)$/.test(line.trim()))?.trim() ?? null
    if (columns.length > 0 && rows.every((row) => row.length === columns.length)) return { columns, rows, summary, sql }
  }
  return null
}

// ---- 日志 ----

const LEVEL_WORD = /\b(?:ERROR|ERR|FATAL|WARN(?:ING)?|INFO|DEBUG|TRACE)\b|\[(?:error|warn(?:ing)?|info|debug)\]/i

// 至少 3 行、三成以上的行带级别：按日志看（能按级别筛选、搜索、跳到源码）
export function looksLikeLog(output: string): boolean {
  const lines = stripAnsi(output).split('\n').filter((line) => line.trim() !== '')
  if (lines.length < 3) return false
  return lines.filter((line) => LEVEL_WORD.test(line)).length / lines.length >= 0.3
}
