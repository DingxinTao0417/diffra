import { type FormEvent, useState } from 'react'
import type { SessionChecks } from '@diffra/core/types'
import { FolderOpen, Plus } from 'lucide-react'
import type { ProjectState, SessionHandle } from '../../../../shared/ipc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export interface ProjectSettingsInput {
  checks: SessionChecks
  readOnlyPaths: string[]
}

interface ProjectPanelProps {
  project: ProjectState
  session: SessionHandle | null
  running: boolean
  onPick(): void
  onSave(settings: ProjectSettingsInput): Promise<void>
  onNewSession(): void
}

export function ProjectPanel({ project, session, running, onPick, onSave, onNewSession }: ProjectPanelProps) {
  const [afterEdit, setAfterEdit] = useState(project.checks.afterEdit ?? '')
  const [beforeFinish, setBeforeFinish] = useState(project.checks.beforeFinish ?? '')
  const [readOnly, setReadOnly] = useState(project.readOnlyPaths.join(', '))
  const [saving, setSaving] = useState(false)

  const draft: ProjectSettingsInput = {
    checks: { afterEdit: afterEdit.trim() || null, beforeFinish: beforeFinish.trim() || null },
    readOnlyPaths: readOnly.split(/[,，\s]+/).filter(Boolean),
  }
  const dirty =
    draft.checks.afterEdit !== project.checks.afterEdit ||
    draft.checks.beforeFinish !== project.checks.beforeFinish ||
    draft.readOnlyPaths.join('\n') !== project.readOnlyPaths.join('\n')

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    try {
      await onSave(draft)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3 border-b px-6 py-4 text-sm">
      <div className="flex items-center gap-3">
        <span className="text-muted-foreground">项目</span>
        <span className="truncate font-mono text-xs" data-testid="project-path">
          {project.path}
        </span>
        <Button size="sm" variant="outline" onClick={onPick} disabled={running}>
          <FolderOpen />
          更换
        </Button>
        <Button size="sm" variant="outline" className="ml-auto" onClick={onNewSession} disabled={running}>
          <Plus />
          新会话
        </Button>
      </div>

      <form onSubmit={save} className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1 space-y-1">
          <Label htmlFor="check-after-edit">快速检查（每步改动后）</Label>
          <Input
            id="check-after-edit"
            placeholder="例如 pnpm typecheck；不填就不跑"
            value={afterEdit}
            onChange={(event) => setAfterEdit(event.target.value)}
          />
        </div>
        <div className="min-w-48 flex-1 space-y-1">
          <Label htmlFor="check-before-finish">完成检查（完成时）</Label>
          <Input
            id="check-before-finish"
            placeholder="例如 pnpm test；不填就用快速检查"
            value={beforeFinish}
            onChange={(event) => setBeforeFinish(event.target.value)}
          />
        </div>
        <div className="min-w-48 flex-1 space-y-1">
          <Label htmlFor="read-only-paths">禁止修改的目录</Label>
          <Input
            id="read-only-paths"
            placeholder="例如 data, uploads（相对项目根目录）"
            value={readOnly}
            onChange={(event) => setReadOnly(event.target.value)}
          />
        </div>
        <Button type="submit" size="sm" variant="secondary" disabled={!dirty || saving}>
          保存项目设置
        </Button>
      </form>

      {session && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" data-testid="session-info">
          <span>模型：{session.modelLabel}</span>
          {project.readOnlyPaths.length > 0 && <span>禁写：{project.readOnlyPaths.join(', ')}</span>}
          {session.info.rulePacks.length > 0 && <span>规范：{session.info.rulePacks.join('、')}</span>}
          <span>.env、私钥等密钥文件不会读进模型</span>
          {!session.info.bashPath && <span className="text-destructive">没找到 Git Bash，命令执行不可用</span>}
          {!session.info.checkpoints && <span className="text-destructive">检查点不可用（需要 Git），改动无法撤销</span>}
        </div>
      )}
    </div>
  )
}
