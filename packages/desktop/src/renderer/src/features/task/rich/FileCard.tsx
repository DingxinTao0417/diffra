import { type ReactNode, useContext, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, FileDiff, FileText, Globe, PanelRight } from 'lucide-react'
import { errorMessage } from '@/lib/errors'
import { showToast, store } from '@/state/store'
import { AnswerContext, AnswerLink, LanguageBadge, openFilePreview, useProjectFile } from '../answer-links'
import { ShellAction } from './BlockShell'
import { CodeLines } from './CodeBlock'
import { useHighlighted } from './highlight'

// 预览那一行前后各几行
const PREVIEW_CONTEXT = 3

// 单独成段的文件引用（一段只有 `src/a.ts:12` 或 [a.ts](src/a.ts#L12)）：画成文件卡，带语言图标、行号，能预览那几行、在文件面板打开、看这个任务的改动。
// 不是项目里的文件时照常显示 fallback
export function FileCard({ path, line, fallback }: { path: string; line: number | null; fallback: ReactNode }) {
  const target = useContext(AnswerContext)
  const file = useProjectFile(path)
  const [open, setOpen] = useState(false)
  if (!file || !target) return fallback
  const changed = target.changed.has(file.relative)
  const run = (action: Promise<unknown>) => action.catch((error: unknown) => showToast(errorMessage(error)))
  return (
    <div className="overflow-hidden rounded-lg border" data-testid="file-card">
      <div className="flex items-center gap-1.5 pr-1 text-sm">
        <button type="button" aria-expanded={open} aria-label={`${open ? '收起' : '预览'} ${file.relative}`} className="flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-accent" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
          <LanguageBadge path={file.relative} />
          <span className="min-w-0 truncate font-mono text-xs" title={file.relative}>
            {file.relative}
          </span>
          {line && <span className="shrink-0 font-mono text-xs text-muted-foreground">:{line}</span>}
        </button>
        <ShellAction label="在文件面板打开" onClick={() => openFilePreview(target.project, file.relative, line)}>
          <PanelRight />
        </ShellAction>
        {changed && (
          <ShellAction label="查看这个任务的改动" onClick={() => store.set((state) => ({ ...state, panel: 'review', reviewFile: file.relative }))}>
            <FileDiff />
          </ShellAction>
        )}
        <ShellAction label="用默认应用打开" onClick={() => void run(window.diffra.openFile(target.project, file.relative))}>
          <FileText />
        </ShellAction>
      </div>
      {open && <FilePreview project={target.project} path={file.relative} line={line} />}
    </div>
  )
}

function FilePreview({ project, path, line }: { project: string; path: string; line: number | null }) {
  const [state, setState] = useState<{ text: string } | { error: string } | null>(null)
  useEffect(() => {
    let stale = false
    window.diffra.readFile(project, path).then(
      (result) => !stale && setState(result.binary ? { error: '二进制文件，不能预览' } : { text: result.text.replace(/\r\n/g, '\n') }),
      (error: unknown) => !stale && setState({ error: errorMessage(error) }),
    )
    return () => {
      stale = true
    }
  }, [project, path])
  const all = state && 'text' in state ? state.text.split('\n') : []
  const from = line ? Math.max(1, line - PREVIEW_CONTEXT) : 1
  const to = line ? Math.min(all.length, line + PREVIEW_CONTEXT) : Math.min(all.length, 12)
  const code = all.slice(from - 1, to).join('\n')
  const language = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const lines = useHighlighted(code, language, Boolean(state && 'text' in state))
  if (!state) return <p className="border-t px-3 py-2 text-xs text-muted-foreground">正在读取…</p>
  if ('error' in state) return <p className="border-t px-3 py-2 text-xs text-muted-foreground">{state.error}</p>
  return (
    <div className="border-t bg-muted" data-testid="file-card-preview">
      <CodeLines lines={lines} numbered start={from} highlight={new Set(line ? [line - from + 1] : [])} />
    </div>
  )
}

// 单独成段的网页链接、脚注里的来源：一张来源卡，域名首字母当图标（不联网取 favicon，主窗口的 CSP 也不放行外部图片）
export function SourceCard({ href, title, index }: { href: string; title: ReactNode; index?: number }) {
  let host = ''
  try {
    host = new URL(href).host.replace(/^www\./, '')
  } catch {
    return <AnswerLink href={href}>{title}</AnswerLink>
  }
  return (
    <span className="flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm" data-testid="source-card">
      {index !== undefined && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{index}</span>}
      <span className="flex size-5 shrink-0 items-center justify-center rounded-sm bg-muted text-xs font-bold text-muted-foreground uppercase" aria-hidden="true">
        {host.charAt(0) || <Globe className="size-3" />}
      </span>
      <span className="min-w-0 flex-1 truncate">
        <AnswerLink href={href}>{title}</AnswerLink>
      </span>
      <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">{host}</span>
    </span>
  )
}
