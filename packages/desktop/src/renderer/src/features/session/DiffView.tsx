import { structuredPatch } from 'diff'
import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

interface DiffViewProps {
  path: string
  // null 表示新建的文件
  oldText: string | null
  newText: string
  projectPath: string
  status?: React.ReactNode
}

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

export function DiffView({ path, oldText, newText, projectPath, status }: DiffViewProps) {
  const { patch, added, removed } = useMemo(() => diffStats(oldText, newText), [oldText, newText])
  const [open, setOpen] = useState(true)

  return (
    <div className="overflow-hidden rounded-[10px] border text-sm" data-testid="diff-view">
      <button type="button" className="flex w-full items-center gap-2 bg-muted/40 px-3 py-2 text-left" onClick={() => setOpen(!open)}>
        {status}
        <span>{oldText === null ? '新建' : '编辑'}</span>
        <span className="min-w-0 truncate font-mono text-xs">{relativePath(path, projectPath)}</span>
        <DiffCounts added={added} removed={removed} />
        <span className="ml-auto text-muted-foreground">{open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</span>
      </button>
      {open && (
        <div className="max-h-96 overflow-auto border-t py-1.5 font-mono text-xs leading-relaxed">
          {patch.hunks.map((hunk, index) => (
            <div key={`${hunk.oldStart}-${hunk.newStart}`}>
              {index > 0 && <div className="px-3.5 text-muted-foreground">⋯</div>}
              {hunk.lines.map((line, lineIndex) => (
                <div key={lineIndex} className={`px-3.5 whitespace-pre ${diffLineClass(line)}`}>
                  {line}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function DiffCounts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 font-mono text-xs">
      {added > 0 && <span className="text-success">+{added}</span>}
      {added > 0 && removed > 0 && ' '}
      {removed > 0 && <span className="text-destructive">−{removed}</span>}
    </span>
  )
}

export function diffLineClass(line: string): string {
  if (line.startsWith('+')) return 'bg-success/10'
  if (line.startsWith('-')) return 'bg-destructive/10'
  return ''
}

export function relativePath(path: string, projectPath: string): string {
  const normalize = (value: string) => value.replace(/\\/g, '/')
  const file = normalize(path)
  const root = normalize(projectPath).replace(/\/+$/, '')
  return file.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? file.slice(root.length + 1) : file
}
