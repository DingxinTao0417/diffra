import { hasAnsi, stripAnsi } from './ansi'

// 第 655 步：从命令和它的输出里认出测试结果、搜索结果、读文件，换成对应的视图。只认常见格式，认不出就照原样显示输出

// core 给界面的命令输出第一行是状态（tools/exec.ts 的 terminalOutput）：Exit code: N、运行中（会话 x）、已停止
export interface CommandOutput {
  exitCode: number | null
  state: 'exited' | 'running' | 'stopped' | null
  body: string
}

export function splitCommandOutput(text: string): CommandOutput {
  const newline = text.indexOf('\n')
  const head = newline < 0 ? text : text.slice(0, newline)
  const body = newline < 0 ? '' : text.slice(newline + 1)
  const exit = /^Exit code: (-?\d+)$/.exec(head)
  if (exit) return { exitCode: Number(exit[1]), state: 'exited', body: body === '(no output)' ? '' : body }
  if (/^运行中（会话 /.test(head)) return { exitCode: null, state: 'running', body }
  if (head === '已停止') return { exitCode: null, state: 'stopped', body }
  return { exitCode: null, state: null, body: text }
}

// ---- 测试结果 ----

export interface TestSummary {
  runner: string
  passed: number
  failed: number
  skipped: number
  // 秒
  duration: number | null
  // 失败的用例名（去重，最多 50 个）
  failures: string[]
}

const MAX_FAILURES = 50

const seconds = (value: string | undefined, unit: string | undefined) => (value === undefined ? null : Number(value) / (unit === 'ms' ? 1000 : 1))

export function parseTestSummary(output: string): TestSummary | null {
  const text = stripAnsi(output)
  const lines = text.split('\n')
  const count = (pattern: RegExp) => {
    const match = pattern.exec(text)
    return match ? Number(match[1]) : 0
  }
  let summary: Omit<TestSummary, 'failures'> | null = null
  // vitest：Tests  2 failed | 8 passed | 1 skipped (11)；Duration  1.20s
  const vitest = /^\s*Tests\s+((?:\d+ \w+(?: \| )?)+)\s*\(\d+\)/m.exec(text)
  // jest：Tests:       1 failed, 1 skipped, 10 passed, 12 total；Time:        1.234 s
  const jest = /^Tests:\s+(.+ total)$/m.exec(text)
  // pytest：===== 2 failed, 10 passed, 1 skipped in 0.52s =====
  const pytest = /^=+ (.*\b(?:passed|failed|error)\b.*) in ([\d.]+)s/m.exec(text)
  // cargo：test result: FAILED. 3 passed; 1 failed; 0 ignored; ... finished in 0.01s
  const cargo = /^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored.*finished in ([\d.]+)s/m.exec(text)
  // node --test：# pass 10 / # fail 1 / # skipped 0 / # duration_ms 123
  const nodeTest = /^# pass \d+$/m.test(text) && /^# fail \d+$/m.test(text)
  // playwright：  3 passed (8.1s) / 1 failed / 2 skipped
  const playwright = /^\s+\d+ (?:passed|failed) \(([\d.]+)(m?s)\)\s*$/m.exec(text)
  // go test：ok  pkg 0.01s / FAIL pkg 0.02s / --- PASS / --- FAIL
  const go = /^(?:ok|FAIL)\s+\S+\s+[\d.]+s/m.test(text) || /^--- (?:PASS|FAIL): /m.test(text)
  if (vitest) {
    const parts = vitest[1]!
    const pick = (word: string) => Number(new RegExp(`(\\d+) ${word}`).exec(parts)?.[1] ?? 0)
    const duration = /^\s*Duration\s+([\d.]+)(m?s)/m.exec(text)
    summary = { runner: 'vitest', passed: pick('passed'), failed: pick('failed'), skipped: pick('skipped') + pick('todo'), duration: seconds(duration?.[1], duration?.[2]) }
  } else if (jest) {
    const parts = jest[1]!
    const pick = (word: string) => Number(new RegExp(`(\\d+) ${word}`).exec(parts)?.[1] ?? 0)
    const time = /^Time:\s+([\d.]+)\s*(m?s)/m.exec(text)
    summary = { runner: 'jest', passed: pick('passed'), failed: pick('failed'), skipped: pick('skipped') + pick('todo'), duration: seconds(time?.[1], time?.[2]) }
  } else if (pytest) {
    const parts = pytest[1]!
    const pick = (word: string) => Number(new RegExp(`(\\d+) ${word}`).exec(parts)?.[1] ?? 0)
    summary = { runner: 'pytest', passed: pick('passed'), failed: pick('failed') + pick('errors?'), skipped: pick('skipped'), duration: Number(pytest[2]) }
  } else if (cargo) {
    summary = { runner: 'cargo', passed: Number(cargo[1]), failed: Number(cargo[2]), skipped: Number(cargo[3]), duration: Number(cargo[4]) }
  } else if (nodeTest) {
    const duration = /^# duration_ms ([\d.]+)$/m.exec(text)
    summary = { runner: 'node', passed: count(/^# pass (\d+)$/m), failed: count(/^# fail (\d+)$/m), skipped: count(/^# skipped (\d+)$/m) + count(/^# todo (\d+)$/m), duration: seconds(duration?.[1], 'ms') }
  } else if (playwright) {
    summary = { runner: 'playwright', passed: count(/^\s+(\d+) passed/m), failed: count(/^\s+(\d+) failed/m), skipped: count(/^\s+(\d+) skipped/m), duration: seconds(playwright[1], playwright[2]) }
  } else if (go) {
    summary = { runner: 'go', passed: lines.filter((line) => /^\s*--- PASS: /.test(line)).length, failed: lines.filter((line) => /^\s*--- FAIL: /.test(line)).length, skipped: lines.filter((line) => /^\s*--- SKIP: /.test(line)).length, duration: null }
    if (summary.passed + summary.failed === 0) summary = { ...summary, passed: lines.filter((line) => /^ok\s/.test(line)).length, failed: lines.filter((line) => /^FAIL\s+\S+\s+[\d.]+s/.test(line)).length }
  }
  if (!summary || summary.passed + summary.failed + summary.skipped === 0) return null
  return { ...summary, failures: failuresOf(lines, summary.runner) }
}

const FAILURE_PATTERNS: Record<string, RegExp[]> = {
  vitest: [/^\s*FAIL\s+(\S+\s+>\s+.+?)\s*$/, /^\s*[×✗]\s+(.+?)(?:\s+\d+ms)?$/],
  jest: [/^\s*● (.+? › .+?)$/],
  pytest: [/^(?:FAILED|ERROR) (\S+?)(?: - .*)?$/],
  cargo: [/^test (\S+) \.\.\. FAILED$/],
  node: [/^not ok \d+ - (.+)$/],
  playwright: [/^\s+\d+\) (\[.+?\] › .+?)\s*$/],
  go: [/^\s*--- FAIL: (\S+)/],
}

function failuresOf(lines: string[], runner: string): string[] {
  const patterns = FAILURE_PATTERNS[runner] ?? []
  const found = new Set<string>()
  for (const line of lines) {
    for (const pattern of patterns) {
      const match = pattern.exec(line)
      if (match?.[1]) found.add(match[1].trim())
    }
    if (found.size >= MAX_FAILURES) break
  }
  return [...found]
}

// ---- 搜索结果 ----

export interface SearchHit {
  line: number
  text: string
}

export interface SearchResults {
  pattern: string | null
  files: Array<{ path: string; hits: SearchHit[] }>
  total: number
}

// rg -n / grep -rn 的输出：路径:行号:内容（rg --column 多一段列号）。至少一半的行认得出才算
export function parseSearch(command: string, output: string): SearchResults | null {
  if (!/^(?:rg|grep|git grep)\b/.test(command.trim())) return null
  const lines = stripAnsi(output).split('\n').filter((line) => line.trim() !== '')
  if (lines.length === 0) return null
  const files = new Map<string, SearchHit[]>()
  let matched = 0
  for (const line of lines) {
    const match = /^((?:[A-Za-z]:)?[^:\n]+?):(\d+):(?:\d+:)?(.*)$/.exec(line)
    if (!match) continue
    matched += 1
    const path = match[1]!.replace(/\\/g, '/')
    files.set(path, [...(files.get(path) ?? []), { line: Number(match[2]), text: match[3]! }])
  }
  if (matched === 0 || matched < lines.length / 2) return null
  return { pattern: searchPattern(command), files: [...files].map(([path, hits]) => ({ path, hits })), total: matched }
}

// 命令里搜的是什么：第一个不是选项的参数（rg -n "foo" src → foo）
function searchPattern(command: string): string | null {
  const tokens = (command.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) ?? []).slice(command.trim().startsWith('git ') ? 2 : 1)
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    // -e 后面就是要搜的；这几个选项后面跟的是参数值，不是要搜的
    if (token === '-e' || token === '--regexp') return unquote(tokens[index + 1] ?? '') || null
    if (/^(?:-[gtTmABC]|--glob|--type|--max-count)$/.test(token)) {
      index += 1
      continue
    }
    if (!token.startsWith('-')) return unquote(token)
  }
  return null
}

