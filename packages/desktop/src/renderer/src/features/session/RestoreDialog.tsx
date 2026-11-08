import { useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import type { CheckpointChange } from '@diffra/core/types'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const CHANGE_BADGES: Record<CheckpointChange['change'], React.ReactNode> = {
  added: <Badge variant="destructive">删除</Badge>,
  modified: <Badge variant="outline">还原</Badge>,
  deleted: <Badge variant="secondary">恢复</Badge>,
}

const TEXTS = {
  restore: {
    title: '撤销到这一轮之前',
    description: '这一轮以及之后所有轮次对文件的改动都会撤掉。',
    confirm: (count: number | null) => (count ? `撤销 ${count} 个文件` : '撤销'),
    busy: '正在撤销…',
  },
  regenerate: {
    title: '重新生成这一轮',
    description: '先撤掉这一轮对文件的改动，再用同样的提问重新跑一遍。',
    confirm: (count: number | null) => (count ? `撤销 ${count} 个文件并重新生成` : '撤销并重新生成'),
    busy: '正在撤销…',
  },
}

interface RestoreDialogProps {
  open: boolean
  // null 表示还在读受影响的文件
  changes: CheckpointChange[] | null
  mode?: keyof typeof TEXTS
  onCancel(): void
  onConfirm(): Promise<void>
}

export function RestoreDialog({ open, changes, mode = 'restore', onCancel, onConfirm }: RestoreDialogProps) {
  const [restoring, setRestoring] = useState(false)
  const text = TEXTS[mode]
  const confirm = async () => {
    setRestoring(true)
    try {
      await onConfirm()
    } finally {
      setRestoring(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !restoring && onCancel()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{text.title}</DialogTitle>
          <DialogDescription>{text.description}</DialogDescription>
        </DialogHeader>
        {changes === null ? (
          <p className="text-sm text-muted-foreground">正在列出受影响的文件…</p>
        ) : changes.length === 0 ? (
          <p className="text-sm text-muted-foreground">这一轮之后没有文件改动，不需要撤销。</p>
        ) : (
          <>
            <Alert className="border-transparent bg-warning-soft text-warning">
              <TriangleAlert />
              <AlertDescription className="text-foreground">这段时间里你手动改过的这些文件，改动也会一起撤掉。</AlertDescription>
            </Alert>
            <ul className="max-h-72 space-y-1 overflow-auto text-sm" data-testid="restore-list">
              {changes.map((change) => (
                <li key={change.path} className="flex items-center justify-between gap-4">
                  <span className="truncate font-mono text-xs">{change.path}</span>
                  {CHANGE_BADGES[change.change]}
                </li>
              ))}
            </ul>
          </>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={restoring}>
            取消
          </Button>
          <Button
            variant="destructive-solid"
            onClick={confirm}
            disabled={restoring || changes === null || (mode === 'restore' && changes.length === 0)}
            data-testid="restore-confirm"
          >
            {restoring ? text.busy : text.confirm(changes?.length ?? null)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
