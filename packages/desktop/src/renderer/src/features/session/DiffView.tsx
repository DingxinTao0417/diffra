import { structuredPatch } from 'diff'
import { useMemo } from 'react'

interface DiffViewProps {
  path: string
  // null 表示新建的文件
  oldText: string | null
  newText: string
  projectPath: string
}

export function DiffView({ path, oldText, newText, projectPath }: DiffViewProps) {
  const patch = useMemo(
    () => structuredPatch(path, path, oldText ?? '', newText, undefined, undefined, { context: 3, stripTrailingCr: true }),
    [path, oldText, newText],
  )

  return (
    <div className="overflow-hidden rounded-md border font-mono text-xs" data-testid="diff-view">
      <div className="border-b bg-muted px-3 py-1.5">
        {relativePath(path, projectPath)}
        {oldText === null && <span className="ml-2 text-muted-foreground">（新文件）</span>}
      </div>
      <div className="max-h-96 overflow-auto">
        {patch.hunks.map((hunk) => (
          <div key={`${hunk.oldStart}-${hunk.newStart}`}>
            <div className="bg-muted/50 px-3 py-0.5 text-muted-foreground">
              @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
            </div>
            {hunk.lines.map((line, index) => (
              <div key={index} className={`whitespace-pre px-3 ${lineClass(line)}`}>
                {line}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function lineClass(line: string): string {
  if (line.startsWith('+')) return 'bg-green-500/10 text-green-700 dark:text-green-400'
  if (line.startsWith('-')) return 'bg-red-500/10 text-red-700 dark:text-red-400'
  return ''
}

export function relativePath(path: string, projectPath: string): string {
  const normalize = (value: string) => value.replace(/\\/g, '/')
  const file = normalize(path)
  const root = normalize(projectPath).replace(/\/+$/, '')
  return file.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? file.slice(root.length + 1) : file
}
