import { type KeyboardEvent, useEffect, useId, useMemo, useState } from 'react'
import type { StoredSessionSummary } from '@diffra/core/types'
import { ChevronRight, CircleAlert, CirclePause, Ellipsis, Folder, FolderDot, FolderOpen, ListTodo, LoaderCircle, MonitorSmartphone, Network, PenTool, Plus, Search, Settings } from 'lucide-react'
import type { UpdateStatus } from '../../../../shared/ipc'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { ResizeHandle } from '@/components/ui/resize-handle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { errorMessage } from '@/lib/errors'
import { folderName, formatTime } from '@/lib/format'
import { remPx } from '@/lib/shell'
import { turnVerdict, type VerdictTone } from '@/lib/turn-verdict'
import { isDue } from '@/lib/todo-time'
import { useNow } from '@/lib/use-now'
import { loadTodos, navigate, openArchitecture, openDesign, openHome, openSettings, openTask, openTodos, pickProject, saveLayout, setLayout } from '@/state/actions'
import { type AppState, showToast, store, useAppState } from '@/state/store'
import { type RemoteProjectGroup, useRemoteProjects } from '@/features/devices/remote-projects'
import { RemoteNewTaskDialog } from '@/features/devices/RemoteNewTaskDialog'
import { BrandMark } from './BrandMark'
import { highlightMatch } from './SearchDialog'
import { SidebarFooter } from './SidebarFooter'
import { type SearchItem, searchItemKey, useSessionSearch } from './session-search'
import { TaskMenu } from './TaskMenu'

interface SidebarTask {
  sessionId: string
  cwd: string
  title: string
  updatedAt: string
  archived: boolean
  design: boolean
  noProject: boolean
}

// 无项目任务都归到这一组；真实路径小写后不会是这个值
const NO_PROJECT_KEY = '<no-project>'

// 侧栏宽度的上下限，右边主区至少留 MAIN_MIN_REM
const SIDEBAR_MIN_REM = 13
const SIDEBAR_MAX_REM = 32
const MAIN_MIN_REM = 30

