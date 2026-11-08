import { useEffect, useMemo, useState } from 'react'
import type { StoredSessionSummary } from '@diffra/core/types'
import { ChevronRight, CircleAlert, CirclePause, Ellipsis, Folder, FolderOpen, LoaderCircle, Plus, Search, Settings } from 'lucide-react'
import type { UpdateStatus } from '../../../../shared/ipc'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { errorMessage } from '@/lib/errors'
import { folderName, formatTime } from '@/lib/format'
import { turnVerdict, type VerdictTone } from '@/lib/turn-verdict'
import { openHome, openSettings, openTask, pickProject } from '@/state/actions'
import { type AppState, showToast, store, useAppState } from '@/state/store'
import { BrandMark } from './BrandMark'
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

const RECENT_TASK_LIMIT = 5

// 默认只显示最近几条；当前打开的任务再旧也要留着
function recentTasks(tasks: SidebarTask[], activeSession: string | null) {
  return tasks.filter((task, index) => index < RECENT_TASK_LIMIT || task.sessionId === activeSession)
}

function toggleProject(key: 'collapsedProjects' | 'expandedProjects', path: string) {
  store.set((state) => {
    const next = new Set(state[key])
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return { ...state, [key]: next }
  })
}

export function Sidebar() {
  const projects = useAppState((state) => state.projects)
  const tasks = useAppState((state) => state.tasks)
  const live = useAppState((state) => state.live)
  const route = useAppState((state) => state.route)
  const collapsed = useAppState((state) => state.collapsedProjects)
  const expanded = useAppState((state) => state.expandedProjects)
  const groups = useMemo(() => groupTasks(projects, tasks, live), [projects, tasks, live])
  const activeSession = route.name === 'task' ? route.sessionId : null

  return (
    <aside className="flex w-(--sidebar-w) shrink-0 flex-col bg-sidebar" data-testid="sidebar">
      <div className="flex h-10.5 items-center gap-2 px-4 pt-3 pb-2">
        <BrandMark className="size-5.5" />
        <span className="font-semibold">Diffra</span>
      </div>

      <div className="space-y-0.5 px-2">
        <SidebarButton onClick={() => openHome()}>
          <Plus className="size-4" />
          新任务
        </SidebarButton>
        <SidebarButton onClick={() => store.set((state) => ({ ...state, searchOpen: true }))}>
          <Search className="size-4" />
          <span className="flex-1">搜索</span>
          <Kbd>Ctrl+K</Kbd>
        </SidebarButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div className="mt-3 mb-1 px-2 text-xs text-muted-foreground">项目</div>
        {groups.length === 0 && (
          <Button variant="ghost" size="sm" className="w-full justify-start gap-2 px-2 text-muted-foreground hover:bg-accent dark:hover:bg-accent" onClick={openProjectFolder}>
            <FolderOpen className="size-4" />
            打开项目文件夹…
          </Button>
        )}
        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.path)
          const isExpanded = expanded.has(group.path)
          const hasTasks = group.tasks.length > 0
          const recent = recentTasks(group.tasks, activeSession)
          const hiddenCount = group.tasks.length - recent.length
          return (
            <div key={group.path} className="space-y-px" data-testid="sidebar-project">
              <div className="group/project relative flex h-7.5 items-center gap-2 rounded-lg px-2 hover:bg-accent">
                <span className="relative size-4 shrink-0">
                  <Folder
                    className={cn(
                      'size-4 transition-opacity',
                      hasTasks && 'group-hover/project:opacity-0 group-has-[:focus-visible]/project:opacity-0',
                    )}
                  />
                  {hasTasks && (
                    <ChevronRight
                      className={cn(
                        'absolute inset-0 size-4 text-muted-foreground opacity-0 transition-[opacity,rotate] group-hover/project:opacity-100 group-has-[:focus-visible]/project:opacity-100',
                        !isCollapsed && 'rotate-90',
                      )}
                    />
                  )}
                </span>
                <button
                  type="button"
                  className={rowButtonClass}
                  title={group.path}
                  aria-expanded={hasTasks ? !isCollapsed : undefined}
                  onClick={() => (hasTasks ? toggleProject('collapsedProjects', group.path) : openHome(group.path))}
                >
                  <span className="truncate">{folderName(group.path)}</span>
                </button>
                <span className={cn(trailingClass, 'group-hover/project:opacity-0 group-has-[:focus-visible]/project:opacity-0')}>
                  {group.tasks.length || ''}
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={`在 ${folderName(group.path)} 新建任务`}
                      className={cn(rowActionClass, 'group-hover/project:opacity-100 group-has-[:focus-visible]/project:opacity-100')}
                      onClick={() => openHome(group.path)}
                    >
                      <Plus className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>在这个项目新建任务</TooltipContent>
                </Tooltip>
              </div>
              {!isCollapsed && (isExpanded ? group.tasks : recent).map((task) => <TaskRow key={task.sessionId} task={task} active={task.sessionId === activeSession} />)}
              {!isCollapsed && hiddenCount > 0 && (
                <button
                  type="button"
                  className="flex h-7 w-full items-center rounded-lg pr-2 pl-8 text-left text-xs text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                  onClick={() => toggleProject('expandedProjects', group.path)}
                >
                  {isExpanded ? '收起' : `显示更多（${hiddenCount}）`}
                </button>
              )}
            </div>
          )
        })}
      </div>

      <div className="space-y-0.5 border-t border-sidebar-border px-2 py-2">
        <UpdateNotice />
        <SidebarButton active={route.name === 'settings'} onClick={() => openSettings()}>
          <Settings className="size-4" />
          设置
        </SidebarButton>
      </div>
    </aside>
  )
}

