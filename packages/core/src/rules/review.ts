import { type LanguageModel, type LanguageModelUsage, streamText } from 'ai'
import { MODEL_CALL_HEADERS } from '../models/operations.js'
import { streamParts } from '../models/stream.js'
import type { RulePack } from '../protocol.js'
import { languageOf } from './languages.js'
import { packsForPaths, renderRules } from './select.js'

// 审查只看这么多 diff，超出的部分不审
const MAX_DIFF_CHARS = 60_000
const MAX_FINDINGS = 10
// 审查只拦强制级；规则本身不受提示词那 4000 字的预算限制
const REVIEW_RULES_BUDGET = 12_000
export const NO_VIOLATIONS = 'NO_VIOLATIONS'

export interface ReviewFinding {
  ruleId: string
  path: string
  line: number
  message: string
}

export interface AnnotatedDiff {
  // 给审查模型看的 diff：新增行和上下文行前面标上新文件的行号
  text: string
  // 每个文件新增或修改过的行号，用来核对审查意见是不是指向本轮改动
  addedLines: Map<string, Set<number>>
  truncated: boolean
}

// 只保留代码文件（能识别出语言的），并把 hunk 里的行号算好，弱模型自己数行号很容易错
export function annotateDiff(diff: string): AnnotatedDiff {
  const out: string[] = []
  const addedLines = new Map<string, Set<number>>()
  let path: string | null = null
  let keep = false
  let newLine = 0
  let size = 0
  let truncated = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      path = null
      keep = false
      continue
    }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim()
      path = target === '/dev/null' ? null : target.replace(/^b\//, '')
      keep = path !== null && languageOf(path) !== null
      if (keep && path) out.push(`=== ${path}`)
      continue
    }
    if (!keep || !path || line.startsWith('--- ') || line.startsWith('index ')) continue
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      newLine = Number(hunk[1])
      out.push(line)
      continue
    }
    let rendered: string
    if (line.startsWith('+')) {
      rendered = `${String(newLine).padStart(5)} + ${line.slice(1)}`
      let set = addedLines.get(path)
      if (!set) addedLines.set(path, (set = new Set()))
      set.add(newLine)
      newLine++
    } else if (line.startsWith(' ')) {
      rendered = `${String(newLine).padStart(5)}   ${line.slice(1)}`
      newLine++
    } else if (line.startsWith('-')) {
      rendered = `      - ${line.slice(1)}`
    } else {
      continue
    }
    if (size + rendered.length > MAX_DIFF_CHARS) {
      truncated = true
      break
    }
    size += rendered.length + 1
    out.push(rendered)
  }
  return { text: out.join('\n'), addedLines, truncated }
}

// 审查意见要能落到某条规则和某个新增行上，落不到的当作模型臆测丢掉
export function parseReviewOutput(text: string, ruleIds: ReadonlySet<string>, addedLines: AnnotatedDiff['addedLines']): ReviewFinding[] {
  const findings: ReviewFinding[] = []
  for (const raw of text.split(/\r?\n/)) {
    const match = /^[\s\-*`]*([A-Z][A-Z0-9-]*)\s*\|\s*(.+?):(\d+)\s*\|\s*(.+?)\s*`?$/.exec(raw)
    if (!match) continue
    const [, ruleId = '', path = '', line = '', message = ''] = match
    const cleanPath = path.trim().replace(/^b\//, '')
    if (!ruleIds.has(ruleId) || !addedLines.get(cleanPath)?.has(Number(line))) continue
    findings.push({ ruleId, path: cleanPath, line: Number(line), message })
    if (findings.length >= MAX_FINDINGS) break
  }
  return findings
}

export function reviewRulePacks(packs: RulePack[], paths: string[]): RulePack[] {
  return packsForPaths(packs, paths)
    .map((pack) => ({ ...pack, rules: pack.rules.filter((rule) => rule.level === 'required') }))
    .filter((pack) => pack.rules.length > 0)
}

export function buildReviewRequest(packs: RulePack[], diff: AnnotatedDiff, authorSummary: string): { system: string; prompt: string } {
  const system = [
    'You review a code change against coding rules.',
    'Only report clear violations in lines the change added (marked with "+" in the diff below). Ignore unchanged lines, removed lines, ' +
      'matters the rules do not cover, and anything you are not sure about. Do not report a rule just because it is relevant.',
    'Only report a violation when the changed code itself is responsible for what the rule asks. For example, code that only calls ' +
      'an interface passed in by its caller is not responsible for how that interface is configured.',
    'The author may explain in the summary why some code is intentional; accept reasonable explanations.',
    '',
    'Rules (written in Chinese; each starts with its rule ID):',
    renderRules(packs, REVIEW_RULES_BUDGET).text,
    '',
    'Output format, one violation per line, nothing else:',
    'RULE-ID | path:line | short explanation in Chinese',
    'Use the file path after "===" and the line number printed at the start of the diff line.',
    `If there are no violations, output exactly: ${NO_VIOLATIONS}`,
  ].join('\n')
  const prompt = [
    `Author's summary: ${authorSummary || '(none)'}`,
    '',
    'Change (line numbers refer to the new version of each file):',
    diff.text,
    ...(diff.truncated ? ['(The diff was cut off here because it is too long.)'] : []),
  ].join('\n')
  return { system, prompt }
}

export async function callReviewer(
  model: LanguageModel,
  request: { system: string; prompt: string },
  signal: AbortSignal,
): Promise<{ text: string; usage: LanguageModelUsage | null }> {
  const attempt = new AbortController()
  const result = streamText({ model, ...request, maxRetries: 2, abortSignal: AbortSignal.any([signal, attempt.signal]), headers: MODEL_CALL_HEADERS })
  let text = ''
  let usage: LanguageModelUsage | null = null
  for await (const part of streamParts(result.fullStream, () => attempt.abort())) {
    if (part.type === 'text-delta') text += part.text
    if (part.type === 'finish-step') usage = part.usage
  }
  return { text, usage }
}