// 侧栏的项目分组：有任务的项目按最近更新排，只选过还没建任务的项目排在后面。
// 无项目任务按标记归到「无项目」一组（path 为 null），和其他项目一起按最近更新排
function groupTasks(projects: string[], tasks: StoredSessionSummary[], live: AppState['live']) {
  const all: SidebarTask[] = tasks.filter((task) => !task.archived)
  const known = new Set(tasks.map((task) => task.sessionId))
  // 刚建的任务在 core 存盘之前也要显示出来
  for (const task of Object.values(live)) {
    if (!known.has(task.sessionId) && task.turns.length > 0) {
      all.push({ sessionId: task.sessionId, cwd: task.project, title: task.title, updatedAt: new Date().toISOString(), archived: false, design: task.design, noProject: task.noProject })
    }
  }
  const byProject = new Map<string, SidebarTask[]>()
  for (const project of projects) byProject.set(project.toLowerCase(), [])
  for (const task of all) {
    const key = task.noProject ? NO_PROJECT_KEY : task.cwd.toLowerCase()
    if (!byProject.has(key)) byProject.set(key, [])
    byProject.get(key)?.push(task)
  }
  // 无项目任务的文件夹被当成项目打开过、又没有项目任务时不单列，免得和「无项目」分组重复
  const noProjectDirs = new Set(all.filter((task) => task.noProject).map((task) => task.cwd.toLowerCase()))
  const pathOf = (key: string) => projects.find((project) => project.toLowerCase() === key) ?? all.find((task) => task.cwd.toLowerCase() === key)?.cwd ?? key
  return [...byProject.entries()]
    .filter(([key, list]) => list.length > 0 || !noProjectDirs.has(key))
    .map(([key, list]) => ({ key, path: key === NO_PROJECT_KEY ? null : pathOf(key), tasks: list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }))
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
  const workspacePath = useAppState((state) => state.settings?.defaultWorkspace.path)
  const groups = useMemo(() => groupTasks(projects, tasks, live), [projects, tasks, live])
  const remoteGroups = useRemoteProjects()
  const activeSession = route.name === 'task' ? route.sessionId : null
  const todos = useAppState((state) => state.todos)
  const openTodoCount = useMemo(() => todos?.filter((todo) => !todo.done).length ?? 0, [todos])
  // 到了时间还没勾掉的，侧栏上多一个点
  const now = useNow(60_000)
  const dueTodoCount = todos?.filter((todo) => isDue(todo, now)).length ?? 0
  // 侧栏要显示没做完的条数，启动时就读一次
  useEffect(() => {
    if (store.get().todos === null) void loadTodos()
  }, [])

  return (
    <aside className="relative flex w-(--sidebar-w) shrink-0 flex-col bg-sidebar" data-testid="sidebar">
      {/* 宽度写在根元素的 --sidebar-w 上（App 里），设置页的分区导航跟着一起变 */}
      <ResizeHandle
        orientation="vertical"
        grow={1}
        label="拖动调整侧栏宽度"
        className="absolute inset-y-0 -right-1"
        measure={(handle) => {
          const min = remPx(SIDEBAR_MIN_REM)
          return { size: handle.parentElement!.getBoundingClientRect().width, min, max: Math.max(min, Math.min(remPx(SIDEBAR_MAX_REM), window.innerWidth - remPx(MAIN_MIN_REM))) }
        }}
        onResize={(size) => setLayout({ sidebarWidth: size })}
        onCommit={(size) => void saveLayout({ sidebarWidth: size })}
        onReset={() => void saveLayout({ sidebarWidth: null })}
      />
      <div className="flex h-10.5 items-center gap-2 px-4 pt-3 pb-2">
        <BrandMark className="size-5.5" />
        <span className="font-semibold">Diffra</span>
      </div>

      <div className="space-y-0.5 px-2">
        <SidebarSearch />
        <SidebarButton onClick={() => openHome()}>
          <Plus className="size-4" />
          新任务
        </SidebarButton>
        <SidebarButton active={route.name === 'design'} onClick={() => openDesign()}>
          <PenTool className="size-4" />
          设计
        </SidebarButton>
        <SidebarButton active={route.name === 'architecture'} onClick={() => openArchitecture()}>
          <Network className="size-4" />
          架构
        </SidebarButton>
        <SidebarButton active={route.name === 'todos'} onClick={() => openTodos()}>
          <ListTodo className="size-4" />
          <span className="flex-1">待办</span>
          {dueTodoCount > 0 && <span className="size-1.5 rounded-full bg-warning" role="img" aria-label={`${dueTodoCount} 条到期`} title={`${dueTodoCount} 条到期`} data-testid="sidebar-todo-due" />}
          {openTodoCount > 0 && <span className="text-xs text-muted-foreground tabular-nums" data-testid="sidebar-todo-count">{openTodoCount}</span>}
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
          const isCollapsed = collapsed.has(group.key)
          const isExpanded = expanded.has(group.key)
          const hasTasks = group.tasks.length > 0
          const recent = recentTasks(group.tasks, activeSession)
          const hiddenCount = group.tasks.length - recent.length
          const name = group.path === null ? '无项目' : folderName(group.path)
          const GroupIcon = group.path === null ? FolderDot : Folder
          return (
            <div key={group.key} className="space-y-px" data-testid="sidebar-project">
              <div className="group/project relative flex h-7.5 items-center gap-2 rounded-lg pr-7 pl-2 hover:bg-accent" data-testid="sidebar-project-row">
                <span className="relative size-4 shrink-0">
                  <GroupIcon
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
                  title={group.path ?? workspacePath}
                  aria-expanded={hasTasks ? !isCollapsed : undefined}
                  onClick={() => (hasTasks ? toggleProject('collapsedProjects', group.key) : openHome(group.path))}
                >
                  <span className="truncate">{name}</span>
                </button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={group.path === null ? '新建无项目任务' : `在 ${name} 新建任务`}
                      className={projectActionClass}
                      data-testid="sidebar-project-action"
                      onClick={() => openHome(group.path)}
                    >
                      <Plus className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{group.path === null ? '新建无项目任务' : '在这个项目新建任务'}</TooltipContent>
                </Tooltip>
              </div>
              {!isCollapsed && (isExpanded ? group.tasks : recent).map((task) => <TaskRow key={task.sessionId} task={task} active={task.sessionId === activeSession} />)}
              {!isCollapsed && hiddenCount > 0 && (
                <button
                  type="button"
                  className="flex h-7 w-full items-center rounded-lg pr-2 pl-8 text-left text-xs text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                  onClick={() => toggleProject('expandedProjects', group.key)}
                >
                  {isExpanded ? '收起' : `显示更多（${hiddenCount}）`}
                </button>
              )}
            </div>
          )
        })}
        {remoteGroups.map((group) => (
          <RemoteProject key={group.key} group={group} collapsed={collapsed.has(group.key)} expanded={expanded.has(group.key)} activeSession={route.name === 'remote-task' && route.deviceId === group.deviceId ? route.sessionId : null} />
        ))}
      </div>

      {/* 左下角：设备、用量、设置（SidebarFooter） */}
      <div className="space-y-0.5 border-t border-sidebar-border px-2 py-2">
        <UpdateNotice />
        <SidebarFooter />
      </div>
    </aside>
  )
}

