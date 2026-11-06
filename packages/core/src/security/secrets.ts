import { basename } from 'node:path'
import type { AddedLines, SecurityFinding } from './types.js'

// 格式明确的密钥：几乎不会误报，按高危打回
const KNOWN_FORMATS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'AWS 访问密钥', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub 令牌', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'GitHub 细粒度令牌', pattern: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { name: '模型服务的 API Key', pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { name: 'Stripe 密钥', pattern: /\b[rs]k_live_[0-9A-Za-z]{24,}\b/ },
  { name: 'Slack 令牌', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Google API Key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: '私钥', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/ },
]

// 「password = '...'」这类写法：值可能是示例，只提醒
const ASSIGNED_SECRET = /\b(password|passwd|pwd|secret|api_?key|access_?token|auth_?token|client_?secret|private_?key)\b["']?\s*[:=]\s*["']([^"'\s]{8,})["']/i
const PLACEHOLDER = /x{4,}|\*{3,}|your|example|sample|changeme|placeholder|dummy|test|fake|todo|\$\{|<[^>]*>|\{\{|process\.env|os\.environ|getenv/i

// 锁文件和压缩产物里的长串不是密钥
const SKIPPED_FILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'poetry.lock', 'uv.lock', 'Cargo.lock'])

export function scanSecrets(added: AddedLines): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  for (const [path, lines] of added) {
    const name = basename(path)
    if (SKIPPED_FILES.has(name) || /\.min\.(js|css)$/.test(name)) continue
    for (const [line, text] of lines) {
      if (text.length > 2000) continue
      const known = KNOWN_FORMATS.find((item) => item.pattern.test(text))
      if (known) {
        findings.push({ ruleId: 'SEC-KEY-1', severity: 'high', path, line, message: `代码里写了${known.name}，改从环境变量或密钥管理服务读取`, suppressed: null })
        continue
      }
      const assigned = ASSIGNED_SECRET.exec(text)
      if (assigned && !PLACEHOLDER.test(assigned[2] ?? '')) {
        findings.push({ ruleId: 'SEC-KEY-1', severity: 'medium', path, line, message: `${assigned[1]} 写成了固定值，确认不是真实密钥；真实的要从环境变量读取`, suppressed: null })
      }
    }
  }
  return findings
}
