import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Lang, parse, type SgRoot } from '@ast-grep/napi'
import { type Language, languageOf, vueScripts } from '../syntax.js'
import { JS_RULES, JSX_RULES, PYTHON_RULES, type StaticRule } from './rules.js'
import { scanSecrets } from './secrets.js'
import type { AddedLines, SecurityFinding } from './types.js'

const MAX_FILE_BYTES = 1_000_000
const MAX_FINDINGS = 40
// 写在出问题的那一行或上一行：// diffra-allow SEC-INJ-1: 理由
const ALLOW_COMMENT = /diffra-allow\s+(SEC-[A-Z]+-\d+)\s*[:：]\s*(\S.*?)\s*(?:\*\/|-->)?\s*$/

function rulesFor(language: Language): StaticRule[] {
  if (language === 'python') return PYTHON_RULES
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

// 本轮新增的代码按规则匹配常见高危写法，再查硬写的密钥。只在本机运行，不调用模型
export async function staticScan(cwd: string, added: AddedLines): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = []
  const sources = new Map<string, string[]>()
  for (const [path, lines] of added) {
    const language = languageOf(path)
    if (!language) continue
    let source: string
    try {
      source = await readFile(join(cwd, path), 'utf8')
    } catch (error) {
      // 本轮新增后又被删掉的文件没什么可查的
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (source.length > MAX_FILE_BYTES) continue
    sources.set(path, source.split(/\r?\n/))
    if (language === 'vue') {
      for (const block of vueScripts(source)) findings.push(...runRules(parse(block.lang, block.code), rulesFor(block.lang), path, lines, block.lineOffset))
      for (const [line, text] of lines) {
        if (/\sv-html=/.test(text)) {
          findings.push({ ruleId: 'SEC-OUT-1', severity: 'medium', path, line, message: '用了 v-html，确认内容已经过滤', suppressed: null })
        }
      }
    } else {
      findings.push(...runRules(parse(language, source), rulesFor(language), path, lines, 0))
    }
  }
  findings.push(...scanSecrets(added))

  const seen = new Set<string>()
  const unique = findings.filter((item) => {
    const key = `${item.ruleId}|${item.path}|${item.line}|${item.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  for (const finding of unique) finding.suppressed = allowedReason(sources.get(finding.path) ?? linesOf(added, finding.path), finding)
  return unique.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line).slice(0, MAX_FINDINGS)
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
