import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Lang, parse, type SgRoot } from '@ast-grep/napi'
import { type Language, languageOf, vueScripts } from '../syntax.js'
import { JAVA_RULES, JS_RULES, JSX_RULES, PYTHON_RULES, type StaticRule } from './rules.js'
import { scanSecrets } from './secrets.js'
import { taintScan } from './taint.js'
import type { AddedLines, SecurityFinding } from './types.js'

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_FINDINGS = 40
// 写在出问题的那一行或上一行：// diffra-allow SEC-INJ-1: 理由
const ALLOW_COMMENT = /diffra-allow\s+(SEC-[A-Z]+-\d+)\s*[:：]\s*(\S.*?)\s*(?:\*\/|-->)?\s*$/

// 这一轮没查的文件和原因（太大、读不到），卡片上要说出来，不能静默跳过
export interface StaticScanNotes {
  skipped: string[]
  dropped: number
}

function rulesFor(language: Language): StaticRule[] {
  if (language === 'python') return PYTHON_RULES
  if (language === 'java') return JAVA_RULES
  return language === Lang.TypeScript ? JS_RULES : [...JS_RULES, ...JSX_RULES]
}

function runRules(root: SgRoot, rules: StaticRule[], path: string, added: Map<number, string>, lineOffset: number): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  for (const rule of rules) {
    for (const node of root.root().findAll({ rule: rule.rule })) {
      const range = node.range()
      // 节点跨多行时，只要有一行是本轮新增的就算；报告第一处新增的行
      let line: number | null = null
      for (let current = range.start.line + 1; current <= range.end.line + 1; current++) {
        if (added.has(current + lineOffset)) {
          line = current + lineOffset
          break
        }
      }
      if (line !== null) findings.push({ ruleId: rule.ruleId, severity: rule.severity, path, line, message: rule.message, suppressed: null })
    }
  }
  return findings
}

// 本轮新增的代码按规则匹配常见高危写法，再查硬写的密钥。只在本机运行，不调用模型。
// sources 是检查命令开跑之前读到的文件内容：检查命令可能改了文件（eslint --fix、prettier --write），
// 用那时的内容才能和 diff 的行号对上；不传时自己读
// taint：同时做污点分析（v2，默认开；只看 TS/JS/Vue 和 Python）
export async function staticScan(cwd: string, added: AddedLines, sources?: Map<string, string>, options: { taint?: boolean } = {}): Promise<{ findings: SecurityFinding[]; notes: StaticScanNotes }> {
  const findings: SecurityFinding[] = []
  const tainted: SecurityFinding[] = []
  const notes: StaticScanNotes = { skipped: [], dropped: 0 }
  const files = new Map<string, string[]>()
  for (const [path, lines] of added) {
    const language = languageOf(path)
    if (!language) continue
    let source: string | undefined = sources?.get(path)
    if (source === undefined) {
      try {
        source = await readFile(join(cwd, path), 'utf8')
      } catch (error) {
        // 本轮新增后又被删掉的文件没什么可查的
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
    }
    if (source.length > MAX_FILE_BYTES) {
      notes.skipped.push(path)
      continue
    }
    files.set(path, source.split(/\r?\n/))
    if (language === 'vue') {
      for (const block of vueScripts(source)) {
        const root = parse(block.lang, block.code)
        findings.push(...runRules(root, rulesFor(block.lang), path, lines, block.lineOffset))
        if (options.taint) tainted.push(...taintScan(root.root(), 'script', path, lines, block.lineOffset, source))
      }
      for (const [line, text] of lines) {
        if (/\sv-html=/.test(text)) {
          findings.push({ ruleId: 'SEC-OUT-1', severity: 'medium', path, line, message: '用了 v-html，确认内容已经过滤', suppressed: null })
        }
      }
    } else {
      const root = parse(language, source)
      findings.push(...runRules(root, rulesFor(language), path, lines, 0))
      if (options.taint && language !== 'java') tainted.push(...taintScan(root.root(), language === 'python' ? 'python' : 'script', path, lines, 0, source))
    }
  }
  findings.push(...scanSecrets(added))
  // 同一处已经被按写法匹配的规则报了，污点分析就不再报一遍；规则只是提醒、污点分析确认数据来自请求时换成污点分析的（高危）
  for (const item of tainted) {
    const at = findings.findIndex((other) => other.ruleId === item.ruleId && other.path === item.path && other.line === item.line)
    if (at < 0) findings.push(item)
    else if (findings[at]!.severity !== 'high') findings[at] = item
  }

  const seen = new Set<string>()
  const unique = findings.filter((item) => {
    const key = `${item.ruleId}|${item.path}|${item.line}|${item.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  for (const finding of unique) finding.suppressed = allowedReason(files.get(finding.path) ?? linesOf(added, finding.path), finding)
  // 截断前先按严重程度排：不能把靠后文件里的高危问题丢掉，只留中危。确定保留哪些之后再按路径和行号显示，
  // 卡片和测试都按原来的顺序看
  const bySeverity = [...unique].sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity) || a.path.localeCompare(b.path) || a.line - b.line,
  )
  notes.dropped = Math.max(0, bySeverity.length - MAX_FINDINGS)
  const kept = new Set(bySeverity.slice(0, MAX_FINDINGS))
  const displayed = unique.filter((item) => kept.has(item)).sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  return { findings: displayed, notes }
}

function severityRank(severity: SecurityFinding['severity']): number {
  return severity === 'high' ? 2 : severity === 'medium' ? 1 : 0
}

function linesOf(added: AddedLines, path: string): string[] {
  const lines: string[] = []
  for (const [line, text] of added.get(path) ?? []) lines[line - 1] = text
  return lines
}

// 放行注释要写明规则号和理由；没有理由的不算
function allowedReason(lines: string[], finding: SecurityFinding): string | null {
  for (const text of [lines[finding.line - 1], lines[finding.line - 2]]) {
    const match = text ? ALLOW_COMMENT.exec(text) : null
    if (match && match[1] === finding.ruleId && match[2]) return match[2]
  }
  return null
}
