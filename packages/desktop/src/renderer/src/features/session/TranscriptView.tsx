import type { StopReason } from '@diffra/core/types'
import { Check, LoaderCircle, Undo2, X } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { DiffView } from './DiffView'
import type { TranscriptItem, Turn } from './transcript'

const STOP_LABELS: Partial<Record<StopReason, string>> = {
  cancelled: '已停止',
  max_tokens: '上下文快用完了，已停止',
  max_turn_requests: '达到步数上限，已停止',
  refusal: '模型拒绝了这个任务',
}

interface TranscriptViewProps {
  turns: Turn[]
  projectPath: string
  running: boolean
  canRestore: boolean
  onRestore(turnId: string): void
}

export function TranscriptView({ turns, projectPath, running, canRestore, onRestore }: TranscriptViewProps) {
  return (
    <div className="space-y-6">
      {turns.map((turn, index) => {
        const active = running && index === turns.length - 1
        const stopLabel = turn.stopReason ? STOP_LABELS[turn.stopReason] : undefined
        return (
          <section key={turn.id} data-testid="turn" className="space-y-3">
            {turn.items.map((item) => (
              <TranscriptEntry key={item.id} item={item} projectPath={projectPath} />
            ))}
            {active && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" />
                进行中…
              </p>
            )}
            {stopLabel && <p className="text-sm text-muted-foreground">{stopLabel}</p>}
            {turn.error && <p className="text-sm text-destructive">{turn.error}</p>}
            {!active && canRestore && (
              <Button size="sm" variant="ghost" onClick={() => onRestore(turn.id)} disabled={running}>
                <Undo2 />
                撤销到这一轮之前
              </Button>
            )}
          </section>
        )
      })}
    </div>
  )
}

function TranscriptEntry({ item, projectPath }: { item: TranscriptItem; projectPath: string }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="rounded-lg bg-muted px-4 py-3 text-sm whitespace-pre-wrap" data-testid="user-message">
          {item.text}
        </div>
      )
    case 'agent':
      return (
        <div className="text-sm leading-relaxed whitespace-pre-wrap" data-testid="agent-message">
          {item.text}
        </div>
      )
    case 'thought':
      return (
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer select-none">思考过程</summary>
          <div className="mt-2 whitespace-pre-wrap">{item.text}</div>
        </details>
      )
    case 'notice':
      return (
        <Alert variant={item.severity === 'error' ? 'destructive' : 'default'} data-testid="notice">
          <AlertTitle>{item.title}</AlertTitle>
          {item.description && <AlertDescription className="whitespace-pre-wrap">{item.description}</AlertDescription>}
        </Alert>
      )
    case 'tool':
      return <ToolCallCard item={item} projectPath={projectPath} />
  }
}

function ToolCallCard({ item, projectPath }: { item: Extract<TranscriptItem, { kind: 'tool' }>; projectPath: string }) {
  const diffs = item.content.flatMap((content) => (content.type === 'diff' ? [content] : []))
  const texts = item.content.flatMap((content) =>
    content.type === 'content' && content.content.type === 'text' ? [content.content.text] : [],
  )
  return (
    <div className="rounded-lg border text-sm" data-testid="tool-call" data-status={item.status}>
      <details open={item.status === 'failed' || diffs.length > 0}>
        <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 select-none">
          <StatusIcon status={item.status} />
          <span className="truncate font-mono text-xs">{item.title}</span>
        </summary>
        <div className="space-y-2 border-t px-3 py-2">
          {diffs.map((diff) => (
            <DiffView key={diff.path} path={diff.path} oldText={diff.oldText ?? null} newText={diff.newText} projectPath={projectPath} />
          ))}
          {texts.map((text, index) => (
            <pre key={index} className="max-h-72 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">
              {text}
            </pre>
          ))}
          {diffs.length === 0 && texts.length === 0 && <p className="text-xs text-muted-foreground">没有输出</p>}
        </div>
      </details>
    </div>
  )
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'completed') return <Check className="size-4 shrink-0 text-green-600" />
  if (status === 'failed') return <X className="size-4 shrink-0 text-destructive" />
  return <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" />
}
