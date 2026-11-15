import { useState } from 'react'
import { cn } from 'cn'
import { Checkbox } from '@/components/ui/checkbox'
import { LanguageBadge } from '../answer-links'
import { LocationLink } from './LocationLink'

// 第 658 步：规范审查、架构检查、安全检查的发现按文件或级别分组，位置能点开到那一行，审查的问题能勾成已解决（只记在界面上，帮用户对着看）

// 规范审查和架构检查的一行：「规则或导入  路径:行号  说明」
export const FINDING_PATTERN = /^(\S+) {2}(\S+:\d+) {2}(.+)$/

const fileOf = (location: string) => location.replace(/:\d+(?::\d+)?$/, '')

export function ReviewFindings({ lines }: { lines: string[] }) {
  const [resolved, setResolved] = useState<Set<number>>(new Set())
  const parsed = lines.map((line, index) => ({ line, index, match: FINDING_PATTERN.exec(line) }))
  const notes = parsed.filter((item) => !item.match)
  const groups = new Map<string, typeof parsed>()
  for (const item of parsed) {
    if (!item.match) continue
    const file = fileOf(item.match[2]!)
    groups.set(file, [...(groups.get(file) ?? []), item])
  }
  const total = parsed.length - notes.length
  const toggle = (index: number) =>
    setResolved((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  return (
    <>
      {notes.map((item) => (
        <div key={item.index} className="leading-relaxed">
          {item.line}
        </div>
      ))}
      {[...groups].map(([file, items]) => (
        <div key={file} className="flex flex-col gap-0.5" data-testid="review-file-group">
          {groups.size > 1 && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <LanguageBadge path={file} />
              <span className="min-w-0 truncate font-mono">{file}</span>
              <span className="tabular-nums">{items.length}</span>
            </p>
          )}
          {items.map(({ index, match }) => (
            <div key={index} className="flex items-start gap-2 leading-relaxed" data-testid="review-finding" data-resolved={resolved.has(index) || undefined}>
              <Checkbox className="mt-1" checked={resolved.has(index)} onCheckedChange={() => toggle(index)} aria-label={`标记为已解决：${match![3]}`} />
              <div className={cn('flex min-w-0 flex-wrap gap-x-2.5', resolved.has(index) && 'text-muted-foreground line-through')}>
                <span className="font-mono text-xs leading-6 text-destructive">{match![1]}</span>
                <LocationLink location={match![2]!} className="font-mono text-xs leading-6" />
                <span>{match![3]}</span>
              </div>
            </div>
          ))}
        </div>
      ))}
      {total > 1 && (
        <p className="text-xs text-muted-foreground tabular-nums" data-testid="review-progress">
          已解决 {resolved.size}/{total}
        </p>
      )}
    </>
  )
}

export interface SecurityRow {
  line: string
  match: RegExpExecArray | null
}

const LEVEL_ORDER = ['高危', '提醒', '已放行']

const LEVEL_STYLES: Record<string, string> = {
  高危: 'bg-destructive/10 text-destructive',
  提醒: 'bg-warning/10 text-warning',
  已放行: 'bg-muted text-muted-foreground',
}

// 安全检查的发现按级别分组（高危在前），每组写条数
export function SecurityFindings({ rows }: { rows: SecurityRow[] }) {
  const notes = rows.filter((row) => !row.match)
  const levels = LEVEL_ORDER.map((level) => ({ level, rows: rows.filter((row) => row.match?.[1] === level) })).filter((group) => group.rows.length > 0)
  return (
    <>
      {levels.map(({ level, rows: items }) => (
        <div key={level} className="flex flex-col gap-0.5" data-testid="security-level-group" data-level={level}>
          {levels.length > 1 && (
            <p className="text-xs text-muted-foreground tabular-nums">
              {level} {items.length}
            </p>
          )}
          {items.map(({ match }, index) => (
            <div key={index} className="flex flex-wrap items-baseline gap-x-2.5 leading-relaxed" data-testid="security-finding">
              <span className={cn('shrink-0 rounded-sm px-1.5 text-xs', LEVEL_STYLES[match![1] ?? ''])}>{match![1]}</span>
              <span className="font-mono text-xs">{match![2]}</span>
              <LocationLink location={match![3]!} className="font-mono text-xs" />
              <span>{match![4]}</span>
            </div>
          ))}
        </div>
      ))}
      {notes.map((row, index) => (
        <div key={index} className="leading-relaxed">
          {row.line}
        </div>
      ))}
    </>
  )
}

export function levelStyle(level: string): string {
  return LEVEL_STYLES[level] ?? ''
}
