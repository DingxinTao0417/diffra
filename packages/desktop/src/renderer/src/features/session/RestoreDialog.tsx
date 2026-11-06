import { useState } from 'react'
import type { CheckpointChange } from '@diffra/core/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const CHANGE_LABELS: Record<CheckpointChange['change'], string> = {
  added: '删除（这一轮之后新建的）',
  modified: '恢复原内容',
  deleted: '恢复（这一轮之后被删的）',
}

const TEXTS = {
  restore: {
    title: '撤销到这一轮之前',
    description: '这一轮以及之后所有轮次对文件的改动都会撤掉，包括这段时间里你手动改过的这些文件。',
    confirm: '确认撤销',
    busy: '正在撤销…',
  },
  regenerate: {
    title: '重新生成这一轮',
    description: '先撤掉这一轮对文件的改动（包括这段时间里你手动改过的这些文件），再用同样的提问重新跑一遍。',
    confirm: '撤销并重新生成',
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
          <ul className="max-h-72 space-y-1 overflow-auto text-sm" data-testid="restore-list">
            {changes.map((change) => (
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
          <Button variant="destructive" onClick={confirm} disabled={restoring || changes === null || (mode === 'restore' && changes.length === 0)}>
            {restoring ? text.busy : text.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
