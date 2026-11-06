import { type FormEvent, type ReactNode, useState } from 'react'
import { Archive, FolderOpen, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { errorMessage } from '@/lib/errors'
import { deleteTask, renameTask, setArchived } from '@/state/actions'
import { showToast, useAppState } from '@/state/store'

interface TaskMenuProps {
  sessionId: string
  title: string
  project: string
  archived: boolean
  // 侧栏右键时由外面控制打开
  open?: boolean
  onOpenChange?(open: boolean): void
  align?: 'start' | 'end'
  children: ReactNode
}

export function TaskMenu({ sessionId, title, project, archived, open, onOpenChange, align = 'start', children }: TaskMenuProps) {
  const running = useAppState((state) => state.live[sessionId]?.running ?? false)
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)

  return (
    <>
      {/* 非模态：菜单关闭和对话框打开同时发生时，模态菜单会把页面留在不可点击的状态 */}
      <DropdownMenu modal={false} open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
        <DropdownMenuContent align={align} className="w-52">
          <DropdownMenuItem onSelect={() => setRenaming(true)}>
            <Pencil />
            重命名
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => window.diffra.openProjectFolder(project).catch((error: unknown) => showToast(errorMessage(error)))}
          >
            <FolderOpen />
            在资源管理器中打开项目
          </DropdownMenuItem>
          <DropdownMenuItem disabled={running} onSelect={() => void setArchived(sessionId, !archived)}>
            <Archive />
            {archived ? '取消归档' : '归档'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" disabled={running} onSelect={() => setDeleting(true)}>
            <Trash2 />
            删除任务记录
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameDialog open={renaming} title={title} onClose={() => setRenaming(false)} onSave={(next) => renameTask(sessionId, next)} />
      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>删除任务记录？</DialogTitle>
            <DialogDescription>只删除「{title}」的对话记录，项目里的文件不受影响。删除后不能恢复。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setDeleting(false)
                void deleteTask(sessionId)
              }}
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

interface RenameDialogProps {
  open: boolean
  title: string
  onClose(): void
  onSave(title: string): Promise<void>
}

function RenameDialog({ open, title, onClose, onSave }: RenameDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>重命名任务</DialogTitle>
        </DialogHeader>
        {open && <RenameForm title={title} onClose={onClose} onSave={onSave} />}
      </DialogContent>
    </Dialog>
  )
}

function RenameForm({ title, onClose, onSave }: Omit<RenameDialogProps, 'open'>) {
  const [value, setValue] = useState(title)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const next = value.trim()
    if (!next) return
    onClose()
    if (next !== title) void onSave(next)
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <Input aria-label="任务名称" value={value} maxLength={100} autoFocus onChange={(event) => setValue(event.target.value)} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          取消
        </Button>
        <Button type="submit" disabled={!value.trim()}>
          保存
        </Button>
      </DialogFooter>
    </form>
  )
}
