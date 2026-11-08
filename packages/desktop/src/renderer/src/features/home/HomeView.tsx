import { useEffect, useMemo, useState } from 'react'
import type { PromptImage, StoredSessionSummary } from '@diffra/core/types'
import { Check, ChevronDown, CircleAlert, Folder, FolderOpen, GitBranch, LoaderCircle, ScrollText, Settings2 } from 'lucide-react'
import { decodeStartTaskError, type ProjectState, type StartTaskErrorCode } from '../../../../shared/ipc'
import { modelDisplayName, type ModelRef, type SettingsView } from '../../../../shared/settings'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ProjectSettingsDialog } from '@/features/project/ProjectSettingsDialog'
import { checksSummary, useProject } from '@/features/project/useProject'
import { Composer } from '@/features/task/Composer'
import { errorMessage } from '@/lib/errors'
import { folderName, formatTime } from '@/lib/format'
import { openHome, openSettings, openTask, pickProject, setPermissionMode, startTask } from '@/state/actions'
import { showToast, useAppState } from '@/state/store'

const RECENT_LIMIT = 5

const chipClass = 'flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50'
const clickableChipClass = cn(chipClass, 'hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground')

function parentPath(path: string): string {
  return path.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '')
}

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
  const [error, setError] = useState<{ code: StartTaskErrorCode; message: string } | null>(null)
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
    // 没选项目时先弹出选择框，草稿留在输入框里，选好再发
    if (!projectPath) {
      void choose()
      return false
    }
    setError(null)
    try {
      await startTask(projectPath, text, { permissionMode, ...(model ? { model } : {}) }, { plan: planMode, ...extras })
      return true
    } catch (caught) {
      setError(decodeStartTaskError(errorMessage(caught)))
      return false
    }
  }

  const projectMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {projectPath ? (
          <button type="button" data-testid="project-path" title={projectPath} className={clickableChipClass}>
            <Folder className="size-3.5 shrink-0" />
            <span className="truncate">{folderName(projectPath)}</span>
            {branch && (
              <>
                <GitBranch className="ml-1 size-3.5 shrink-0" />
                <span className="max-w-40 truncate">{branch}</span>
              </>
            )}
            <ChevronDown className="size-3 shrink-0" />
          </button>
        ) : (
          <button
            type="button"
            data-testid="project-path"
            className={cn(clickableChipClass, 'bg-primary/10 text-sm text-primary hover:bg-primary/15 hover:text-primary aria-expanded:bg-primary/15 aria-expanded:text-primary')}
          >
            <Folder className="size-3.5" />
            选择项目
            <ChevronDown className="size-3" />
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {projects.map((path) => (
          <DropdownMenuItem key={path} title={path} onSelect={() => openHome(path)}>
            <Folder />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{folderName(path)}</span>
              <span className="truncate text-xs text-muted-foreground">{parentPath(path)}</span>
            </span>
            {path === projectPath && <Check className="text-primary" />}
          </DropdownMenuItem>
        ))}
        {projects.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={() => void choose()}>
          <FolderOpen />
          选择文件夹…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <div className="relative flex h-full flex-col items-center overflow-y-auto px-6 pb-12">
      {/* 标题区向上长，输入框的位置不随提示条、错误条、最近任务出现而跳动 */}
      <div className="flex min-h-[36vh] w-full max-w-[720px] shrink-0 flex-col justify-end gap-5 pb-6">
        <h1 className="flex min-w-0 justify-center text-2xl font-semibold tracking-tight">
          {projectPath ? (
            <>
              <span className="shrink-0">在</span>
              <span className="min-w-0 truncate px-[0.3em]">{folderName(projectPath)}</span>
              <span className="shrink-0">里要做什么？</span>
            </>
          ) : (
            '要做什么？'
          )}
        </h1>
        {settings && !modelLabel && (
          <div className="flex items-center gap-2 rounded-lg bg-warning-soft py-1.5 pr-1.5 pl-3 text-sm" data-testid="model-missing">
            <CircleAlert className="size-4 shrink-0 text-warning" />
            <span className="flex-1">还没有配置模型</span>
            <Button variant="outline" size="xs" onClick={() => openSettings('models')}>
              去设置
            </Button>
          </div>
        )}
      </div>

      <div className="w-full max-w-[720px] space-y-3">
        <Composer
          size="large"
          leading={projectPath ? undefined : projectMenu}
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
          <div className="flex min-h-9 items-center gap-2 rounded-lg bg-destructive-soft py-1.5 pr-1.5 pl-3 text-sm" role="alert" data-testid="start-error">
            <CircleAlert className="size-4 shrink-0 text-destructive" />
            <span className="flex-1">{error.message}</span>
            {(error.code === 'model-missing' || error.code === 'model-auth') && (
              <Button variant="outline" size="xs" className="shrink-0" onClick={() => openSettings('models')}>
                去设置模型
              </Button>
            )}
          </div>
        )}
        {projectPath && (
          <div className="flex flex-wrap items-center gap-1 px-2.5 text-sm">
            {projectMenu}
            {project && (
              <button
                type="button"
                className={cn(clickableChipClass, detectedCount ? 'text-primary hover:text-primary' : '')}
                onClick={() => setEditingProject({ detect: detectedCount !== null && detectedCount > 0 })}
              >
                <span className="relative flex shrink-0">
                  <Settings2 className="size-3.5" />
                  {detectedCount ? <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-primary" /> : null}
                </span>
                <span className="truncate">{detectedCount ? `检测到 ${detectedCount} 个检查命令` : checksSummary(project)}</span>
              </button>
            )}
            {project && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0} className={cn(chipClass, 'cursor-default')}>
                    <ScrollText className="size-3.5 shrink-0" />
                    <span className="truncate">规范：内置规则 · 完成前审查</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent>内置编码规范按项目语言全部生效，完成前按规范审查改动</TooltipContent>
              </Tooltip>
            )}
          </div>
        )}
      </div>

      {recent.length > 0 && (
        <div className="mt-7 w-full max-w-[720px]">
          <div className="px-3 pb-1 text-xs text-muted-foreground">最近的任务</div>
          {recent.map((task) => (
            <RecentTaskRow key={task.sessionId} task={task} />
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

function RecentTaskRow({ task }: { task: StoredSessionSummary }) {
  const running = useAppState((state) => state.live[task.sessionId]?.running ?? false)
  return (
    <button
      type="button"
      className="flex h-9 w-full items-center gap-2 rounded-md px-3 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
      onClick={() => void openTask(task)}
    >
      <span className="min-w-0 truncate">{task.title}</span>
      {running && <LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary" aria-label="运行中" />}
      <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">{folderName(task.cwd)}</span>
      <span className="w-12 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{formatTime(task.updatedAt)}</span>
    </button>
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
