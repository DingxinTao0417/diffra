import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AnnotatedDiff } from '../rules/review.js'
import type { SecurityFinding } from './types.js'

export const NO_FINDINGS = 'NO_FINDINGS'
const MAX_FINDINGS = 10
// 改动所在文件的完整内容作为上下文（被改函数的调用方、被调用的函数大多在同一个文件里）
const MAX_FILE_CHARS = 12_000
const MAX_CONTEXT_CHARS = 40_000

// 问题类别都对应「安全」规则包里的规则号，界面和规范审查用同一套编号
export const SECURITY_CATEGORIES: Array<[string, string]> = [
  ['SEC-INJ-1', 'SQL injection: external input reaches a SQL string'],
  ['SEC-INJ-2', 'Command or code injection: external input reaches a shell command, eval or similar'],
  ['SEC-INJ-3', 'Missing validation of external input where it matters for safety (type, length, range)'],
  ['SEC-INJ-4', 'Path traversal: external input decides a file path without confining it to an allowed directory'],
  ['SEC-INJ-5', 'Regular expression denial of service on external input'],
  ['SEC-INJ-6', 'Unsafe deserialization or XML external entities'],
  ['SEC-OUT-1', 'XSS: external data written into HTML without escaping'],
  ['SEC-OUT-2', 'Personal data (phone, ID, bank card, address) exposed without masking'],
  ['SEC-OUT-4', 'Error responses leak stack traces, SQL or file paths'],
  ['SEC-AUTH-1', 'Broken access control: user-owned data or actions not checked against the current user'],
  ['SEC-AUTH-2', 'Endpoint missing authentication or authorization'],
  ['SEC-REQ-1', 'Missing CSRF protection, or CORS that allows any origin with credentials'],
  ['SEC-REQ-2', 'SSRF or open redirect: external input decides a URL to request or redirect to'],
  ['SEC-REQ-3', 'Costly actions (SMS, email, orders, payments) without rate limiting'],
  ['SEC-REQ-4', 'File upload without type and size limits'],
  ['SEC-KEY-1', 'Hard-coded secrets or credentials'],
  ['SEC-KEY-2', 'Passwords stored without a slow salted hash'],
  ['SEC-KEY-3', 'Insecure randomness for security values'],
  ['SEC-KEY-4', 'Weak cryptography or disabled TLS verification'],
]

const CATEGORY_IDS = new Set(SECURITY_CATEGORIES.map(([id]) => id))

export async function buildLightScanRequest(cwd: string, diff: AnnotatedDiff, authorSummary: string): Promise<{ system: string; prompt: string }> {
  const system = [
    'You are a security reviewer. Review a code change for exploitable security problems.',
    'Trace whether data from outside the program (HTTP parameters, body, headers and cookies, CLI arguments, environment, files, ' +
      'messages, database rows written by users) can reach a dangerous operation: SQL, shell commands, eval, file paths, ' +
      'outgoing URLs and redirects, HTML output, deserialization. Also check authentication and authorization of new endpoints ' +
      'and user-owned data, secrets, cryptography, randomness and sensitive data exposure.',
    'Only report problems located in lines the change added (marked with "+"). Use the full file contents only as context.',
    'Only report a problem when you can say how untrusted data gets there or why it is exploitable. Do not report style, ' +
      'missing tests, or hypothetical issues. If you are not sure, do not report it.',
    'Severity: high = exploitable with external input, or a real secret leak; medium = risky but needs specific conditions; ' +
      'low = hardening suggestion.',
    'The author may explain intentional choices in the summary; accept reasonable explanations.',
    '',
    'Categories (use the ID):',
    ...SECURITY_CATEGORIES.map(([id, description]) => `${id}: ${description}`),
    '',
    'Output format, one problem per line, nothing else:',
    'SEVERITY | RULE-ID | path:line | short explanation in Chinese, including how to fix it',
    'Use the file path after "===" and the line number printed at the start of the diff line.',
    `If there are no problems, output exactly: ${NO_FINDINGS}`,
  ].join('\n')

  const context: string[] = []
  let budget = MAX_CONTEXT_CHARS
  for (const path of diff.addedLines.keys()) {
    const content = await readFile(join(cwd, path), 'utf8').catch(() => null)
    if (content === null || content.length > MAX_FILE_CHARS || content.length > budget) continue
    budget -= content.length
    context.push(`=== ${path} (full file, for context)`, content)
  }
  const prompt = [
    `Author's summary: ${authorSummary || '(none)'}`,
    '',
    'Change (line numbers refer to the new version of each file):',
    diff.text,
    ...(diff.truncated ? ['(The diff was cut off here because it is too long.)'] : []),
    ...(context.length > 0 ? ['', 'Files touched by the change:', ...context] : []),
  ].join('\n')
  return { system, prompt }
}

const FINDING_LINE = /^\s*(?:[-*]\s*)?(high|medium|low)\s*\|\s*(SEC-[A-Z]+-\d+)\s*\|\s*([^|]+?):(\d+)\s*\|\s*(.+)$/i

// 只收规则号存在、并且落在本轮新增行上的问题；落不到新增行上的当作臆测丢掉。low 和 medium 都只提醒
export function parseLightScanOutput(output: string, addedLines: Map<string, Set<number>>): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = FINDING_LINE.exec(line)
    if (!match) continue
    const [, severity = '', ruleId = '', rawPath = '', lineText = '', message = ''] = match
    const path = rawPath.trim().replace(/^b\//, '')
    const lineNumber = Number(lineText)
    if (!CATEGORY_IDS.has(ruleId) || !addedLines.get(path)?.has(lineNumber)) continue
    findings.push({ ruleId, severity: severity.toLowerCase() === 'high' ? 'high' : 'medium', path, line: lineNumber, message: message.trim(), suppressed: null })
    if (findings.length >= MAX_FINDINGS) break
  }
  return findings
}