export function openProjectFolder() {
  pickProject().then(
    (picked) => {
      if (!picked) return
      if (store.get().route.name === 'design') openDesign(picked)
      else openHome(picked)
    },
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
// 项目行的加号一直显示，不用悬停；不显示任务条数
const projectActionClass =
  'absolute top-1/2 right-1 z-10 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring'

// 侧栏里可以直接输入的搜索：没输入时列最近任务，输入后用和搜索弹窗同一套会话搜索
function SidebarSearch() {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState(0)
  const search = useSessionSearch(open ? query : '')
  const listId = useId()
  const optionId = (index: number) => `${listId}-option-${index}`
  useEffect(() => setSelected(0), [search.text, search.list.length])

  const pick = (item: SearchItem | undefined) => {
    if (!item) return
    setOpen(false)
    setQuery('')
    if (item.remote) navigate({ name: 'remote-task', deviceId: item.remote.deviceId, sessionId: item.sessionId })
    else void openTask(item)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelected((current) => Math.min(current + 1, Math.max(0, search.list.length - 1)))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected((current) => Math.max(current - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      pick(search.list[selected])
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      event.currentTarget.blur()
    }
  }

  const heading = !search.text ? '最近的任务' : search.searching ? '搜索中…' : '搜索结果'
  const emptyText = !search.text ? '还没有任务' : search.searching ? '' : search.failed ? '搜索失败，请重试' : '没有找到相关任务'

  return (
    <div
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <div className="flex h-8.5 items-center gap-2 rounded-lg border border-input bg-background px-2 focus-within:border-ring/60">
        <Search className="size-4 shrink-0 text-muted-foreground" />
        <input
          id="sidebar-search"
          role="combobox"
          aria-label="侧栏搜索"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && search.list[selected] ? optionId(selected) : undefined}
          value={query}
          placeholder="搜索任务"
          className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
            setSelected(0)
          }}
          onKeyDown={onKeyDown}
        />
        <Kbd>Ctrl+K</Kbd>
      </div>
      {open && (
        <div className="absolute inset-x-0 top-full z-40 mt-1 max-h-96 overflow-y-auto rounded-xl border bg-popover p-1 text-popover-foreground shadow-overlay">
          <div aria-live="polite" className="px-2 py-1 text-xs text-muted-foreground">
            {heading}
          </div>
          <div id={listId} role="listbox" aria-label="侧栏搜索结果" className="flex flex-col">
            {search.list.map((item, index) => {
              const snippet = item.snippet !== '' && item.snippet !== item.title ? item.snippet : null
              return (
                <div
                  key={searchItemKey(item)}
                  id={optionId(index)}
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === selected}
                  className={cn('flex cursor-default flex-col gap-0.5 rounded-md px-2 py-1.5', index === selected && 'bg-accent')}
                  onMouseDown={(event) => event.preventDefault()}
                  onPointerMove={() => setSelected(index)}
                  onClick={() => pick(item)}
                >
                  <span className="truncate text-sm">{highlightMatch(item.title, search.highlight)}</span>
                  <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                    <span className="max-w-32 truncate">{item.remote ? `${item.remote.deviceName} · ${item.cwd}` : search.noProject.has(item.sessionId) ? '无项目' : folderName(item.cwd)}</span>
                    <span className="ml-auto shrink-0 tabular-nums">{formatTime(item.updatedAt)}</span>
                  </span>
                  {snippet && <span className="truncate text-xs text-muted-foreground">{highlightMatch(snippet, search.highlight)}</span>}
                </div>
              )
            })}
          </div>
          {search.list.length === 0 && emptyText && <p className="px-2 py-4 text-center text-xs text-muted-foreground">{emptyText}</p>}
        </div>
      )}
    </div>
  )
}

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
      {/* 画笔放在缩进区，标题仍然对齐；放在主按钮前面，被它铺满整行的 after 盖住，点画笔也是打开任务 */}
      {task.design && (
        <span role="img" aria-label="设计任务" className="absolute top-1/2 left-3 flex -translate-y-1/2 text-muted-foreground">
          <PenTool className="size-3.5" />
        </span>
      )}
      <button type="button" className={rowButtonClass} title={task.title} onClick={() => void openTask(task)}>
        <span className="truncate">{task.title}</span>
      </button>
      <span className={cn(trailingClass, 'group-hover/task:opacity-0 group-has-[:focus-visible]/task:opacity-0', menuOpen && 'opacity-0')}>
        {status ? <TaskStatusMarker status={status} /> : formatTime(task.updatedAt)}
      </span>
      <TaskMenu sessionId={task.sessionId} title={task.title} project={task.cwd} noProject={task.noProject} archived={task.archived} open={menuOpen} onOpenChange={setMenuOpen}>
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

