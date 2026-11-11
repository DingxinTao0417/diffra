import { useEffect, useMemo } from 'react'
import type { ArchitectureProjectSummary } from '@diffra/core/architecture'
import { CircleAlert, Ellipsis, FolderOpen, MessageSquarePlus, Network, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { errorMessage } from '@/lib/errors'
import { folderName, formatTime } from '@/lib/format'
import { openArchitecture, openHome } from '@/state/actions'
import { showToast, useAppState } from '@/state/store'
import { addProject, analyze, checkStale, removeProject, useArchitecture } from './architecture-store'
import { formatCount } from './graph'
import { LanguageBar, RunProgress, Thumbnail } from './parts'

const samePath = (a: string, b: string) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

// 架构的主界面：每个项目一张卡片，点进去看分析
export function ProjectCards() {
  const projects = useArchitecture((state) => state.projects)
  const listError = useArchitecture((state) => state.listError)
  const recent = useAppState((state) => state.projects)
  const suggestions = useMemo(() => recent.filter((path) => !(projects ?? []).some((project) => samePath(project.path, path))).slice(0, 6), [recent, projects])

  // 打开卡片页时在后台判断每个项目的分析是否过期，不挡着卡片显示
  useEffect(() => {
    for (const project of projects ?? []) if (project.analysis) void checkStale(project.id)
  }, [projects?.length])

  const add = async (path: string | null) => {
    const id = await addProject(path)
    if (id) void analyze(id)
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto" data-testid="architecture-view">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-6 py-8">
        <div className="flex flex-wrap items-center gap-3">
          <Network className="size-5 text-muted-foreground" />
          <h1 className="text-lg font-bold">架构</h1>
          <span className="text-sm text-muted-foreground">拆解项目的代码结构：包、模块、依赖、分层和关键流程，再对照你定的目标架构</span>
          <Button className="ml-auto" size="sm" onClick={() => void add(null)}>
            <Plus className="size-4" />
            添加项目
          </Button>
        </div>
        {listError && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive-soft px-3 py-2 text-sm">
            <CircleAlert className="size-4 text-destructive" />
            读取架构列表失败：{listError}
          </div>
        )}
        {projects !== null && projects.length === 0 && (
          <EmptyState icon={Network} title="还没有项目" description="添加一个项目文件夹，Diffra 会在本机解析它的代码结构；之后可以让模型解读，再设计目标架构。">
            <Button size="sm" onClick={() => void add(null)}>
              <Plus className="size-4" />
              选择文件夹
            </Button>
          </EmptyState>
        )}
        {projects !== null && projects.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="architecture-cards">
            {projects.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
            <button
              type="button"
              className="flex min-h-56 flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => void add(null)}
            >
              <Plus className="size-5" />
              添加项目文件夹
            </button>
          </div>
        )}
        {suggestions.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground">最近在 Diffra 里用过的项目</div>
            <div className="flex flex-wrap gap-2">
              {suggestions.map((path) => (
                <Button key={path} variant="outline" size="sm" title={path} onClick={() => void add(path)}>
                  <Plus className="size-3.5" />
                  {folderName(path)}
                </Button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ProjectCard({ project }: { project: ArchitectureProjectSummary }) {
  const progress = useArchitecture((state) => state.running[project.id])
  const stale = useArchitecture((state) => state.stale[project.id])
  const failure = useArchitecture((state) => state.failures[project.id])
  const digest = project.analysis
  const open = () => openArchitecture(project.id)

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`打开「${project.name}」的架构`}
      className="group flex cursor-pointer flex-col overflow-hidden rounded-xl border bg-card text-left transition-shadow hover:shadow-overlay focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      onClick={open}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          open()
        }
      }}
      data-testid="architecture-card"
    >
      <div className="relative h-32 border-b bg-muted/40">
        {project.thumbnail ? (
          <Thumbnail thumbnail={project.thumbnail} />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">{progress ? '正在分析…' : '还没有分析'}</div>
        )}
        <div className="absolute top-2 right-2 flex gap-1">
          {project.interpretedAt && (
            <Badge variant="secondary" className="gap-1">
              <Sparkles className="size-3" />
              已解读
            </Badge>
          )}
          {stale && <Badge variant="warning">代码已变</Badge>}
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{project.name}</div>
            <div className="truncate text-xs text-muted-foreground" title={project.path}>
              {project.path}
            </div>
          </div>
          <CardMenu project={project} />
        </div>
        {!project.exists && (
          <div className="flex items-center gap-1.5 text-xs text-destructive">
            <CircleAlert className="size-3.5" />
            文件夹不在了，可能被移走或删掉
          </div>
        )}
        {digest && (
          <>
            <LanguageBar languages={digest.languages} limit={3} />
            <div className="grid grid-cols-4 gap-2 text-center">
              <Stat label="文件" value={formatCount(digest.files)} />
              <Stat label="代码行" value={formatCount(digest.lines)} />
              <Stat label={digest.packages > 1 ? '包' : '目录'} value={String(digest.packages > 1 ? digest.packages : digest.modules)} />
              <Stat label="循环依赖" value={String(digest.cycles)} warn={digest.cycles > 0} />
            </div>
          </>
        )}
        <div className="mt-auto space-y-2">
          {project.target ? (
            <div className="text-xs">
              目标架构：
              {project.target.violations > 0 ? <span className="text-destructive">{project.target.violations} 处违规</span> : <span>没有违规</span>}
              <span className="text-muted-foreground"> · 差距 {project.target.gaps} 处</span>
            </div>
          ) : (
            digest && <div className="text-xs text-muted-foreground">还没有目标架构</div>
          )}
          {failure && !progress && <div className="line-clamp-2 text-xs text-destructive">{failure}</div>}
          {progress ? (
            <div onClick={(event) => event.stopPropagation()}>
              <RunProgress progress={progress} />
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{digest ? `${formatTime(digest.analyzedAt)} 分析` : ''}</span>
              <Button
                variant={digest ? 'ghost' : 'outline'}
                size="xs"
                className="ml-auto"
                disabled={!project.exists}
                onClick={(event) => {
                  event.stopPropagation()
                  void analyze(project.id)
                }}
              >
                <RefreshCw className="size-3" />
                {digest ? '重新分析' : '分析'}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <div className={warn ? 'text-sm font-semibold text-warning tabular-nums' : 'text-sm font-semibold tabular-nums'}>{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  )
}

function CardMenu({ project }: { project: ArchitectureProjectSummary }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label="更多操作" onClick={(event) => event.stopPropagation()}>
          <Ellipsis className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        <DropdownMenuItem disabled={!project.exists} onSelect={() => openHome(project.path)}>
          <MessageSquarePlus className="size-4" />
          在这个项目开任务
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!project.exists}
          onSelect={() => window.diffra.openProjectFolder(project.path).catch((error: unknown) => showToast(errorMessage(error)))}
        >
          <FolderOpen className="size-4" />
          在资源管理器中打开
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => void removeProject(project.id)}>
          <Trash2 className="size-4" />
          从列表移除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
