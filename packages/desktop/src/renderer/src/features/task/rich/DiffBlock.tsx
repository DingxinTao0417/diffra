import { useContext, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Copy, FileDiff, PanelRight } from 'lucide-react'
import { cn } from 'cn'
import { DiffCounts } from '@/features/session/DiffView'
import { DiffLines } from '@/features/session/DiffLines'
import { type LooseDiffFile, parseLooseDiff } from '@/lib/unified-diff'
import { store } from '@/state/store'
import { AnswerContext, LanguageBadge, openFilePreview, useProjectFile } from '../answer-links'
import { BlockShell, copyText, ShellAction } from './BlockShell'
import { CodeBlock } from './CodeBlock'
import type { FenceInfo } from './fence'

// 文件多、行多时只先展开第一个文件
const OPEN_ALL_LINES = 120

// 回答里的 ```diff：按文件分组的红绿改动，每个文件能收起；文件名是项目里的文件时点一下在文件面板打开，这个任务改过的还能看审阅。
// 流式输出时边写边画（解析便宜，不会闪回代码）；解析不出改动行就按普通代码显示
export function DiffBlock({ info }: { info: FenceInfo }) {
  const files = useMemo(() => parseLooseDiff(info.code), [info.code])
  const target = useContext(AnswerContext)
  const only = useProjectFile(files.length === 1 ? files[0]!.path : null)
  if (files.length === 0) return <CodeBlock info={info} />
  const added = files.reduce((total, file) => total + file.added, 0)
  const removed = files.reduce((total, file) => total + file.removed, 0)
  const lines = files.reduce((total, file) => total + file.hunks.reduce((sum, hunk) => sum + hunk.length, 0), 0)
  const body = (all: boolean) => (
    <div className="flex flex-col divide-y">
      {files.map((file, index) => (
        <DiffFileSection key={index} file={file} single={files.length === 1} defaultOpen={all || index === 0 || lines <= OPEN_ALL_LINES} />
      ))}
    </div>
  )
  return (
    <BlockShell
      testId="diff-block"
      kind="diff"
      icon={<FileDiff className="size-3.5 shrink-0" />}
      title={files.length === 1 && files[0]!.path ? <span className="font-mono">{files[0]!.path}</span> : `改动 · ${files.length} 个文件`}
      meta={<DiffCounts added={added} removed={removed} />}
      actions={
        <>
          {only && target && (
            <ShellAction label="在文件面板打开" onClick={() => openFilePreview(target.project, only.relative, files[0]!.hunks.flat().find((line) => line.newLine !== null)?.newLine ?? null)}>
              <PanelRight />
            </ShellAction>
          )}
          {only && target?.changed.has(only.relative) && (
            <ShellAction label="查看这个任务的改动" onClick={() => store.set((state) => ({ ...state, panel: 'review', reviewFile: only.relative }))}>
              <FileDiff />
            </ShellAction>
          )}
          <ShellAction label="复制补丁" onClick={() => copyText(info.code, '已复制补丁')}>
            <Copy />
          </ShellAction>
        </>
      }
      expand={() => body(true)}
    >
      <div className="bg-background">{body(false)}</div>
    </BlockShell>
  )
}

export function DiffFileSection({ file, single, defaultOpen }: { file: LooseDiffFile; single: boolean; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const target = useContext(AnswerContext)
  const resolved = useProjectFile(file.path)
  const firstLine = file.hunks.flat().find((line) => line.newLine !== null)?.newLine ?? null
  const hunks = <DiffLines hunks={file.hunks} className="max-h-96 overflow-y-auto" data-testid="diff-block-lines" />
  // 只有一个文件时顶栏已经写了文件名，不再画一行
  if (single) return hunks
  return (
    <div data-testid="diff-block-file">
      <div className="flex items-center gap-1 pr-1 text-xs">
        <button type="button" aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-left hover:bg-accent" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
          {file.path && <LanguageBadge path={file.path} />}
          <span className={cn('min-w-0 truncate', file.path ? 'font-mono' : 'text-muted-foreground')}>{file.path ?? '片段'}</span>
          <DiffCounts added={file.added} removed={file.removed} />
        </button>
        {resolved && target && (
          <ShellAction label="在文件面板打开" onClick={() => openFilePreview(target.project, resolved.relative, firstLine)}>
            <PanelRight />
          </ShellAction>
        )}
        {resolved && target?.changed.has(resolved.relative) && (
          <ShellAction label="查看这个任务的改动" onClick={() => store.set((state) => ({ ...state, panel: 'review', reviewFile: resolved.relative }))}>
            <FileDiff />
          </ShellAction>
        )}
      </div>
      {open && hunks}
    </div>
  )
}
