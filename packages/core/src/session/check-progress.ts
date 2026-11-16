// 检查失败后和上一次失败比较：上次的错误至少修好一条、或者认出的错误以外的输出变了，就算有进展；
// 新冒出来的错误不影响判断，跨文件改动常常修一处、牵出一处
export const MAX_CHECKS_WITHOUT_PROGRESS = 3
// 每轮完成检查失败的总上限，防止在不同错误之间来回打转
export const MAX_CHECK_FAILURES_PER_TURN = 12

export interface CheckError {
  // 文件加错误内容，去掉了行号列号，和上次比较用；pytest 只用用例 id
  key: string
  // 去掉颜色码和项目根路径的原文，带行号，给人和模型看
  text: string
}

export interface ParsedCheck {
  // 一条错误都没认出（包括只有警告）时为 null
  errors: CheckError[] | null
  // 没认出的行规范化后的指纹；认出的错误行、警告行不算在里面
  fingerprint: string
  // 没认出的行，去掉了颜色码和项目根路径
  unrecognized: string[]
}

// 认不出格式（任一次）时 resolved、added、remaining 为 null；remaining 是上次的错误里这次还在的
export interface CheckComparison {
  progress: boolean
  resolved: string[] | null
  added: string[] | null
  remaining: string[] | null
}

export interface CheckTracker {
  last: ParsedCheck | null
  // 连续没有进展的失败次数；第一次失败没有可比的，也算一次
  stalled: number
}

export type CheckExhaustion = 'stalled' | 'limit'

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
const DURATION = /\b\d+(?:\.\d+)?\s?(?:ms|s)\b/g
// vitest 的汇总行带各阶段耗时占比和开始时间，每次都不一样
const PERCENT = /\b\d+(?:\.\d+)?%/g
const CLOCK = /\b\d{1,2}:\d{2}:\d{2}\b/g
// pnpm -r 给每行加「包目录 脚本名: 」；第一段不带冒号、带字母数字，免得剥掉 go 的「文件:行:列:」和「--- FAIL:」
const PNPM_PREFIX = /^(?!Exit code: )[^\s:]*\w[^\s:]* [^\s:]+: /
// 认不出格式时给人看的末尾几行不要这些头部：runShell 的退出码、pnpm -r 的范围和脚本行、npm 脚本头
const HEADER = /^(?:Exit code: |Scope: |> |\S+ \S+\$ )/
const TSC = /([^\s()]+)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/
const TSC_PRETTY = /([^\s]+):(\d+):(\d+) - (error|warning) (TS\d+): (.*)$/
const PYTEST = /^(?:FAILED|ERROR) ([^\s[]+(?:\[[^\]]*\])?)(?: - .*)?$/
const RUST_DIAGNOSTIC = /^(error|warning)(?:\[\w+\])?: .*$/
const RUST_LOCATION = /^\s*--> (.+?):(\d+):(\d+)/
const ESLINT_FILE = /^(?:[A-Za-z]:)?[^\s:]+\.\w+$/
const ESLINT_ITEM = /^\s+\d+:\d+\s+((error|warning)\s+.*)$/
const GO_FAIL = /^\s*--- FAIL: (\S+)/
const VITEST_FAIL = /^\s*FAIL\s+(\S+\.\w+)\s+>\s+(.+)$/
// node --test 的失败用例：「✖ 用例名 (耗时)」；「✖ failing tests:」是汇总的标题，eslint 的「✖ 3 problems」是总数，都不算一条错误
const NODE_TEST_FAIL = /^\s*✖\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s?m?s\))?\s*$/
const NOT_NODE_TEST = /^(?:failing tests:|\d+ problems?\b)/
// node --test 的汇总行「ℹ duration_ms 49.87」不带单位，每次都不一样
const NODE_TEST_DURATION = /\bduration_ms:?\s*\d+(?:\.\d+)?/g
const LOCATED = /^\s*((?:[A-Za-z]:)?[^\s:]+\.\w+):\d+(?::\d+)?:?\s+(.+)$/
const WARNING = /^warning\b/i

