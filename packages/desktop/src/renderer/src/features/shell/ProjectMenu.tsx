import { type ReactNode, useState } from 'react'
import { Archive, FolderCog, FolderOpen, Plus, Trash2 } from 'lucide-react'
import type { ProjectState } from '../../../../shared/ipc'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ProjectSettingsDialog } from '@/features/project/ProjectSettingsDialog'
import { errorMessage } from '@/lib/errors'
import { deleteProject, openHome, setProjectArchived } from '@/state/actions'
import { showToast } from '@/state/store'

interface ProjectMenuProps {
  path: string
  name: string
  // 项目下的全部会话（包括已归档的），确认框据此写明影响范围
  sessionCount: number
  running: boolean
  children: ReactNode
}

// 侧栏项目右键菜单：保留新建任务、打开文件夹和项目设置，新增归档和删除；两个危险操作都先确认
export function ProjectMenu({ path, name, sessionCount, running, children }: ProjectMenuProps) {
  const [archiving, setArchiving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [project, setProject] = useState<ProjectState | null>(null)
  const [loadingSettings, setLoadingSettings] = useState(false)

  const openSettings = () => {
    setLoadingSettings(true)
    window.diffra.getProject(path).then(
      (next) => setProject(next),
      (error: unknown) => showToast(errorMessage(error)),
    ).finally(() => setLoadingSettings(false))
  }

  return (
    <>
      <ContextMenu modal={false}>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent className="min-w-48">
          <ContextMenuItem onSelect={() => openHome(path)}>
            <Plus />
            新建任务
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => window.diffra.openProjectFolder(path).catch((error: unknown) => showToast(errorMessage(error)))}>
            <FolderOpen />
            在资源管理器中打开
          </ContextMenuItem>
          <ContextMenuItem disabled={loadingSettings} onSelect={openSettings}>
            <FolderCog />
            项目设置
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={running} onSelect={() => setArchiving(true)}>
            <Archive />
            归档
          </ContextMenuItem>
          <ContextMenuItem
            disabled={running}
            className="text-destructive focus:bg-destructive-soft focus:text-destructive"
            onSelect={() => setDeleting(true)}
          >
            <Trash2 className="text-destructive" />
            删除
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <Dialog open={archiving} onOpenChange={setArchiving}>
        <DialogContent showCloseButton={false} data-testid="project-archive-dialog">
          <DialogHeader>
            <DialogTitle>归档项目？</DialogTitle>
            <DialogDescription>
              项目「{name}」下的 {sessionCount} 个会话会一起归档，项目和会话会从侧边栏隐藏；记录和磁盘上的项目文件夹都会保留。之后可以在「设置 → 会话与存储 → 已归档的项目」里恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setArchiving(false)}>
              取消
            </Button>
            <Button
              onClick={() => {
                setArchiving(false)
                void setProjectArchived(path, true)
              }}
            >
              归档项目
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent showCloseButton={false} data-testid="project-delete-dialog">
          <DialogHeader>
            <DialogTitle>删除项目？</DialogTitle>
            <DialogDescription>
              项目「{name}」和它下面的 {sessionCount} 个会话记录会被永久删除，不能恢复。磁盘上的项目文件夹「{path}」不会被删除。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(false)}>
              取消
            </Button>
            <Button
              variant="destructive-solid"
              onClick={() => {
                setDeleting(false)
                void deleteProject(path)
              }}
            >
              删除项目
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ProjectSettingsDialog project={project} open={project !== null} onClose={() => setProject(null)} onSaved={setProject} />
    </>
  )
}
