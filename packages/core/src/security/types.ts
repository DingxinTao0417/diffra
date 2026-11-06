// 高危打回给编码模型修；中危只在卡片上提醒
export type Severity = 'high' | 'medium'

export interface SecurityFinding {
  // 对应「安全」规则包里的规则号，比如 SEC-INJ-1
  ruleId: string
  severity: Severity
  path: string
  line: number
  message: string
  // 代码里写了 diffra-allow 放行时的理由
  suppressed: string | null
}

// 每个文件本轮新增的行：行号 → 内容
export type AddedLines = Map<string, Map<number, string>>

const SEVERITY_LABELS: Record<Severity, string> = { high: '高危', medium: '提醒' }

// 卡片内容，一行一条；界面按「级别  规则号  路径:行号  说明」解析
export function formatFindings(findings: SecurityFinding[]): string {
  return findings
    .map((item) =>
      item.suppressed !== null
        ? `已放行  ${item.ruleId}  ${item.path}:${item.line}  ${item.message}（理由：${item.suppressed}）`
        : `${SEVERITY_LABELS[item.severity]}  ${item.ruleId}  ${item.path}:${item.line}  ${item.message}`,
    )
    .join('\n')
}

export function blocking(findings: SecurityFinding[]): SecurityFinding[] {
  return findings.filter((item) => item.severity === 'high' && item.suppressed === null)
}

// 读 git diff，记下每个文件新增的行；和规范审查用的 annotateDiff 不同，不限文件类型、不截断
export function addedLinesOf(diff: string): AddedLines {
  const added: AddedLines = new Map()
  let lines: Map<number, string> | null = null
  let newLine = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      lines = null
      continue
    }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim()
      if (target === '/dev/null') {
        lines = null
        continue
      }
      const path = target.replace(/^b\//, '')
      lines = new Map()
      added.set(path, lines)
      continue
    }
    if (!lines || line.startsWith('--- ')) continue
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      newLine = Number(hunk[1])
      continue
    }
    if (line.startsWith('+')) lines.set(newLine++, line.slice(1))
    else if (line.startsWith(' ')) newLine++
  }
  for (const [path, set] of added) if (set.size === 0) added.delete(path)
  return added
}