function openProjectFolder() {
  pickProject().then(
    (picked) => picked && openHome(picked),
    (error: unknown) => showToast(errorMessage(error)),
  )
}

// 主按钮用 after 伪元素铺满整行（行本身是 relative），整行可点，无障碍名字仍只有标题
const rowButtonClass =
  'flex min-w-0 flex-1 items-center text-left after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring'
// 时间、计数和悬停按钮叠在同一位置淡入淡出；悬停按钮不能 display:none，否则键盘 Tab 不到
const trailingClass = 'flex min-w-5 shrink-0 justify-end text-xs text-muted-foreground tabular-nums transition-opacity'
const rowActionClass =
  'absolute top-1/2 right-1 z-10 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100'

function SidebarButton({ active, onClick, children }: { active?: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('flex h-8.5 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-accent', active && 'bg-soft text-foreground hover:bg-soft')}
    >
      {children}
    </button>
  )
}

interface TaskStatus {
  label: string
  tone: Extract<VerdictTone, 'confirm' | 'error' | 'failed' | 'running' | 'blocked' | 'unfinished'> | 'unread'
}

// 只标需要留意的结论，多个同时成立时只显示一个：等待确认 > 出错 > 验证未通过 > 运行中 > 受阻 / 未完成 > 未读。
// 计划、压缩、深度扫描轮不改变结论，跑这些轮次时上一轮的出错和验证未通过照样标出来
function taskStatusOf(task: AppState['live'][string] | undefined): TaskStatus | null {
  if (!task) return null
  const { label, tone } = turnVerdict({ ...task, running: false })
  if (tone === 'confirm' || tone === 'error' || tone === 'failed') return { label, tone }
  if (task.running) return { label: turnVerdict(task).label, tone: 'running' }
  if (tone === 'blocked' || tone === 'unfinished') return { label, tone }
  return task.unread ? { label: `${label}（未读）`, tone: 'unread' } : null
}

// 和顶栏同一套图标。浅色下 warning 和 destructive 色相接近，等待确认用空心圈、受阻用暂停、未完成用感叹号，和出错的实心点靠形状区分
function TaskStatusMarker({ status: { label, tone } }: { status: TaskStatus }) {
  if (tone === 'running') return <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" aria-label={label} />
  const dot =
    tone === 'unfinished' || tone === 'blocked'
      ? null
      : {
          confirm: 'size-2 border-2 border-warning',
          error: 'size-2 bg-destructive',
          failed: 'size-2 bg-destructive',
          unread: 'size-1.5 bg-foreground',
        }[tone]
  const Icon = tone === 'blocked' ? CirclePause : CircleAlert
  return (
    <span role="img" aria-label={label} title={label} className="flex size-3.5 items-center justify-center">
      {dot ? <span className={cn('rounded-full', dot)} /> : <Icon className="size-3.5 text-warning" />}
    </span>
  )
}

function TaskRow({ task, active }: { task: SidebarTask; active: boolean }) {
  // 选整个任务对象再算：结论每次都是新对象，直接从 useSyncExternalStore 的选择器返回会反复重渲染
  const live = useAppState((state) => state.live[task.sessionId])
  const status = taskStatusOf(live)
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <div
      className={cn('group/task relative flex h-7.5 items-center gap-2 rounded-lg pr-2 pl-8 hover:bg-accent', active && 'bg-soft text-foreground hover:bg-soft')}
      data-testid="sidebar-task"
      onContextMenu={(event) => {
        event.preventDefault()
        setMenuOpen(true)
      }}
    >
      <button type="button" className={rowButtonClass} title={task.title} onClick={() => void openTask(task)}>
        <span className="truncate">{task.title}</span>
      </button>
      <span className={cn(trailingClass, 'group-hover/task:opacity-0 group-has-[:focus-visible]/task:opacity-0', menuOpen && 'opacity-0')}>
        {status ? <TaskStatusMarker status={status} /> : formatTime(task.updatedAt)}
      </span>
      <TaskMenu sessionId={task.sessionId} title={task.title} project={task.cwd} archived={task.archived} open={menuOpen} onOpenChange={setMenuOpen}>
        <button
          type="button"
          aria-label="任务菜单"
          className={cn(rowActionClass, 'group-hover/task:opacity-100 group-has-[:focus-visible]/task:opacity-100', menuOpen && 'opacity-100')}
        >
          <Ellipsis className="size-3.5" />
        </button>
      </TaskMenu>
    </div>
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
      // primary-color-allow: 下一步动作：重启安装新版本
      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-primary hover:bg-accent"
      onClick={() => window.diffra.installUpdate().catch((error: unknown) => console.error('安装更新失败', error))}
    >
      {/* primary-color-allow: 下一步动作：重启安装新版本 */}
      <span className="size-1.5 shrink-0 rounded-full bg-primary" />
      新版本 {status.version} 已下载，点击重启安装
    </button>
  )
}