// ---- 读文件 ----

export interface FileRead {
  path: string
  startLine: number
  text: string
}

// cat a.ts、sed -n '10,40p' a.ts、head -n 50 a.ts、nl -ba a.ts | sed -n '10,40p'：输出就是文件内容
export function parseRead(command: string, output: string): FileRead | null {
  // 带颜色码的是日志、终端输出，不是源码：交给终端视图显示颜色
  if (hasAnsi(output)) return null
  const trimmed = command.trim()
  if (/[;&|<>]/.test(trimmed.replace(/^nl -ba (\S+) \| sed -n '\d+,\d+p'$/, 'nl'))) return null
  let match = /^cat (\S+)$/.exec(trimmed)
  if (match) return { path: unquote(match[1]!), startLine: 1, text: output }
  match = /^sed -n ['"]?(\d+),(\d+)p['"]? (\S+)$/.exec(trimmed)
  if (match) return { path: unquote(match[3]!), startLine: Number(match[1]), text: output }
  match = /^head(?: -n ?\d+| -\d+)? (\S+)$/.exec(trimmed)
  if (match) return { path: unquote(match[1]!), startLine: 1, text: output }
  match = /^nl -ba (\S+)(?: \| sed -n '(\d+),\d+p')?$/.exec(trimmed)
  if (match) {
    // nl 的输出每行前面是右对齐的行号和制表符：去掉
    const stripped = output.split('\n').map((line) => line.replace(/^\s*\d+\t/, ''))
    return { path: unquote(match[1]!), startLine: Number(match[2] ?? 1), text: stripped.join('\n') }
  }
  return null
}

const unquote = (value: string) => value.replace(/^["']|["']$/g, '')
