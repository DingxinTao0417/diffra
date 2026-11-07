import { useEffect, useMemo, useState } from 'react'
import type { StoredSessionSummary } from '@diffra/core/types'
import { ChevronDown, ChevronRight, Ellipsis, Folder, LoaderCircle, Plus, Search, Settings } from 'lucide-react'
import type { UpdateStatus } from '../../../../shared/ipc'
import { cn } from 'cn'
import { folderName, formatTime } from '@/lib/format'
import { openHome, openSettings, openTask } from '@/state/actions'
import { type AppState, store, useAppState } from '@/state/store'
import { TaskMenu } from './TaskMenu'

interface SidebarTask {
  sessionId: string
  cwd: string
  title: string
  updatedAt: string
  archived: boolean
}

// 侧栏的项目分组：有任务的项目按最近更新排，只选过还没建任务的项目排在后面
function groupTasks(projects: string[], tasks: StoredSessionSummary[], live: AppState['live']) {
  const all: SidebarTask[] = tasks.filter((task) => !task.archived)
  const known = new Set(tasks.map((task) => task.sessionId))
  // 刚建的任务在 core 存盘之前也要显示出来
  for (const task of Object.values(live)) {
    if (!known.has(task.sessionId) && task.turns.length > 0) {
      all.push({ sessionId: task.sessionId, cwd: task.project, title: task.title, updatedAt: new Date().toISOString(), archived: false })
    }
  }
  const byProject = new Map<string, SidebarTask[]>()
  for (const project of projects) byProject.set(project.toLowerCase(), [])
  for (const task of all) {
    const key = task.cwd.toLowerCase()
    if (!byProject.has(key)) byProject.set(key, [])
    byProject.get(key)?.push(task)
  }
  const pathOf = (key: string) => projects.find((project) => project.toLowerCase() === key) ?? all.find((task) => task.cwd.toLowerCase() === key)?.cwd ?? key
  return [...byProject.entries()]
    .map(([key, list]) => ({ path: pathOf(key), tasks: list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }))
    .sort((a, b) => (b.tasks[0]?.updatedAt ?? '').localeCompare(a.tasks[0]?.updatedAt ?? ''))
}

export function Sidebar() {
  const projects = useAppState((state) => state.projects)
  const tasks = useAppState((state) => state.tasks)
  const live = useAppState((state) => state.live)
  const route = useAppState((state) => state.route)
  const groups = useMemo(() => groupTasks(projects, tasks, live), [projects, tasks, live])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const activeSession = route.name === 'task' ? route.sessionId : null

  const toggle = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  return (
    <aside className="flex w-62 shrink-0 flex-col border-r border-sidebar-border bg-sidebar" data-testid="sidebar">
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <div className="flex size-5.5 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground">D</div>
        <span className="font-semibold">Diffra</span>
        <AppVersion />
      </div>

      <div className="space-y-0.5 px-2.5">
        <SidebarButton active={route.name === 'home'} onClick={() => openHome()}>
          <Plus className="size-4" />
          新任务
        </SidebarButton>
        <SidebarButton onClick={() => store.set((state) => ({ ...state, searchOpen: true }))}>
          <Search className="size-4" />
          <span className="flex-1">搜索</span>
          <span className="text-xs text-muted-foreground">Ctrl K</span>
        </SidebarButton>
      </div>

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">
        <div className="px-2 pb-1.5 text-xs text-muted-foreground">项目</div>
        {groups.length === 0 && <p className="px-2 text-xs text-muted-foreground">还没有项目。点「新任务」选择一个文件夹。</p>}
        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.path)
          return (
            <div key={group.path} className="space-y-px" data-testid="sidebar-project">
              <div className="group/project flex h-7.5 items-center gap-1.5 rounded-lg px-2 hover:bg-accent/60">
                <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={group.path} onClick={() => toggle(group.path)}>
                  {isCollapsed ? <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />}
                  <Folder className="size-3.5 shrink-0" />
                  <span className="truncate">{folderName(group.path)}</span>
                </button>
                <span className="text-xs text-muted-foreground group-hover/project:hidden">{group.tasks.length || ''}</span>
                <button
                  type="button"
                  aria-label={`在 ${folderName(group.path)} 新建任务`}
                  title="在这个项目新建任务"
                  className="hidden size-5 items-center justify-center rounded text-muted-foreground group-hover/project:flex hover:bg-accent"
                  onClick={() => openHome(group.path)}
                >
                  <Plus className="size-3.5" />
                </button>
              </div>
              {!isCollapsed && group.tasks.map((task) => <TaskRow key={task.sessionId} task={task} active={task.sessionId === activeSession} />)}
            </div>
          )
        })}
      </div>

      <div className="space-y-0.5 border-t border-sidebar-border px-2.5 py-2">
        <UpdateNotice />
        <SidebarButton active={route.name === 'settings'} onClick={() => openSettings()}>
          <Settings className="size-4" />
          设置
        </SidebarButton>
      </div>
    </aside>
  )
}

function SidebarButton({ active, onClick, children }: { active?: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('flex h-8.5 w-full items-center gap-2 rounded-lg px-2.5 text-left hover:bg-accent', active && 'bg-accent')}
    >
      {children}
    </button>
  )
}

function TaskRow({ task, active }: { task: SidebarTask; active: boolean }) {
  const running = useAppState((state) => state.live[task.sessionId]?.running ?? false)
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <div
      className={cn(
        'group/task flex h-7.5 items-center gap-1 rounded-lg pr-1 pl-8 text-foreground/85 hover:bg-accent/60',
        active && 'bg-soft font-medium text-foreground hover:bg-soft',
      )}
      data-testid="sidebar-task"
      onContextMenu={(event) => {
        event.preventDefault()
        setMenuOpen(true)
      }}
    >
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => void openTask(task)}>
        <span className="truncate">{task.title}</span>
      </button>
      {running ? (
        <LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary" aria-label="运行中" />
      ) : (
        <span className={cn('shrink-0 text-xs font-normal text-muted-foreground group-hover/task:hidden', menuOpen && 'hidden')}>
          {formatTime(task.updatedAt)}
        </span>
      )}
      <TaskMenu sessionId={task.sessionId} title={task.title} project={task.cwd} archived={task.archived} open={menuOpen} onOpenChange={setMenuOpen}>
        <button
          type="button"
          aria-label="任务菜单"
          className={cn(
            'size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent',
            menuOpen ? 'flex' : 'hidden group-hover/task:flex',
          )}
        >
          <Ellipsis className="size-3.5" />
        </button>
      </TaskMenu>
    </div>
  )
}

function AppVersion() {
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    window.diffra.getAppVersion().then(setVersion, (error: unknown) => console.error('读取版本号失败', error))
  }, [])
  if (!version) return null
  return (
    <span className="text-xs text-muted-foreground" data-testid="app-version">
      {version}
    </span>
  )
}

// 新版本下载好了才在侧栏提示；其他状态在「设置 → 更新与关于」里看
function UpdateNotice() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    const unsubscribe = window.diffra.onUpdateStatus(setStatus)
    window.diffra.getUpdateStatus().then(setStatus, (error: unknown) => console.error('读取更新状态失败', error))
    return unsubscribe
  }, [])
  if (status?.state !== 'downloaded') return null
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-primary hover:bg-accent"
      onClick={() => window.diffra.installUpdate().catch((error: unknown) => console.error('安装更新失败', error))}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-primary" />
      新版本 {status.version} 已下载，点击重启安装
    </button>
  )
}
