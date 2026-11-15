import { useContext, useMemo, useState } from 'react'
import type { TableData } from '@diffra/core/rich'
import { parseRichBlock } from '@diffra/core/rich'
import { ChevronDown, ChevronRight, GitBranch, Globe, Package, TriangleAlert } from 'lucide-react'
import { cn } from 'cn'
import { Badge } from '@/components/ui/badge'
import { formatBytes } from '@/lib/format'
import { parseLooseDiff } from '@/lib/unified-diff'
import { AnswerContext, LanguageBadge, openFilePreview, useProjectFile } from '../answer-links'
import { DataTableBlock } from '../rich/DataTableBlock'
import { DiffFileSection } from '../rich/DiffBlock'
import { JsonTree } from '../rich/JsonBlock'
import { LogBlock } from '../rich/LogBlock'
import { stripAnsi } from './ansi'
import type { BuildAsset, GitCommit, GitFileGroup, GitPush, GitStatus, HttpResponse, QueryTable } from './more-parsers'

// 第 657 步：git、构建产物、HTTP、数据库、日志的输出视图。都画在工具输出的框里，不再套卡片

// ---- git ----

const GROUPS: Array<{ group: GitFileGroup; label: string }> = [
  { group: 'conflict', label: '冲突' },
  { group: 'staged', label: '已暂存' },
  { group: 'unstaged', label: '未暂存' },
  { group: 'untracked', label: '未跟踪' },
]

export function GitStatusView({ status }: { status: GitStatus }) {
  return (
    <div className="bg-background py-1 text-xs" data-testid="git-status">
      <p className="flex items-center gap-1.5 px-2.5 pb-1">
        <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="font-mono">{status.branch ?? '（没有分支）'}</span>
        {status.ahead > 0 && <span className="text-muted-foreground tabular-nums">领先 {status.ahead}</span>}
        {status.behind > 0 && <span className="text-warning tabular-nums">落后 {status.behind}</span>}
        {status.files.length === 0 && <span className="text-muted-foreground">· 没有改动</span>}
      </p>
      {GROUPS.map(({ group, label }) => {
        const files = status.files.filter((file) => file.group === group)
        if (files.length === 0) return null
        return (
          <div key={group} className="mt-1" data-testid={`git-group-${group}`}>
            <p className={cn('px-2.5 py-0.5', group === 'conflict' ? 'font-bold text-destructive' : 'text-muted-foreground')}>
              {group === 'conflict' && <TriangleAlert className="mr-1 inline size-3.5 align-[-2px]" aria-hidden="true" />}
              {label} {files.length}
            </p>
            {files.map((file) => (
              <ProjectFileRow key={file.path} path={file.path} note={file.change} tone={group === 'conflict' ? 'text-destructive' : undefined} />
            ))}
          </div>
        )
      })}
    </div>
  )
}

// 一行文件：是项目里的文件就能点开
function ProjectFileRow({ path, note, tone }: { path: string; note?: string; tone?: string }) {
  const target = useContext(AnswerContext)
  const file = useProjectFile(path)
  const content = (
    <>
      <LanguageBadge path={path} />
      <span className={cn('min-w-0 truncate font-mono', tone)}>{path}</span>
      {note && <span className="ml-auto shrink-0 text-muted-foreground">{note}</span>}
    </>
  )
  if (!file || !target) return <div className="flex items-center gap-1.5 px-2.5 py-px pl-6">{content}</div>
  return (
    <button type="button" className="flex w-full items-center gap-1.5 px-2.5 py-px pl-6 text-left hover:bg-accent" title={`在文件面板打开 ${file.relative}`} onClick={() => openFilePreview(target.project, file.relative, null)}>
      {content}
    </button>
  )
}

export function GitLogView({ commits }: { commits: GitCommit[] }) {
  return (
    <ol className="bg-background py-1 text-xs" data-testid="git-log">
      {commits.map((commit) => (
        <li key={commit.hash} className="flex min-w-0 items-baseline gap-2 px-2.5 py-px">
          <span className="shrink-0 font-mono text-muted-foreground">{commit.hash.slice(0, 7)}</span>
          {commit.refs.map((ref) => (
            <Badge key={ref} variant="outline" className="shrink-0 font-mono">
              {ref.replace(/^HEAD -> /, '')}
            </Badge>
          ))}
          <span className="min-w-0 truncate">{commit.message}</span>
        </li>
      ))}
    </ol>
  )
}

export function GitPushView({ push }: { push: GitPush }) {
  return (
    <div className="bg-background px-2.5 py-1.5 text-xs" data-testid="git-push">
      {push.remote && <p className="truncate text-muted-foreground">推送到 {push.remote}</p>}
      {push.upToDate && <p>已经是最新的，没有要推送的提交</p>}
      {push.updates.map((update, index) => (
        <p key={index} className={cn('flex flex-wrap items-baseline gap-x-2', update.rejected && 'text-destructive')} data-rejected={update.rejected || undefined}>
          <span className="font-mono">
            {update.from} → {update.to}
          </span>
          {update.range && <span className="font-mono text-muted-foreground">{update.range}</span>}
          {update.forced && <span className="text-warning">强制推送</span>}
          {update.rejected && <span>被拒绝{update.reason ? `：${update.reason}` : ''}</span>}
          {!update.rejected && update.reason && <span className="text-muted-foreground">{update.reason}</span>}
        </p>
      ))}
    </div>
  )
}

export function GitDiffView({ diff }: { diff: string }) {
  const files = useMemo(() => parseLooseDiff(stripAnsi(diff)), [diff])
  return (
    <div className="flex flex-col divide-y bg-background" data-testid="git-diff">
      {files.map((file, index) => (
        <DiffFileSection key={index} file={file} single={false} defaultOpen={index < 3} />
      ))}
    </div>
  )
}

