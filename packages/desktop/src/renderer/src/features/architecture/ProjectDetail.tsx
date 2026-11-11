import { useEffect, useMemo, useState } from 'react'
import { evaluateTarget } from '@diffra/core/architecture'
import { ArrowLeft, ChevronRight, CircleAlert, Ellipsis, FolderOpen, MessageSquarePlus, Network, RefreshCw, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { Segmented } from '@/components/ui/segmented'
import { errorMessage } from '@/lib/errors'
import { formatDuration, formatTime } from '@/lib/format'
import { navigate, openArchitecture, openHome, replaceRoute } from '@/state/actions'
import { type ArchitectureTab, showToast } from '@/state/store'
import { analyze, checkStale, interpret, loadBundle, useArchitecture } from './architecture-store'
import { ArchitectureContext, type ArchitectureContextValue, type ArchitectureRoute, type DiagramDraft, useArch } from './context'
import { ArchIndex, findBlock, parseScope, type Scope } from './graph'
import { ModuleTree } from './ModuleTree'
import { RunProgress } from './parts'
import { SidePanel } from './SidePanel'
import { SourcePeek } from './SourcePeek'
import { DependenciesView } from './views/DependenciesView'
import { DiagramView } from './views/DiagramView'
import { FlowsView } from './views/FlowsView'
import { HotspotsView } from './views/HotspotsView'
import { OverviewView } from './views/OverviewView'
import { TargetView } from './views/TargetView'

const TABS: Array<{ value: ArchitectureTab; label: string }> = [
  { value: 'diagram', label: '架构图' },
  { value: 'overview', label: '概览' },
  { value: 'dependencies', label: '依赖' },
  { value: 'flows', label: '流程' },
  { value: 'hotspots', label: '热点' },
  { value: 'target', label: '目标架构' },
]

// 左边的目录树只在按目录看的视图里出现；右边一栏一直在（选中东西时是详情，没选中时是概况）
const WITH_TREE = new Set<ArchitectureTab>(['dependencies', 'hotspots'])
const WITH_SIDE_PANEL = new Set<ArchitectureTab>(['diagram', 'dependencies', 'hotspots', 'target'])

export function ProjectDetail({ route, projectId }: { route: ArchitectureRoute; projectId: string }) {
  const bundle = useArchitecture((state) => state.bundles[projectId])
  const bundleError = useArchitecture((state) => state.bundleErrors[projectId])
  const summary = useArchitecture((state) => state.projects?.find((item) => item.id === projectId))
  const progress = useArchitecture((state) => state.running[projectId])
  const stale = useArchitecture((state) => state.stale[projectId])
  const failure = useArchitecture((state) => state.failures[projectId])
  const [peeking, setPeeking] = useState<{ path: string; line: number | null } | null>(null)
  const [draft, setDraft] = useState<DiagramDraft | null>(null)

  useEffect(() => {
    void loadBundle(projectId)
    void checkStale(projectId)
  }, [projectId])

  const analysis = bundle?.analysis ?? null
  const index = useMemo(() => (analysis ? new ArchIndex(analysis) : null), [analysis])
  const target = bundle?.target ?? null
  const evaluation = useMemo(() => (analysis && target ? evaluateTarget(analysis, target) : null), [analysis, target])

  const context = useMemo<ArchitectureContextValue | null>(() => {
    if (!bundle || !analysis || !index) return null
    return {
      project: bundle.project,
      analysis,
      index,
      interpretation: bundle.interpretation,
      diagrams: bundle.diagrams,
      target: bundle.target,
      evaluation,
      layout: bundle.layout,
      route,
      draft,
      setDraft,
      go: (change, record = true) => {
        const next = { ...route, ...change }
        if (record) navigate(next)
        else replaceRoute(next)
      },
      peek: (path, line) => setPeeking({ path, line: line ?? null }),
    }
  }, [bundle, analysis, index, evaluation, route, draft])

  const project = bundle?.project ?? summary
  const interpreting = progress?.phase === 'interpreting'
  const showBreadcrumb = (route.tab === 'dependencies' && route.section === 'graph') || route.tab === 'hotspots'

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="architecture-detail">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5">
        <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={() => openArchitecture(null)}>
          <ArrowLeft className="size-4" />
          架构
        </Button>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate font-semibold" data-testid="architecture-title">
              {project?.name ?? '项目'}
            </h1>
            {stale && <Badge variant="warning">代码已变，建议重新分析</Badge>}
          </div>
          <div className="truncate text-xs text-muted-foreground" title={project?.path}>
            {project?.path}
            {analysis && ` · ${formatTime(analysis.analyzedAt)} 分析，用了 ${formatDuration(analysis.durationMs)}${analysis.git.branch ? ` · ${analysis.git.branch}` : ''}`}
          </div>
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {progress ? (
            <div className="w-72">
              <RunProgress progress={progress} />
            </div>
          ) : (
            <>
              {failure && (
                <span className="flex max-w-64 items-center gap-1 truncate text-xs text-destructive" title={failure}>
                  <CircleAlert className="size-3.5 shrink-0" />
                  {failure}
                </span>
              )}
              <Button variant="outline" size="sm" onClick={() => void analyze(projectId)} data-testid="architecture-analyze">
                <RefreshCw className="size-3.5" />
                {analysis ? '重新分析' : '分析'}
              </Button>
              {analysis && (
                <Button variant="outline" size="sm" disabled={interpreting} onClick={() => void interpret(projectId)} data-testid="architecture-interpret" title="系统简介、关键流程和三张架构图各一次模型调用，并行做">
                  <Sparkles className="size-3.5" />
                  让模型画图和解读
                </Button>
              )}
            </>
          )}
          {project && <ProjectMenu path={project.path} />}
        </div>
      </div>

      {bundleError && !bundle && (
        <EmptyState icon={CircleAlert} title="读取分析结果失败" description={bundleError}>
          <Button size="sm" variant="outline" onClick={() => void loadBundle(projectId)}>
            重试
          </Button>
        </EmptyState>
      )}
      {bundle && !analysis && (
        <EmptyState icon={Network} title={progress ? '正在分析…' : '还没有分析'} description="在本机解析代码：列文件、读清单、解析每个文件的 import 和符号、对上依赖，再读最近半年的提交。代码不会离开这台电脑。">
          {!progress && (
            <Button size="sm" onClick={() => void analyze(projectId)}>
              <RefreshCw className="size-3.5" />
              开始分析
            </Button>
          )}
        </EmptyState>
      )}
      {context && (
        <ArchitectureContext.Provider value={context}>
          <div className="flex flex-wrap items-center gap-3 border-b px-4 py-2">
            <Segmented<ArchitectureTab>
              label="架构视图"
              size="sm"
              value={route.tab}
              options={TABS}
              onChange={(tab) => {
                if (draft?.dirty && tab !== 'diagram' && tab !== 'target') showToast('架构图有没保存的改动，切回去还在')
                context.go({ tab, focus: null })
              }}
            />
            {showBreadcrumb && <Breadcrumb />}
          </div>
          <div className="flex min-h-0 flex-1">
            {WITH_TREE.has(route.tab) && (
              <div className="w-60 shrink-0 border-r">
                <ModuleTree />
              </div>
            )}
            <div className="relative min-w-0 flex-1">
              {route.tab === 'diagram' && <DiagramView />}
              {route.tab === 'overview' && <OverviewView />}
              {route.tab === 'dependencies' && <DependenciesView />}
              {route.tab === 'flows' && <FlowsView />}
              {route.tab === 'hotspots' && <HotspotsView />}
              {route.tab === 'target' && <TargetView />}
            </div>
            {WITH_SIDE_PANEL.has(route.tab) && <SidePanel />}
          </div>
          {peeking && <SourcePeek path={peeking.path} line={peeking.line} onClose={() => setPeeking(null)} />}
        </ArchitectureContext.Provider>
      )}
    </div>
  )
}

