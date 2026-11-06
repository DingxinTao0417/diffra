import { useState } from 'react'
import type { CheckpointChange } from '@diffra/core/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const CHANGE_LABELS: Record<CheckpointChange['change'], string> = {
  added: '删除（这一轮之后新建的）',
  modified: '恢复原内容',
  deleted: '恢复（这一轮之后被删的）',
}

interface RestoreDialogProps {
  changes: CheckpointChange[] | null
  onCancel(): void
  onConfirm(): Promise<void>
}

export function RestoreDialog({ changes, onCancel, onConfirm }: RestoreDialogProps) {
  const [restoring, setRestoring] = useState(false)
  const confirm = async () => {
    setRestoring(true)
    try {
      await onConfirm()
    } finally {
      setRestoring(false)
    }
  }

  return (
    <Dialog open={changes !== null} onOpenChange={(open) => !open && !restoring && onCancel()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>撤销到这一轮之前</DialogTitle>
          <DialogDescription>
            这一轮以及之后所有轮次对文件的改动都会撤掉，包括这段时间里你手动改过的这些文件。
          </DialogDescription>
        </DialogHeader>
        {changes && changes.length === 0 ? (
          <p className="text-sm text-muted-foreground">这一轮之后没有文件改动，不需要撤销。</p>
        ) : (
          <ul className="max-h-72 space-y-1 overflow-auto text-sm" data-testid="restore-list">
            {changes?.map((change) => (
              <li key={change.path} className="flex justify-between gap-4">
                <span className="truncate font-mono text-xs">{change.path}</span>
                <span className="shrink-0 text-muted-foreground">{CHANGE_LABELS[change.change]}</span>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={restoring}>
            取消
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={restoring || changes?.length === 0}>
            {restoring ? '正在撤销…' : '确认撤销'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