// ---- 构建产物 ----

const ASSET_PAGE = 15

export function BuildView({ assets }: { assets: BuildAsset[] }) {
  const [all, setAll] = useState(false)
  const sorted = useMemo(() => [...assets].sort((a, b) => b.size - a.size), [assets])
  const total = assets.reduce((sum, asset) => sum + asset.size, 0)
  const gzip = assets.every((asset) => asset.gzip !== null) ? assets.reduce((sum, asset) => sum + (asset.gzip ?? 0), 0) : null
  const max = sorted[0]?.size ?? 1
  const shown = all ? sorted : sorted.slice(0, ASSET_PAGE)
  return (
    <div className="border-b bg-background py-1 text-xs" data-testid="build-assets">
      <p className="flex items-center gap-1.5 px-2.5 pb-1 text-muted-foreground">
        <Package className="size-3.5 shrink-0" aria-hidden="true" />
        {assets.length} 个文件 · 合计 {formatBytes(total)}
        {gzip !== null && ` · gzip ${formatBytes(gzip)}`}
      </p>
      {shown.map((asset) => (
        <div key={asset.path} className="relative flex items-center gap-2 px-2.5 py-px" data-testid="build-asset">
          <span className="absolute inset-y-0.5 left-0 rounded-r-xs bg-chart-1/15" style={{ width: `${Math.max(1, (asset.size / max) * 100)}%` }} aria-hidden="true" />
          <span className="relative min-w-0 flex-1 truncate font-mono" title={asset.path}>
            {asset.path}
          </span>
          <span className="relative shrink-0 tabular-nums">{formatBytes(asset.size)}</span>
          {asset.gzip !== null && <span className="relative w-20 shrink-0 text-right text-muted-foreground tabular-nums">gzip {formatBytes(asset.gzip)}</span>}
        </div>
      ))}
      {sorted.length > shown.length && (
        <button type="button" className="px-2.5 py-0.5 text-muted-foreground hover:text-foreground" onClick={() => setAll(true)}>
          显示全部 {sorted.length} 个
        </button>
      )}
    </div>
  )
}

// ---- HTTP ----

function statusTone(status: number): string {
  if (status >= 500) return 'text-destructive'
  if (status >= 400) return 'text-warning'
  return 'text-foreground'
}

export function HttpView({ response }: { response: HttpResponse }) {
  const [headers, setHeaders] = useState(false)
  const json = useMemo(() => {
    const type = response.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? ''
    if (!/json/i.test(type) && !/^\s*[[{]/.test(response.body)) return undefined
    try {
      const value: unknown = JSON.parse(response.body)
      return value !== null && typeof value === 'object' ? value : undefined
    } catch {
      return undefined
    }
  }, [response])
  return (
    <div className="bg-background text-xs" data-testid="http-response">
      <p className="flex min-w-0 items-center gap-2 px-2.5 py-1">
        <Globe className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="shrink-0 font-mono font-bold">{response.method}</span>
        {response.url && <span className="min-w-0 truncate font-mono text-muted-foreground">{response.url}</span>}
        <span className={cn('ml-auto shrink-0 font-mono font-bold tabular-nums', statusTone(response.status))} data-testid="http-status">
          {response.status} {response.statusText}
        </span>
      </p>
      {response.headers.length > 0 && (
        <div className="border-t">
          <button type="button" aria-expanded={headers} className="flex w-full items-center gap-1 px-2.5 py-0.5 text-left text-muted-foreground hover:text-foreground" onClick={() => setHeaders(!headers)}>
            {headers ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            响应头 {response.headers.length}
          </button>
          {headers && (
            <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 px-2.5 pb-1 font-mono">
              {response.headers.map(([name, value], index) => (
                <div key={index} className="contents">
                  <dt className="text-muted-foreground">{name}</dt>
                  <dd className="min-w-0 break-all">{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
      {json !== undefined ? (
        <div className="border-t">
          <JsonTree value={json} source={response.body} bare />
        </div>
      ) : (
        response.body.trim() && <pre className="max-h-72 overflow-auto border-t p-2 font-mono whitespace-pre-wrap">{response.body}</pre>
      )}
    </div>
  )
}

// ---- 数据库 ----

export function QueryView({ table }: { table: QueryTable }) {
  const data = useMemo<TableData>(() => {
    const numeric = table.columns.map((_, index) => table.rows.length > 0 && table.rows.every((row) => row[index] === '' || /^-?\d+(?:\.\d+)?$/.test(row[index] ?? '')))
    return {
      columns: table.columns.map((label, index) => ({ key: `${index}`, label, align: numeric[index] ? 'right' : 'left', numeric: numeric[index] ?? false })),
      rows: table.rows.map((row) => row.map((cell, index) => (numeric[index] && cell !== '' ? Number(cell) : cell === 'NULL' ? null : cell))),
    }
  }, [table])
  return (
    <div className="bg-background text-xs" data-testid="query-result">
      {(table.sql || table.summary) && (
        <p className="flex min-w-0 items-center gap-2 border-b px-2.5 py-1">
          {table.sql && <code className="min-w-0 truncate font-mono text-muted-foreground">{table.sql}</code>}
          {table.summary && <span className="ml-auto shrink-0 text-muted-foreground">{table.summary}</span>}
        </p>
      )}
      <DataTableBlock data={data} bare />
    </div>
  )
}

// ---- 日志 ----

export function LogView({ text }: { text: string }) {
  const parsed = useMemo(() => parseRichBlock('log', stripAnsi(text)), [text])
  if (!parsed.ok) return null
  return (
    <div className="bg-background">
      <LogBlock data={parsed.data} bare />
    </div>
  )
}
