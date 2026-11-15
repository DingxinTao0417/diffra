import { useContext, useMemo, useState } from 'react'
import type { LogData, LogLevel } from '@diffra/core/rich'
import { Copy, ScrollText, Search } from 'lucide-react'
import { cn } from 'cn'
import { AnswerContext, openFilePreview, useProjectFile } from '../answer-links'
import { BlockShell, copyText, ShellAction } from './BlockShell'

// 先画这么多行，「显示全部」再画剩下的
const PAGE_LINES = 300

const LEVELS: Array<{ level: LogLevel; label: string }> = [
  { level: 'error', label: '错误' },
  { level: 'warn', label: '警告' },
  { level: 'info', label: '信息' },
  { level: 'debug', label: '调试' },
]

const LINE_TONE: Record<LogLevel, string> = {
  error: 'text-destructive',
  warn: 'text-warning',
  info: '',
  debug: 'text-muted-foreground',
}

// ```log：按级别筛选（标签上是条数）、搜索；行里的源码位置（src/a.ts:12）是项目里的文件时能点开到那一行
export function LogBlock({ data }: { data: LogData }) {
  const [levels, setLevels] = useState<Set<LogLevel>>(new Set())
  const [query, setQuery] = useState('')
  const [all, setAll] = useState(false)
  const counts = useMemo(() => {
    const result: Record<LogLevel, number> = { error: 0, warn: 0, info: 0, debug: 0 }
    for (const line of data.lines) if (line.level) result[line.level] += 1
    return result
  }, [data.lines])
  const needle = query.trim().toLowerCase()
  const visible = useMemo(() => data.lines.map((line, index) => ({ ...line, index })).filter((line) => (levels.size === 0 || (line.level && levels.has(line.level))) && (!needle || line.text.toLowerCase().includes(needle))), [data.lines, levels, needle])
  const shown = all ? visible : visible.slice(0, PAGE_LINES)
  const toggle = (level: LogLevel) =>
    setLevels((current) => {
      const next = new Set(current)
      if (next.has(level)) next.delete(level)
      else next.add(level)
      return next
    })
  const numberWidth = `${String(data.lines.length).length}ch`
  return (
    <BlockShell
      testId="log-block"
      kind="log"
      icon={<ScrollText className="size-3.5 shrink-0" />}
      title="日志"
      meta={<span className="shrink-0 tabular-nums">· {levels.size > 0 || needle ? `${visible.length}/${data.lines.length}` : data.lines.length} 行</span>}
      actions={
        <ShellAction label="复制日志" onClick={() => copyText(data.lines.map((line) => line.text).join('\n'), '已复制日志')}>
          <Copy />
        </ShellAction>
      }
    >
      <div className="flex flex-wrap items-center gap-1.5 border-b px-2 py-1">
        {LEVELS.filter(({ level }) => counts[level] > 0).map(({ level, label }) => (
          <button
            key={level}
            type="button"
            aria-pressed={levels.has(level)}
            className={cn('rounded-md border px-1.5 py-px text-xs tabular-nums hover:bg-accent', levels.has(level) ? 'border-foreground/40 bg-soft text-foreground' : 'text-muted-foreground')}
            onClick={() => toggle(level)}
            data-testid={`log-filter-${level}`}
          >
            {label} {counts[level]}
          </button>
        ))}
        <label className="flex min-w-32 flex-1 items-center gap-1.5 text-sm">
          <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索日志" aria-label="搜索日志" className="min-w-0 flex-1 bg-transparent py-0.5 outline-none placeholder:text-muted-foreground" />
        </label>
      </div>
      <div className="code-body max-h-96 overflow-auto" role="log" aria-label="日志">
        <div className="w-max min-w-full">
          {shown.map((line) => (
            <div key={line.index} className={cn('code-line', LINE_TONE[line.level ?? 'info'])} data-testid="log-line" data-level={line.level ?? undefined}>
              <span className="code-ln" style={{ width: numberWidth }} aria-hidden="true">
                {line.index + 1}
              </span>
              <span>{line.source ? <LineWithSource text={line.text} source={line.source} /> : line.text}</span>
            </div>
          ))}
          {visible.length === 0 && <p className="px-3 text-muted-foreground">没有匹配的行</p>}
        </div>
      </div>
      {(visible.length > shown.length || data.truncated > 0) && (
        <div className="flex items-center justify-between gap-2 border-t px-3 py-1 text-xs text-muted-foreground">
          {visible.length > shown.length ? (
            <button type="button" className="hover:text-foreground" onClick={() => setAll(true)}>
              显示全部（还有 {visible.length - shown.length} 行）
            </button>
          ) : (
            <span />
          )}
          {data.truncated > 0 && <span>后面还有 {data.truncated} 行没有显示</span>}
        </div>
      )}
    </BlockShell>
  )
}

function LineWithSource({ text, source }: { text: string; source: { path: string; line: number } }) {
  const target = useContext(AnswerContext)
  const file = useProjectFile(source.path)
  const at = text.indexOf(source.path)
  if (!file || !target || at < 0) return <>{text}</>
  const end = text.indexOf(String(source.line), at + source.path.length) + String(source.line).length
  return (
    <>
      {text.slice(0, at)}
      <button
        type="button"
        // primary-color-allow: 日志里能点开的源码位置，和回答里的文件引用同色
        className="text-primary hover:underline"
        title={`在文件面板打开 ${file.relative}:${source.line}`}
        onClick={() => openFilePreview(target.project, file.relative, source.line)}
        data-testid="log-source"
      >
        {text.slice(at, end)}
      </button>
      {text.slice(end)}
    </>
  )
}
