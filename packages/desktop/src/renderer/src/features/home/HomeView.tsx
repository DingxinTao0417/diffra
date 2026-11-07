import { useEffect, useMemo, useState } from 'react'
import type { PromptImage } from '@diffra/core/types'
import { ChevronDown, Folder, FolderOpen, GitBranch, Settings2 } from 'lucide-react'
import type { ProjectState } from '../../../../shared/ipc'
import { modelDisplayName, type ModelRef, type SettingsView } from '../../../../shared/settings'
import { cn } from 'cn'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ProjectSettingsDialog } from '@/features/project/ProjectSettingsDialog'
import { checksSummary, useProject } from '@/features/project/useProject'
import { Composer } from '@/features/task/Composer'
import { errorMessage } from '@/lib/errors'
import { folderName, formatTime } from '@/lib/format'
import { openHome, openSettings, openTask, pickProject, setPermissionMode, startTask } from '@/state/actions'
import { showToast, useAppState } from '@/state/store'

const RECENT_LIMIT = 5

function modelLabelOf(settings: SettingsView | null, ref: ModelRef | null): string | null {
  if (!settings || !ref) return null
  const provider = settings.providers.find((item) => item.id === ref.providerId)
  const model = provider?.models.find((item) => item.id === ref.modelId && item.enabled !== false)
  return provider && model ? `${provider.name} / ${modelDisplayName(model)}` : null
}

export function HomeView({ projectPath }: { projectPath: string | null }) {
  const settings = useAppState((state) => state.settings)
  const projects = useAppState((state) => state.projects)
  const tasks = useAppState((state) => state.tasks)
  const { project, setProject, branch } = useProject(projectPath)
  const [model, setModel] = useState<ModelRef | null>(null)
  const [planMode, setPlanMode] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingProject, setEditingProject] = useState<{ detect: boolean } | null>(null)
  const detectedCount = useDetectedChecks(project)

  useEffect(() => setError(null), [projectPath])

  const recent = useMemo(
    () => [...tasks].filter((task) => !task.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, RECENT_LIMIT),
    [tasks],
  )
  const modelLabel = modelLabelOf(settings, model ?? settings?.roles.coder ?? null)
  const permissionMode = settings?.defaultPermissionMode ?? 'ask'

  const choose = async () => {
    try {
      const picked = await pickProject()
      if (picked) openHome(picked)
    } catch (caught) {
      showToast(errorMessage(caught))
    }
  }

  const send = async (text: string, extras: { goal: boolean; skills: string[]; images: PromptImage[] }) => {
    if (!projectPath) return false
    setError(null)
    try {
      await startTask(projectPath, text, { permissionMode, ...(model ? { model } : {}) }, { plan: planMode, ...extras })
      return true
    } catch (caught) {
      setError(errorMessage(caught))
      return false
    }
  }

  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-7 overflow-y-auto px-6 py-12">
      <div className="space-y-2 text-center">
        <h1 className="text-[2rem] font-semibold tracking-tight">要做什么？</h1>
        <p className="text-muted-foreground">描述任务，Diffra 会在项目里读代码、改代码、跑检查，做完给你看改动。</p>
      </div>

      <div className="w-full max-w-[720px] space-y-3">
        <Composer
          size="large"
          disabled={!projectPath}
          projectPath={projectPath}
          mcpTarget={projectPath ? { projectPath } : null}
          permissionMode={permissionMode}
          onPermissionModeChange={(mode) => void setPermissionMode(null, mode)}
          modelLabel={modelLabel}
          modelRef={model ?? settings?.roles.coder ?? undefined}
          onModelChange={setModel}
          planMode={planMode}
          onPlanModeChange={setPlanMode}
          onSend={send}
        />
        {error && (
          <div className="flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
            <span className="flex-1">{error}</span>
            <button type="button" className="shrink-0 underline underline-offset-2" onClick={() => openSettings('models')}>
              去设置模型
            </button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3.5 px-1.5 text-[0.93rem] text-muted-foreground">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-testid="project-path"
                title={projectPath ?? undefined}
                className={cn('flex h-7 items-center gap-1.5 rounded-lg bg-sidebar px-2 text-foreground/85 hover:bg-accent', !projectPath && 'text-primary')}
              >
                <Folder className="size-3.5" />
                {projectPath ? folderName(projectPath) : '选择项目'}
                <ChevronDown className="size-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              {projects.map((path) => (
                <DropdownMenuItem key={path} title={path} onSelect={() => openHome(path)}>
                  <Folder />
                  <span className="truncate">{folderName(path)}</span>
                </DropdownMenuItem>
              ))}
              {projects.length > 0 && <DropdownMenuSeparator />}
              <DropdownMenuItem onSelect={() => void choose()}>
                <FolderOpen />
                选择文件夹…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {branch && (
            <span className="flex items-center gap-1.5">
              <GitBranch className="size-3.5" />
              {branch}
            </span>
          )}
          {project && (
            <button
              type="button"
              className={cn('flex items-center gap-1.5 hover:text-foreground', detectedCount ? 'text-primary' : '')}
              onClick={() => setEditingProject({ detect: detectedCount !== null && detectedCount > 0 })}
            >
              <Settings2 className="size-3.5" />
              {detectedCount ? `检测到 ${detectedCount} 个检查命令` : checksSummary(project)}
            </button>
          )}
          {project && <span title="内置编码规范按项目语言全部生效，完成前按规范审查改动">规范：内置规则 · 完成前审查</span>}
        </div>
      </div>

      {recent.length > 0 && (
        <div className="w-full max-w-[720px] space-y-1">
          <div className="px-2 pb-1 text-xs text-muted-foreground">最近的任务</div>
          {recent.map((task) => (
            <button
              key={task.sessionId}
              type="button"
              className="flex w-full items-center gap-3 rounded-[10px] border border-border/70 px-3 py-2.5 text-left hover:bg-muted/60"
              onClick={() => void openTask(task)}
            >
              <span className="size-2 shrink-0 rounded-full bg-primary" />
              <span className="min-w-0 flex-1 truncate">{task.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{folderName(task.cwd)}</span>
              <span className="w-12 shrink-0 text-right text-xs text-muted-foreground">{formatTime(task.updatedAt)}</span>
            </button>
          ))}
        </div>
      )}

      <ProjectSettingsDialog
        project={project}
        open={editingProject !== null}
        detectOnOpen={editingProject?.detect}
        onClose={() => setEditingProject(null)}
        onSaved={setProject}
      />
    </div>
  )
}

// 项目还没配检查命令时，看看能识别出几个，在首页提示
function useDetectedChecks(project: ProjectState | null): number | null {
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => {
    setCount(null)
    if (!project || project.checks.afterEdit || project.checks.beforeFinish) return
    let stale = false
    window.diffra.detectChecks(project.path).then(
      (result) => !stale && setCount(result.checks.length),
      (error: unknown) => console.error('识别检查命令失败', error),
    )
    return () => {
      stale = true
    }
  }, [project])
  return count
}
