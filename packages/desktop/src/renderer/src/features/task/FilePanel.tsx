import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight, FileText, FolderOpen } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { errorMessage } from '@/lib/errors'
import { showToast, useAppState } from '@/state/store'
import { LanguageBadge } from './answer-links'
import { SidePanel } from './SidePanel'

type Loaded = { key: string; text: string; binary: boolean; truncated: boolean } | { key: string; error: string }

// 只读的文件预览（第 536 步）：回答里点了这个任务没改过的文件时打开，定位到那一行并高亮。改过的文件看审阅
export function FilePanel() {
  const preview = useAppState((state) => state.filePreview)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const project = preview?.project ?? null
  const path = preview?.path ?? null
  const key = project && path ? `${project}\n${path}` : null

  // 同一个文件点不同的行不重读
  useEffect(() => {
    if (!project || !path) return
    let stale = false
    const loadedKey = `${project}\n${path}`
    window.diffra.readFile(project, path).then(
      (result) => !stale && setLoaded({ key: loadedKey, ...result }),
      (error: unknown) => !stale && setLoaded({ key: loadedKey, error: errorMessage(error) }),
    )
    return () => {
      stale = true
    }
  }, [project, path])

  const current = loaded && loaded.key === key ? loaded : null
  const lines = current && 'text' in current && !current.binary ? current.text.replace(/\n$/, '').split('\n') : []
  const line = preview?.line ?? null

  // 读到内容、或者换了要定位的行：把那一行滚到上方三分之一处。不用 scrollIntoView，它会连带滚动 overflow-hidden 的外壳
  useLayoutEffect(() => {
    const element = scrollRef.current
    const row = line ? element?.querySelector<HTMLElement>(`[data-line="${line}"]`) : null
    if (!element) return
    if (!row) {
      element.scrollTop = 0
      return
    }
    element.scrollTop += row.getBoundingClientRect().top - element.getBoundingClientRect().top - element.clientHeight / 3
  }, [current, line])

  if (!preview) return null
  const segments = preview.path.split('/')
  const run = (action: Promise<unknown>) => action.catch((error: unknown) => showToast(errorMessage(error)))
  return (
    <SidePanel
      width="wide"
      testId="file-panel"
      controls={
        <span className="flex min-w-0 items-center gap-1 text-sm" title={preview.path}>
          <LanguageBadge path={preview.path} />
          {segments.map((segment, index) => (
            <span key={index} className={cn('flex min-w-0 items-center gap-1', index < segments.length - 1 ? 'shrink text-muted-foreground' : 'shrink-0 font-medium')}>
              <span className="truncate">{segment}</span>
              {index < segments.length - 1 && <ChevronRight className="size-3 shrink-0" />}
            </span>
          ))}
        </span>
      }
      actions={
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="用默认应用打开" className="text-muted-foreground" onClick={() => void run(window.diffra.openFile(preview.project, preview.path))}>
                <FileText className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>用默认应用打开</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="在资源管理器中显示" className="text-muted-foreground" onClick={() => void run(window.diffra.revealFile(preview.project, preview.path))}>
                <FolderOpen className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>在资源管理器中显示</TooltipContent>
          </Tooltip>
        </>
      }
    >
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto py-2 font-mono text-xs leading-5" data-testid="file-preview">
        {!current && <p className="px-4 font-sans text-sm text-muted-foreground">正在读取…</p>}
        {current && 'error' in current && <p className="px-4 font-sans text-sm text-destructive">{current.error}</p>}
        {current && 'binary' in current && current.binary && <p className="px-4 font-sans text-sm text-muted-foreground">二进制文件，不显示内容</p>}
        {lines.length > 0 && (
          <div className="min-w-max">
            {lines.map((text, index) => (
              <div key={index} data-line={index + 1} className={cn('flex pr-4', index + 1 === line && 'bg-accent')}>
                <span className="w-12 shrink-0 pr-3 text-right text-muted-foreground select-none">{index + 1}</span>
                <span className="whitespace-pre">{text || ' '}</span>
              </div>
            ))}
          </div>
        )}
        {current && 'truncated' in current && current.truncated && <p className="px-4 pt-2 font-sans text-sm text-muted-foreground">文件超过 1 MB，只显示开头</p>}
      </div>
    </SidePanel>
  )
}
