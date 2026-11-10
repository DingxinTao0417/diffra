import { structuredPatch } from 'diff'
import { useMemo } from 'react'
import type { DiffLine } from '@/lib/unified-diff'
import { DiffLines } from './DiffLines'

export function diffStats(oldText: string | null, newText: string) {
  const patch = structuredPatch('a', 'b', oldText ?? '', newText, undefined, undefined, { context: 3, stripTrailingCr: true })
  let added = 0
  let removed = 0
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) removed += 1
    }
  }
  return { patch, added, removed }
}

// 标题行由调用方画（对话里是 EditBlock 那一行），这里只画代码区。
// 改动卡片只带变化的那段时，startLine 是这一段在文件里从第几行开始，行号按它换成文件里的行号
export function DiffView({ oldText, newText, startLine = 1 }: { oldText: string | null; newText: string; startLine?: number }) {
  const hunks = useMemo(() => diffStats(oldText, newText).patch.hunks.map((hunk) => toDiffLines(hunk, startLine - 1)), [oldText, newText, startLine])
  return <DiffLines hunks={hunks} className="max-h-96 overflow-y-auto" data-testid="diff-view" />
}

function toDiffLines(hunk: { oldStart: number; newStart: number; lines: string[] }, offset: number): DiffLine[] {
  let oldLine = hunk.oldStart + offset
  let newLine = hunk.newStart + offset
  return hunk.lines.flatMap((line): DiffLine[] => {
    const text = line.slice(1)
    if (line.startsWith('+')) return [{ kind: 'add', text, oldLine: null, newLine: newLine++ }]
    if (line.startsWith('-')) return [{ kind: 'remove', text, oldLine: oldLine++, newLine: null }]
    if (line.startsWith(' ')) return [{ kind: 'context', text, oldLine: oldLine++, newLine: newLine++ }]
    // 「\ No newline at end of file」不是代码行，和 parseUnifiedDiff 一样跳过
    return []
  })
}

export function DiffCounts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 font-mono text-xs">
      {added > 0 && <span className="text-diff-add-fg">+{added}</span>}
      {added > 0 && removed > 0 && ' '}
      {removed > 0 && <span className="text-diff-del-fg">−{removed}</span>}
    </span>
  )
}

export function relativePath(path: string, projectPath: string): string {
  const normalize = (value: string) => value.replace(/\\/g, '/')
  const file = normalize(path)
  const root = normalize(projectPath).replace(/\/+$/, '')
  return file.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? file.slice(root.length + 1) : file
}