// 别的设备授权给本机的项目：和本机项目一样排在「项目」下，右边的设备图标标出是远程的；开放了「可查看和操作」的有加号，在对方那边新建任务。
// 任务点开是远程任务页
function RemoteProject({ group, collapsed, expanded, activeSession }: { group: RemoteProjectGroup; collapsed: boolean; expanded: boolean; activeSession: string | null }) {
  const [creating, setCreating] = useState(false)
  const control = group.level === 'control'
  const hasTasks = group.sessions.length > 0
  const recent = group.sessions.filter((session, index) => index < RECENT_TASK_LIMIT || session.sessionId === activeSession)
  const hiddenCount = group.sessions.length - recent.length
  const where = group.online ? `「${group.deviceName}」上的项目，${group.full ? '完全控制' : control ? '可以操作' : '只读'}` : `「${group.deviceName}」不在线，显示的是之前的内容`
  return (
    <div className="space-y-px" data-testid="sidebar-remote-project">
      <div className={cn('group/project relative flex h-7.5 items-center gap-2 rounded-lg pl-2 hover:bg-accent', control ? 'pr-13' : 'pr-7')}>
        <span className="relative size-4 shrink-0">
          <Folder className={cn('size-4 transition-opacity', hasTasks && 'group-hover/project:opacity-0 group-has-[:focus-visible]/project:opacity-0')} />
          {hasTasks && (
            <ChevronRight
              className={cn(
                'absolute inset-0 size-4 text-muted-foreground opacity-0 transition-[opacity,rotate] group-hover/project:opacity-100 group-has-[:focus-visible]/project:opacity-100',
                !collapsed && 'rotate-90',
              )}
            />
          )}
        </span>
        <button type="button" className={rowButtonClass} title={`${group.name}（${where}）`} aria-expanded={hasTasks ? !collapsed : undefined} disabled={!hasTasks} onClick={() => toggleProject('collapsedProjects', group.key)}>
          <span className="truncate">{group.name}</span>
        </button>
        <span
          role="img"
          aria-label={where}
          title={where}
          className={cn('absolute top-1/2 flex size-5 -translate-y-1/2 items-center justify-center text-muted-foreground', control ? 'right-7' : 'right-1', !group.online && 'opacity-40')}
          data-testid={group.online ? 'remote-project-online' : 'remote-project-offline'}
        >
          <MonitorSmartphone className="size-3.5" />
        </span>
        {control && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" aria-label={`在 ${group.name} 新建远程任务`} className={projectActionClass} disabled={!group.online} onClick={() => setCreating(true)}>
                <Plus className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>在对方的这个项目新建任务</TooltipContent>
          </Tooltip>
        )}
      </div>
      {creating && <RemoteNewTaskDialog deviceId={group.deviceId} deviceName={group.deviceName} projectId={group.projectId} projectName={group.name} onClose={() => setCreating(false)} />}
      {!collapsed &&
        (expanded ? group.sessions : recent).map((session) => (
          <div
            key={session.sessionId}
            className={cn('relative flex h-7.5 items-center gap-2 rounded-lg pr-2 pl-8 hover:bg-accent', session.sessionId === activeSession && 'bg-soft text-foreground hover:bg-soft')}
            data-testid="sidebar-remote-task"
          >
            <button type="button" className={rowButtonClass} title={session.title} onClick={() => navigate({ name: 'remote-task', deviceId: group.deviceId, sessionId: session.sessionId })}>
              <span className="truncate">{session.title || '（没有标题）'}</span>
            </button>
            <span className={trailingClass}>{session.running ? <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" aria-label="运行中" /> : formatTime(session.updatedAt)}</span>
          </div>
        ))}
      {!collapsed && hiddenCount > 0 && (
        <button
          type="button"
          className="flex h-7 w-full items-center rounded-lg pr-2 pl-8 text-left text-xs text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          onClick={() => toggleProject('expandedProjects', group.key)}
        >
          {expanded ? '收起' : `显示更多（${hiddenCount}）`}
        </button>
      )}
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