export function parseCheckErrors(output: string, root?: string): ParsedCheck {
  let text = output.replace(ANSI, '').replace(/\r\n?/g, '\n')
  if (root) text = stripRoot(text, root)
  const lines = text.split('\n')
  const errors: CheckError[] = []
  // 认出的行（错误和警告），不进 fingerprint
  const recognized = new Set<number>()
  const add = (file: string, message: string, original: string) =>
    errors.push({ key: `${normalizePath(file)}: ${normalizeMessage(message)}`, text: original.trim() })
  let eslintFile: { path: string; index: number } | null = null
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.replace(PNPM_PREFIX, '')
    const tsc = TSC.exec(line) ?? TSC_PRETTY.exec(line)
    if (tsc) {
      recognized.add(index)
      if (tsc[4] === 'error') add(tsc[1]!, `${tsc[4]} ${tsc[5]}: ${tsc[6]}`, line.slice(tsc.index))
      continue
    }
    const pytest = PYTEST.exec(line)
    if (pytest) {
      recognized.add(index)
      errors.push({ key: normalizePath(pytest[1]!), text: line.trim() })
      continue
    }
    const rust = RUST_DIAGNOSTIC.exec(line)
    const rustAt = rust ? RUST_LOCATION.exec((lines[index + 1] ?? '').replace(PNPM_PREFIX, '')) : null
    if (rust && rustAt) {
      recognized.add(index).add(index + 1)
      if (rust[1] === 'error') add(rustAt[1]!, line, `${rustAt[1]}:${rustAt[2]}:${rustAt[3]}: ${line}`)
      index++
      continue
    }
    const eslint = eslintFile ? ESLINT_ITEM.exec(line) : null
    if (eslintFile && eslint) {
      recognized.add(eslintFile.index).add(index)
      if (eslint[2] === 'error') add(eslintFile.path, eslint[1]!, `${eslintFile.path}: ${line.trim()}`)
      continue
    }
    const goFail = GO_FAIL.exec(line)
    if (goFail) {
      recognized.add(index)
      errors.push({ key: `FAIL ${goFail[1]}`, text: line.trim() })
      continue
    }
    const vitest = VITEST_FAIL.exec(line)
    if (vitest) {
      recognized.add(index)
      add(vitest[1]!, vitest[2]!, line)
      continue
    }
    const nodeTest = NODE_TEST_FAIL.exec(line)
    if (nodeTest && !NOT_NODE_TEST.test(nodeTest[1]!)) {
      recognized.add(index)
      errors.push({ key: `✖ ${normalizeMessage(nodeTest[1]!)}`, text: line.trim() })
      continue
    }
    const located = LOCATED.exec(line)
    if (located) {
      recognized.add(index)
      if (!WARNING.test(located[2]!)) add(located[1]!, located[2]!, line)
      continue
    }
    if (line.trim() && !/^\s/.test(line)) eslintFile = ESLINT_FILE.test(line.trim()) ? { path: line.trim(), index } : null
  }
  const unrecognized = lines.flatMap((line, index) => (recognized.has(index) || !line.trim() ? [] : [line.trim()]))
  return { errors: errors.length > 0 ? errors : null, fingerprint: fingerprintOf(unrecognized.join('\n')), unrecognized }
}

// 认出的错误按条比，其余输出按 fingerprint 整体比；任一次没认出错误时，修好、新增、剩余几条说不清，给 null
export function compareCheckErrors(previous: ParsedCheck, next: ParsedCheck): CheckComparison {
  const before = countKeys(previous.errors ?? [])
  const after = countKeys(next.errors ?? [])
  const resolved: string[] = []
  const added: string[] = []
  const remaining: string[] = []
  for (const [key, count] of before) {
    const still = Math.min(count, after.get(key) ?? 0)
    for (let index = 0; index < count - still; index++) resolved.push(key)
    for (let index = 0; index < still; index++) remaining.push(key)
  }
  for (const [key, count] of after) {
    for (let index = 0; index < count - (before.get(key) ?? 0); index++) added.push(key)
  }
  const progress = resolved.length > 0 || previous.fingerprint !== next.fingerprint
  if (!previous.errors || !next.errors) return { progress, resolved: null, added: null, remaining: null }
  return { progress, resolved, added, remaining }
}

