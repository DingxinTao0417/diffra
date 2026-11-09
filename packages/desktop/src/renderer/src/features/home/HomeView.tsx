import { useEffect, useMemo, useState } from 'react'
import { DESIGN_STYLES, type PromptImage, type StoredSessionSummary } from '@diffra/core/types'
import { Check, ChevronDown, CircleAlert, Folder, FolderDot, FolderOpen, GitBranch, LoaderCircle, Palette } from 'lucide-react'
import { decodeStartTaskError, type StartTaskErrorCode } from '../../../../shared/ipc'
import { modelDisplayName, type ModelRef, type SettingsView } from '../../../../shared/settings'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useProject } from '@/features/project/useProject'
import { Composer } from '@/features/task/Composer'
import { composerDraftKey } from '@/features/task/composer-drafts'
import { errorMessage } from '@/lib/errors'
import { folderName, formatTime } from '@/lib/format'
import { openDesign, openHome, openSettings, openTask, pickProject, setPermissionMode, startTask } from '@/state/actions'
import { type AppState, showToast, useAppState } from '@/state/store'

const chipClass = 'flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50'
const clickableChipClass = cn(chipClass, 'hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground')

function parentPath(path: string): string {
  return path.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '')
}

type ListedTask = Pick<StoredSessionSummary, 'sessionId' | 'cwd' | 'title' | 'updatedAt' | 'design' | 'noProject'>

