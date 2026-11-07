import { useState } from 'react'
import { ChevronDown, ChevronRight, Undo2 } from 'lucide-react'
import { cn } from 'cn'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DiffCounts } from '@/features/session/DiffView'
import { DiffLines } from '@/features/session/DiffLines'
import type { FileDiff } from '@/lib/unified-diff'
import type { LiveTask } from '@/state/store'
import { SidePanel } from './SidePanel'
import { type TaskDiff, useTaskDiff } from './useTaskDiff'

interface ReviewPanelProps {
  task: LiveTask
  onRestore(turnId: string): void
}

// 审阅从某一轮开始到现在的改动；「撤销这些改动」就是撤销到那一轮之前
export function ReviewPanel({ task, onRestore }: ReviewPanelProps) {
  const [since, setSince] = useState<string | null>(null)
  const sinceTurnId = since && task.turns.some((turn) => turn.id === since) ? since : (task.turns[0]?.id ?? null)
  const diff = useTaskDiff(task.sessionId, sinceTurnId, task.info.checkpoints, task.changeVersion)
  const files = diff?.state === 'ready' ? diff.files : []
  const added = files.reduce((sum, file) => sum + file.added, 0)
  const removed = files.reduce((sum, file) => sum + file.removed, 0)

  return (
    <SidePanel
      width="wide"
      testId="review-panel"
      title="审阅"
      controls={
        <>
          <select
            aria-label="审阅范围"
            className="h-7 min-w-0 rounded-md border bg-background px-2 text-sm"
            value={sinceTurnId ?? ''}
            onChange={(event) => setSince(event.target.value)}
          >
            {task.turns.map((turn, index) => (
              <option key={turn.id} value={turn.id}>
                {index === 0 ? `整个任务（${task.turns.length} 轮）` : `第 ${index + 1} 轮起`}
              </option>
            ))}
          </select>
          {diff?.state === 'ready' && (
            <span className="hidden shrink-0 items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground @lg:flex">
              {files.length} 个文件 <DiffCounts added={added} removed={removed} />
            </span>
          )}
        </>
      }
      actions={
        <Button
          size="sm"
          variant="ghost"
          title="撤销这些改动"
          className="text-destructive hover:bg-destructive-soft hover:text-destructive disabled:text-muted-foreground"
          disabled={task.running || files.length === 0 || !sinceTurnId}
          onClick={() => sinceTurnId && onRestore(sinceTurnId)}
        >
          <Undo2 />
          {/* 面板最窄时只留图标，可访问名称不变 */}
          <span className="sr-only @md:not-sr-only">撤销这些改动</span>
        </Button>
      }
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <ReviewBody task={task} diff={diff} files={files} />
      </div>
    </SidePanel>
  )
}

function ReviewBody({ task, diff, files }: { task: LiveTask; diff: TaskDiff | null; files: FileDiff[] }) {
  if (!task.info.checkpoints) return <p className="text-sm text-muted-foreground">检查点不可用（需要 Git），没法汇总改动。</p>
  if (task.turns.length === 0) return <p className="text-sm text-muted-foreground">任务还没开始。</p>
  if (!diff || diff.state === 'loading') return <p className="text-sm text-muted-foreground">正在读取改动…</p>
  if (diff.state === 'error') return <p className="text-sm text-destructive">{diff.message}</p>
  if (files.length === 0) return <p className="text-sm text-muted-foreground">这段时间没有文件改动。</p>
  return files.map((file) => <FileCard key={file.path} file={file} />)
}

const STATUS_BADGES: Record<FileDiff['status'], React.ReactNode> = {
  added: <Badge variant="success">新文件</Badge>,
  deleted: <Badge variant="destructive">已删除</Badge>,
  modified: null,
}

function FileCard({ file }: { file: FileDiff }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="overflow-hidden rounded-lg border" data-testid="review-file">
      <button
        type="button"
        className={cn('flex w-full items-center gap-2 bg-muted/50 px-2 py-1.5 text-left text-sm hover:bg-accent dark:bg-muted dark:hover:bg-accent', open && 'border-b')}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <span className="min-w-0 truncate font-mono text-xs">{file.path}</span>
        {STATUS_BADGES[file.status]}
        <span className="ml-auto">
          <DiffCounts added={file.added} removed={file.removed} />
        </span>
      </button>
      {open && (file.binary ? <p className="px-3 py-1.5 text-xs text-muted-foreground">二进制文件，不显示内容</p> : <DiffLines hunks={file.hunks} />)}
    </div>
  )
}