// 这次失败的都是 known 里就有的：认出了错误时按条比，只要没有 known 里没有的错误（修好几条也算）；
// 两次都没认出错误时按其余输出整体比；一次认出一次没认出，说不清，按有新问题算
export function onlyKnownErrors(known: ParsedCheck, next: ParsedCheck): boolean {
  if (known.errors && next.errors) {
    const keys = new Set(known.errors.map((error) => error.key))
    return next.errors.every((error) => keys.has(error.key))
  }
  return !known.errors && !next.errors && known.fingerprint === next.fingerprint
}

export function newCheckTracker(): CheckTracker {
  return { last: null, stalled: 0 }
}

// 记一次失败，返回和上一次失败的比较；第一次失败没有上一次，返回 null
export function recordCheckFailure(tracker: CheckTracker, parsed: ParsedCheck): CheckComparison | null {
  const comparison = tracker.last ? compareCheckErrors(tracker.last, parsed) : null
  tracker.last = parsed
  tracker.stalled = comparison?.progress ? 0 : tracker.stalled + 1
  return comparison
}

// 通过时连续计数清零；这一轮的失败总数由调用方计，不清
export function recordCheckPass(tracker: CheckTracker): void {
  tracker.last = null
  tracker.stalled = 0
}

export function checkExhaustion(tracker: CheckTracker, failuresThisTurn: number): CheckExhaustion | null {
  if (tracker.stalled >= MAX_CHECKS_WITHOUT_PROGRESS) return 'stalled'
  if (failuresThisTurn >= MAX_CHECK_FAILURES_PER_TURN) return 'limit'
  return null
}

export function progressSummary(parsed: ParsedCheck, comparison: CheckComparison | null): string {
  if (!comparison) return parsed.errors ? `The check reported ${plural(parsed.errors.length, 'error')}.` : ''
  if (comparison.resolved && comparison.remaining && comparison.added) {
    const before = comparison.resolved.length + comparison.remaining.length
    return `Since the last check: ${comparison.resolved.length} of ${plural(before, 'error')} fixed, ${comparison.added.length} new, ${parsed.errors?.length ?? 0} remaining.`
  }
  return comparison.progress ? 'The output changed since the last check.' : 'The output is the same as after the last check: nothing was fixed.'
}

// 停下时给人看、下一轮交给模型的剩余错误；认不出格式时取没认出的输出末尾几行，失败信息一般在最后
export function remainingLines(parsed: ParsedCheck, limit: number): string[] {
  if (parsed.errors) return parsed.errors.slice(0, limit).map((error) => error.text)
  return parsed.unrecognized.filter((line) => !HEADER.test(line)).slice(-limit)
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function countKeys(errors: CheckError[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const error of errors) counts.set(error.key, (counts.get(error.key) ?? 0) + 1)
  return counts
}

// 检查在项目目录里跑，输出里的绝对路径去掉项目根；Git Bash 下也可能是 /d/... 的写法
function stripRoot(text: string, root: string): string {
  const forward = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const variants = new Set([forward, forward.replace(/\//g, '\\'), forward.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`)])
  for (const variant of variants) text = text.replace(new RegExp(`${variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\\\/]`, 'gi'), '')
  return text
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

function normalizeMessage(message: string): string {
  return message.replace(DURATION, '').replace(/\s+/g, ' ').trim()
}

function fingerprintOf(text: string): string {
  return text
    .replace(NODE_TEST_DURATION, '')
    .replace(DURATION, '')
    .replace(PERCENT, '')
    .replace(CLOCK, '')
    .replace(/^\s*\d+:\d+(?=\s)/gm, '')
    .replace(/\(\d+,\d+\)/g, '')
    .replace(/:\d+(?::\d+)?\b/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}