// 设计首页列出全部未归档的设计任务；刚建的在 core 存盘之前也要列出来
function designTasksOf(tasks: StoredSessionSummary[], live: AppState['live']): ListedTask[] {
  const known = new Set(tasks.map((task) => task.sessionId))
  const pending = Object.values(live)
    .filter((task) => task.design && task.turns.length > 0 && !known.has(task.sessionId))
    .map((task) => ({ sessionId: task.sessionId, cwd: task.project, title: task.title, updatedAt: new Date().toISOString(), design: true, noProject: task.noProject }))
  return [...tasks.filter((task) => task.design && !task.archived), ...pending].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

function modelLabelOf(settings: SettingsView | null, ref: ModelRef | null): string | null {
  if (!settings || !ref) return null
  const provider = settings.providers.find((item) => item.id === ref.providerId)
  const model = provider?.models.find((item) => item.id === ref.modelId && item.enabled !== false)
  return provider && model ? `${provider.name} / ${modelDisplayName(model)}` : null
}

export function HomeView({ projectPath, design = false }: { projectPath: string | null; design?: boolean }) {
  const settings = useAppState((state) => state.settings)
  const projects = useAppState((state) => state.projects)
  const tasks = useAppState((state) => state.tasks)
  const live = useAppState((state) => (design ? state.live : null))
  const { branch } = useProject(projectPath)
  const [model, setModel] = useState<ModelRef | null>(null)
  const [planMode, setPlanMode] = useState(false)
  const [error, setError] = useState<{ code: StartTaskErrorCode; message: string } | null>(null)
  // 设计任务的风格预设；null 是「自动」，由模型按题材定
  const [designStyle, setDesignStyle] = useState<string | null>(null)

  useEffect(() => setError(null), [projectPath])

  // 只有设计首页列任务（设计任务），普通首页不列
  const listed = useMemo(() => (live ? designTasksOf(tasks, live) : []), [tasks, live])
  const openPage = design ? openDesign : openHome
  const draftKey = design ? composerDraftKey.design(projectPath) : composerDraftKey.home(projectPath)
  const modelLabel = modelLabelOf(settings, model ?? settings?.roles.coder ?? null)
  const permissionMode = settings?.defaultPermissionMode ?? 'ask'
  const workspacePath = settings?.defaultWorkspace.path

  const choose = async () => {
    try {
      const picked = await pickProject()
      if (picked) openPage(picked)
    } catch (caught) {
      showToast(errorMessage(caught))
    }
  }

  // 没选项目时建无项目任务，主进程在默认保存位置下替它建文件夹
  const send = async (text: string, extras: { goal: boolean; skills: string[]; images: PromptImage[] }) => {
    setError(null)
    try {
      const designOptions = design ? { design: true, ...(designStyle ? { designStyle } : {}) } : {}
      await startTask(projectPath, text, { permissionMode, ...(model ? { model } : {}), ...designOptions }, { plan: planMode, ...extras })
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
            title={workspacePath}
            className={cn(clickableChipClass, 'border border-dashed border-muted-foreground/40 px-[7px] text-sm')}
          >
            <FolderDot className="size-3.5" />
            无项目
            <ChevronDown className="size-3" />
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuItem title={workspacePath} onSelect={() => openPage(null)}>
          <FolderDot />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">无项目</span>
            <span className="truncate text-xs text-muted-foreground">{workspacePath ? `建在 ${workspacePath}` : '建在默认保存位置'}</span>
          </span>
          {/* primary-color-allow: 选中标记 */}
          {!projectPath && <Check className="text-primary" />}
        </DropdownMenuItem>
        {projects.map((path) => (
          <DropdownMenuItem key={path} title={path} onSelect={() => openPage(path)}>
            <Folder />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{folderName(path)}</span>
              <span className="truncate text-xs text-muted-foreground">{parentPath(path)}</span>
            </span>
            {/* primary-color-allow: 选中标记 */}
            {path === projectPath && <Check className="text-primary" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
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
        <h1 className="flex min-w-0 justify-center text-2xl font-bold tracking-tight">
          {projectPath ? (
            <>
              <span className="shrink-0">在</span>
              <span className="min-w-0 truncate px-[0.3em]">{folderName(projectPath)}</span>
              <span className="shrink-0">{design ? '里要设计什么？' : '里要做什么？'}</span>
            </>
          ) : design ? (
            '要设计什么？'
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
          key={draftKey}
          size="large"
          draftKey={draftKey}
          leading={projectPath ? null : projectMenu}
          projectPath={projectPath}
          mcpTarget={projectPath ? { projectPath } : { noProject: true }}
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
            {error.code === 'workspace-missing' && (
              <Button variant="outline" size="xs" className="shrink-0" onClick={() => openSettings('storage')}>
                去设置
              </Button>
            )}
          </div>
        )}
        {(projectPath || design) && (
          <div className="flex flex-wrap items-center gap-1 px-2.5 text-sm">
            {projectPath && projectMenu}
            {design && <DesignStyleMenu value={designStyle} onChange={setDesignStyle} />}
          </div>
        )}
      </div>

      {listed.length > 0 && (
        <div className="mt-7 w-full max-w-[720px]">
          <div className="px-3 pb-1 text-xs text-muted-foreground">设计任务</div>
          {listed.map((task) => (
            <TaskRow key={task.sessionId} task={task} />
          ))}
        </div>
      )}

    </div>
  )
}

// 设计首页的风格预设：选一套作为模型的起点，「自动」是不用预设
function DesignStyleMenu({ value, onChange }: { value: string | null; onChange(id: string | null): void }) {
  const selected = DESIGN_STYLES.find((style) => style.id === value) ?? null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="设计风格" data-testid="design-style" className={clickableChipClass}>
          <Palette className="size-3.5 shrink-0" />
          <span className="truncate">风格：{selected?.name ?? '自动'}</span>
          <ChevronDown className="size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuLabel className="text-xs text-muted-foreground">风格预设：作为起点，模型会按题材调整</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value ?? 'auto'} onValueChange={(next) => onChange(next === 'auto' ? null : next)}>
          <DropdownMenuRadioItem value="auto" className="items-start py-2">
            <span className="flex min-w-0 flex-col">
              <span>自动</span>
              <span className="text-xs text-muted-foreground">不用预设，模型按题材自己定风格</span>
            </span>
          </DropdownMenuRadioItem>
          {DESIGN_STYLES.map((style) => (
            <DropdownMenuRadioItem key={style.id} value={style.id} className="items-start py-2">
              <span className="flex min-w-0 flex-col gap-1">
                <span className="flex items-center gap-2">
                  {style.name}
                  <span className="flex overflow-hidden rounded-sm border" aria-hidden="true">
                    {style.swatches.map((color) => (
                      <span key={color} className="size-3" style={{ backgroundColor: color }} />
                    ))}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">{style.summary}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function TaskRow({ task }: { task: ListedTask }) {
  const running = useAppState((state) => state.live[task.sessionId]?.running ?? false)
  return (
    <button
      type="button"
      className="flex h-9 w-full items-center gap-2 rounded-md px-3 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
      onClick={() => void openTask(task)}
    >
      <span className="min-w-0 truncate">{task.title}</span>
      {running && <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="运行中" />}
      <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground" title={task.noProject ? task.cwd : undefined}>
        {task.noProject ? '无项目' : folderName(task.cwd)}
      </span>
      <span className="w-12 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{formatTime(task.updatedAt)}</span>
    </button>
  )
}
