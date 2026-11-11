import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, FileCode2, Folder, Package, Search } from 'lucide-react'
import { cn } from 'cn'
import { Input } from '@/components/ui/input'
import { useArch } from './context'
import { formatCount, parseScope } from './graph'

const MAX_RESULTS = 200

// 左边的目录树：点目录把架构图切到这个目录，点文件选中它；搜索按路径找目录和文件
export function ModuleTree() {
  const { index, route, go } = useArch()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<Set<string>>(() => new Set(['']))
  const { kind, path } = parseScope(route.scope)
  const current = kind === 'file' ? (index.file(path)?.module ?? '') : kind === 'dir' ? path : null

  // 换范围时展开到它
  useEffect(() => {
    if (current === null) return
    setOpen((previous) => {
      const next = new Set(previous)
      const parts = current === '' ? [] : current.split('/')
      for (let at = 0; at <= parts.length; at++) next.add(parts.slice(0, at).join('/'))
      return next
    })
  }, [current])

  const results = useMemo(() => {
    const text = query.trim().toLowerCase()
    if (!text) return null
    const dirs = index.analysis.modules.filter((module) => module.path.toLowerCase().includes(text)).map((module) => ({ kind: 'dir' as const, path: module.path }))
    const files = index.analysis.files.filter((file) => file.path.toLowerCase().includes(text)).map((file) => ({ kind: 'file' as const, path: file.path }))
    return [...dirs, ...files].slice(0, MAX_RESULTS)
  }, [query, index])

  const selectDir = (dir: string) => go({ scope: `dir:${index.collapse(dir)}`, focus: `dir:${dir}` })
  const selectFile = (file: string) => go({ scope: `dir:${index.file(file)?.module ?? ''}`, focus: `file:${file}` })
  const toggle = (dir: string) =>
    setOpen((previous) => {
      const next = new Set(previous)
      if (next.has(dir)) next.delete(dir)
      else next.add(dir)
      return next
    })

  const renderDir = (dir: string, depth: number): React.ReactNode => {
    const children = index.childDirs.get(dir) ?? []
    const files = index.dirFiles.get(dir) ?? []
    return (
      <>
        {children.map((child) => {
          // 只有一个子目录的目录合并成一行
          const collapsed = index.collapse(child)
          const module = index.module(collapsed) ?? index.module(child)
          const expanded = open.has(collapsed)
          const isPackage = index.packageByDir.has(child) || index.packageByDir.has(collapsed)
          const active = current !== null && (current === collapsed || current === child)
          const Icon = isPackage ? Package : Folder
          return (
            <div key={child}>
              <div
                className={cn('group flex h-7 items-center gap-1 rounded-md pr-2 text-sm hover:bg-accent', active && 'bg-accent font-medium')}
                style={{ paddingLeft: depth * 12 + 4 }}
                data-testid="architecture-tree-dir"
              >
                <button type="button" className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground" aria-label={expanded ? '收起' : '展开'} onClick={() => toggle(collapsed)}>
                  <ChevronRight className={cn('size-3.5 transition-transform', expanded && 'rotate-90')} />
                </button>
                <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={collapsed} onClick={() => selectDir(child)}>
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{collapsed.slice(dir ? dir.length + 1 : 0)}</span>
                </button>
                <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{module ? formatCount(module.lines) : ''}</span>
              </div>
              {expanded && renderDir(collapsed, depth + 1)}
            </div>
          )
        })}
        {files.map((fileIndex) => {
          const file = index.analysis.files[fileIndex]!
          const active = route.focus === `file:${file.path}` || route.scope === `file:${file.path}`
          return (
            <button
              key={file.path}
              type="button"
              className={cn('flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-sm hover:bg-accent', active && 'bg-accent font-medium')}
              style={{ paddingLeft: depth * 12 + 28 }}
              title={file.path}
              onClick={() => selectFile(file.path)}
              onDoubleClick={() => go({ scope: `file:${file.path}`, focus: null, tab: 'dependencies', section: 'graph' })}
            >
              <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{file.path.split('/').pop()}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{formatCount(file.lines)}</span>
            </button>
          )
        })}
      </>
    )
  }

  return (
    <div className="flex h-full flex-col" data-testid="architecture-tree">
      <div className="relative p-2">
        <Search className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索目录和文件" aria-label="搜索目录和文件" className="h-8 pl-7 text-sm" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {results ? (
          results.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">没有匹配的目录或文件</div>
          ) : (
            results.map((result) => (
              <button
                key={`${result.kind}:${result.path}`}
                type="button"
                className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-sm hover:bg-accent"
                title={result.path}
                onClick={() => (result.kind === 'dir' ? selectDir(result.path) : selectFile(result.path))}
              >
                {result.kind === 'dir' ? <Folder className="size-3.5 shrink-0 text-muted-foreground" /> : <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />}
                <span className="truncate">{result.path || '（根目录）'}</span>
              </button>
            ))
          )
        ) : (
          renderDir('', 0)
        )}
      </div>
    </div>
  )
}