function ProjectMenu({ path }: { path: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label="更多操作">
          <Ellipsis className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => openHome(path)}>
          <MessageSquarePlus className="size-4" />
          在这个项目开任务
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => window.diffra.openProjectFolder(path).catch((error: unknown) => showToast(errorMessage(error)))}>
          <FolderOpen className="size-4" />
          在资源管理器中打开
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// 范围的面包屑：系统 › 项目 › 方块或包、目录一级级 › 文件。被合并掉的单一子目录、项目根以上的目录不单独列
function Breadcrumb() {
  const { route, index, diagrams, go } = useArch()
  const crumbs = useMemo(() => {
    const items: Array<{ label: string; scope: Scope }> = [
      { label: '系统', scope: 'system' },
      { label: '项目', scope: 'project' },
    ]
    const { kind, path } = parseScope(route.scope)
    if (kind === 'block') {
      items.push({ label: findBlock(diagrams, path)?.name ?? '方块', scope: route.scope as Scope })
      return items
    }
    const target = kind === 'file' ? (index.file(path)?.module ?? '') : kind === 'dir' ? path : null
    if (target) {
      const root = index.projectRoot()
      const parts = target.split('/')
      for (let at = 1; at <= parts.length; at++) {
        const dir = parts.slice(0, at).join('/')
        if (root !== null && (root === dir || root.startsWith(`${dir}/`))) continue
        if (dir !== target && index.collapse(dir) !== dir) continue
        items.push({ label: index.packageByDir.get(dir)?.name ?? parts[at - 1]!, scope: `dir:${dir}` })
      }
    }
    if (kind === 'file') items.push({ label: path.split('/').pop() ?? path, scope: route.scope as Scope })
    return items
  }, [route.scope, index, diagrams])
  return (
    <nav aria-label="范围" className="flex min-w-0 flex-wrap items-center gap-0.5 text-sm" data-testid="architecture-breadcrumb">
      {crumbs.map((crumb, at) => (
        <span key={crumb.scope} className="flex items-center gap-0.5">
          {at > 0 && <ChevronRight className="size-3.5 text-muted-foreground" />}
          <button
            type="button"
            className={at === crumbs.length - 1 ? 'rounded px-1 font-medium' : 'rounded px-1 text-muted-foreground hover:bg-accent hover:text-foreground'}
            aria-current={at === crumbs.length - 1 ? 'page' : undefined}
            onClick={() => go({ scope: crumb.scope, focus: null })}
          >
            {crumb.label}
          </button>
        </span>
      ))}
    </nav>
  )
}
