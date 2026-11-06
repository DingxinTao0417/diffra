import { type FormEvent, useState } from 'react'
import type { ProjectState } from '../../../../shared/ipc'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { errorMessage } from '@/lib/errors'
import { folderName } from '@/lib/format'

interface ProjectSettingsDialogProps {
  project: ProjectState | null
  open: boolean
  onClose(): void
  onSaved(project: ProjectState): void
}

export function ProjectSettingsDialog({ project, open, onClose, onSaved }: ProjectSettingsDialogProps) {
  return (
    <Dialog open={open && project !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>项目设置 · {project ? folderName(project.path) : ''}</DialogTitle>
          <DialogDescription>保存在 Diffra 里，不往项目仓库写文件。新建或重新打开的任务按新设置运行。</DialogDescription>
        </DialogHeader>
        {open && project && <ProjectSettingsForm project={project} onClose={onClose} onSaved={onSaved} />}
      </DialogContent>
    </Dialog>
  )
}

function ProjectSettingsForm({ project, onClose, onSaved }: Omit<ProjectSettingsDialogProps, 'open' | 'project'> & { project: ProjectState }) {
  const [afterEdit, setAfterEdit] = useState(project.checks.afterEdit ?? '')
  const [beforeFinish, setBeforeFinish] = useState(project.checks.beforeFinish ?? '')
  const [readOnly, setReadOnly] = useState(project.readOnlyPaths.join(', '))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const updated = await window.diffra.saveProject(project.path, {
        checks: { afterEdit: afterEdit.trim() || null, beforeFinish: beforeFinish.trim() || null },
        readOnlyPaths: readOnly.split(/[,，\s]+/).filter(Boolean),
      })
      onSaved(updated)
      onClose()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="check-after-edit">快速检查（每步改动后）</Label>
        <Input id="check-after-edit" placeholder="例如 pnpm typecheck；不填就不跑" value={afterEdit} onChange={(event) => setAfterEdit(event.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="check-before-finish">完成检查（完成时）</Label>
        <Input
          id="check-before-finish"
          placeholder="例如 pnpm test；不填就用快速检查"
          value={beforeFinish}
          onChange={(event) => setBeforeFinish(event.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="read-only-paths">禁止修改的目录</Label>
        <Input id="read-only-paths" placeholder="例如 data, uploads（相对项目根目录）" value={readOnly} onChange={(event) => setReadOnly(event.target.value)} />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          取消
        </Button>
        <Button type="submit" disabled={saving}>
          保存项目设置
        </Button>
      </DialogFooter>
    </form>
  )
}
