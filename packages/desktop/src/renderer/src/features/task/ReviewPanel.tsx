import { useState } from 'react'
import { ChevronDown, ChevronRight, FileDiff as FileDiffIcon, GitBranch, Undo2 } from 'lucide-react'
import { cn } from 'cn'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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
          {task.turns.length > 1 && sinceTurnId ? (
            <Select value={sinceTurnId} onValueChange={setSince}>
              <SelectTrigger size="sm" aria-label="审阅范围" className="min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                {task.turns.map((turn, index) => (
                  <SelectItem key={turn.id} value={turn.id}>
                    {index === 0 ? `全部改动（${task.turns.length} 轮）` : `从第 ${index + 1} 轮起`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="shrink-0 text-sm text-muted-foreground">全部改动</span>
          )}
          {diff?.state === 'ready' && (
            <span className="hidden shrink-0 items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground @lg:flex">
              {files.length} 个文件 <DiffCounts added={added} removed={removed} />
            </span>
          )}
        </>
      }
      actions={
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground hover:bg-destructive-soft hover:text-destructive dark:hover:bg-destructive-soft"
              disabled={task.running || files.length === 0 || !sinceTurnId}
              onClick={() => sinceTurnId && onRestore(sinceTurnId)}
            >
              <Undo2 />
              {/* 面板最窄时只留图标，可访问名称不变 */}
              <span className="sr-only @md:not-sr-only">撤销这些改动</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>撤销这些改动</TooltipContent>
        </Tooltip>
      }
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <ReviewBody task={task} diff={diff} files={files} />
      </div>
    </SidePanel>
  )
}

function ReviewBody({ task, diff, files }: { task: LiveTask; diff: TaskDiff | null; files: FileDiff[] }) {
  if (!task.info.checkpoints) return <EmptyState icon={GitBranch} title="项目不是 Git 仓库，没法汇总改动和撤销" />
  if (task.turns.length === 0) return <EmptyState icon={FileDiffIcon} title="任务还没开始" />
  if (!diff || diff.state === 'loading') return <FileCardsSkeleton />
  if (diff.state === 'error') return <p className="text-sm text-destructive">{diff.message}</p>
  if (files.length === 0) return <EmptyState icon={FileDiffIcon} title="这段时间没有文件改动" description="智能体改过的文件会在这里逐个列出。" />
  return files.map((file) => <FileCard key={file.path} file={file} />)
}

// 只在第一次读取时出现；之后刷新都先显示旧数据
function FileCardsSkeleton() {
  return (
    <div role="status" aria-label="正在读取改动" className="space-y-3 motion-safe:animate-pulse">
      {[['w-40', 'w-3/4'], ['w-28', 'w-1/2'], ['w-48', 'w-2/3']].map(([path, line], index) => (
        <div key={index} aria-hidden className="overflow-hidden rounded-lg border">
          <div className="flex h-8 items-center gap-2 border-b bg-muted/50 px-2 dark:bg-muted">
            <div className="size-3.5 rounded-sm bg-muted-foreground/15" />
            <div className={cn('h-3 rounded-sm bg-muted-foreground/15', path)} />
            <div className="ml-auto h-3 w-10 rounded-sm bg-muted-foreground/15" />
          </div>
          <div className="space-y-2 px-3 py-3">
            <div className={cn('h-3 rounded-sm bg-muted', line)} />
            <div className="h-3 w-5/6 rounded-sm bg-muted" />
            <div className="h-3 w-2/5 rounded-sm bg-muted" />
          </div>
        </div>
      ))}
    </div>
  )
}

const STATUS_BADGES: Record<FileDiff['status'], React.ReactNode> = {
  added: <Badge variant="outline">新文件</Badge>,
  deleted: <Badge variant="outline">已删除</Badge>,
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
