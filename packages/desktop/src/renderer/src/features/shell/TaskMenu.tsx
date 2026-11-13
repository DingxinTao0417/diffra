import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { Archive, FolderCog, FolderOpen, Pencil, Trash2 } from 'lucide-react'
import type { TaskFolderState } from '../../../../shared/ipc'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { errorMessage } from '@/lib/errors'
import { deleteTask, renameTask, setArchived } from '@/state/actions'
import { showToast, useAppState } from '@/state/store'

interface TaskMenuProps {
  sessionId: string
  title: string
  project: string
  // 无项目任务：删除时可以连文件夹一起移到回收站
  noProject: boolean
  archived: boolean
  // 侧栏右键时由外面控制打开
  open?: boolean
  onOpenChange?(open: boolean): void
  align?: 'start' | 'end'
  // 任务页顶栏的菜单给：打开项目设置（检查命令、禁止修改的目录等）
  onProjectSettings?(): void
  children: ReactNode
}

export function TaskMenu({ sessionId, title, project, noProject, archived, open, onOpenChange, align = 'start', onProjectSettings, children }: TaskMenuProps) {
  const running = useAppState((state) => state.live[sessionId]?.running ?? false)
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)

  return (
    <>
      {/* 非模态：菜单关闭和对话框打开同时发生时，模态菜单会把页面留在不可点击的状态 */}
      <DropdownMenu modal={false} open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
        <DropdownMenuContent align={align} className="w-auto min-w-52">
          <DropdownMenuItem onSelect={() => setRenaming(true)}>
            <Pencil />
            重命名
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => window.diffra.openProjectFolder(project).catch((error: unknown) => showToast(errorMessage(error)))}
          >
            <FolderOpen />
            在资源管理器中打开
          </DropdownMenuItem>
          {onProjectSettings && (
            <DropdownMenuItem onSelect={onProjectSettings}>
              <FolderCog />
              项目设置
            </DropdownMenuItem>
          )}
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
          {deleting && (
            <DeleteForm
              sessionId={sessionId}
              title={title}
              folder={noProject ? project : null}
              onClose={() => setDeleting(false)}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

const FOLDER_NOTES: Record<TaskFolderState, string> = {
  empty: '它的文件夹是空的，会一起删掉。',
  nonEmpty: '任务文件夹默认保留。',
  missing: '文件夹已经不在了，只删记录。',
  shared: '文件夹还被其他任务使用，只删记录。',
  unknown: '没找到这个任务的文件夹记录，只删记录，文件夹保留。',
}

// folder：无项目任务的文件夹，项目任务为 null。文件夹是空的就一起删，不用问
function DeleteForm({ sessionId, title, folder, onClose }: { sessionId: string; title: string; folder: string | null; onClose(): void }) {
  const [folderState, setFolderState] = useState<TaskFolderState | null>(null)
  const [trashFolder, setTrashFolder] = useState(false)
  useEffect(() => {
    if (!folder) return
    let stale = false
    window.diffra.taskFolderState(sessionId).then(
      (state) => !stale && setFolderState(state),
      (error: unknown) => {
        console.error('读取任务文件夹失败', error)
        if (!stale) setFolderState('nonEmpty')
      },
    )
    return () => {
      stale = true
    }
  }, [folder, sessionId])
  const description = !folder
    ? `只删除「${title}」的对话记录，项目里的文件不受影响。删除后不能恢复。`
    : `删除「${title}」的对话记录，删除后不能恢复。${folderState ? FOLDER_NOTES[folderState] : ''}`
  return (
    <>
      <DialogHeader>
        <DialogTitle>删除任务记录？</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      {folder && folderState === 'nonEmpty' && (
        <div className="relative grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5">
          <Checkbox id={`${sessionId}-trash-folder`} aria-describedby={`${sessionId}-trash-folder-hint`} checked={trashFolder} onCheckedChange={(checked) => setTrashFolder(checked === true)} />
          <Label htmlFor={`${sessionId}-trash-folder`}>同时把文件夹移到回收站</Label>
          <p id={`${sessionId}-trash-folder-hint`} className="col-start-2 min-w-0 text-xs text-muted-foreground">
            <span className="block truncate font-mono" title={folder}>
              {folder}
            </span>
            检查点会一起删掉，文件夹可以从回收站找回。
          </p>
        </div>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button
          variant="destructive-solid"
          disabled={folder !== null && folderState === null}
          onClick={() => {
            onClose()
            void deleteTask(sessionId, trashFolder)
          }}
        >
          删除记录
        </Button>
      </DialogFooter>
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
      <DialogContent showCloseButton={false} className="sm:max-w-md">
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
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.select()
  }, [])
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const next = value.trim()
    if (!next) return
    onClose()
    if (next !== title) void onSave(next)
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <Input ref={inputRef} aria-label="任务名称" value={value} maxLength={100} autoFocus onChange={(event) => setValue(event.target.value)} />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button type="submit" disabled={!value.trim()}>
          保存
        </Button>
      </DialogFooter>
    </form>
  )
}
