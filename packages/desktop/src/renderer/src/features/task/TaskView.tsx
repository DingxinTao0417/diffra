import { type ReactNode, type Ref, useState } from 'react'
import type { CheckpointChange } from '@diffra/core/types'
import type { ProjectState } from '../../../../shared/ipc'
import { Archive, CircleAlert, CirclePause, Ellipsis, FileDiff, GitBranch, Globe, LayoutDashboard, LoaderCircle, PanelRight, PenTool, ScanSearch, ShieldCheck, SquareTerminal } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { ResizeHandle } from '@/components/ui/resize-handle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ProjectSettingsDialog } from '@/features/project/ProjectSettingsDialog'
import { useProject } from '@/features/project/useProject'
import { BrowserPanel } from '@/features/browser/BrowserPanel'
import { DesignPanel } from '@/features/design/DesignPanel'
import { PermissionCard } from '@/features/session/PermissionCard'
import { RestoreDialog } from '@/features/session/RestoreDialog'
import { TaskMenu } from '@/features/shell/TaskMenu'
import { TerminalPanel } from '@/features/terminal/TerminalPanel'
import { toggleTerminalPanel } from '@/features/terminal/terminals'
import { errorMessage } from '@/lib/errors'
import { folderName } from '@/lib/format'
import { remPx } from '@/lib/shell'
import { turnVerdict, type Verdict, type VerdictTone } from '@/lib/turn-verdict'
import { cancelTask, compactTask, dequeue, dismissSuggestion, regenerate, respondPermission, restoreTurn, saveLayout, sendMessage, setLayout, setPermissionMode, setPlanMode, setTaskModel } from '@/state/actions'
import { type LiveTask, type SidePanel, showToast, store, updateLive, useAppState } from '@/state/store'
import { Composer, type ComposerCommand } from './Composer'
import { composerDraftKey } from './composer-drafts'
import { CacheUsage, ContextUsage } from './ContextUsage'
import { Conversation, StaticTurns } from './Conversation'
import { exportTurns } from './export'
import { BranchMenu } from './BranchMenu'
import { FilePanel } from './FilePanel'
import { VisualsPanel } from './VisualsPanel'
import { DeepScanDialog, MonitorPanel } from './MonitorPanel'
import { useProjectGitState } from './useProjectGitState'
import { type SecurityDialogKind, SecurityToolsDialog } from './SecurityToolsDialog'
import { StepsBar } from './StepsBar'
import { ReadOnlyContext } from './read-only'
import { RemoteTaskContext, type RemoteTaskSource } from './remote-task'
import { ReviewPanel } from './ReviewPanel'
import { ToolOutputContext } from './tool-output'
import { useTaskDiff } from './useTaskDiff'
import { shortcutLabel } from '@/lib/platform'

// 设计模式下对话列和画布各自至少留的宽度
const DESIGN_CHAT_MIN_REM = 20
const DESIGN_CANVAS_MIN_REM = 30

export function TaskView({ sessionId, columnRef }: { sessionId: string; columnRef?: Ref<HTMLElement> }) {
  const task = useAppState((state) => state.live[sessionId])
  if (!task) return <p className="p-6 text-sm text-muted-foreground">正在打开任务…</p>
  return <TaskPage key={sessionId} task={task} columnRef={columnRef} />
}

// 远程任务页借用这一页时给的（features/devices/RemoteTaskView.tsx）：顶栏标题前的设备和级别、顶栏下面的离线和出错提示、
// 输入框那一块（只读时没有）、对话顶上取更早的一页、展开只同步了开头的工具输出、对方的项目设置和分支、向对方要文件改动。
// 本机才有的（任务菜单、终端、浏览器、设计面板、改项目设置、深度扫描）不显示；readOnly 时撤销、重新生成这些也不显示
export interface RemoteTaskSlots {
  badge: ReactNode
  notice: ReactNode
  composer: ReactNode
  readOnly: boolean
  earlier: { count: number; loading: boolean; load(): void } | undefined
  loadToolOutput(toolCallId: string): Promise<void>
  source: RemoteTaskSource
  project: ProjectState | null
  branch: string | null
  // 对方设备的名字，任务监控「环境信息」里写
  device: string
  // 「完全控制」时有：对方电脑上的终端，在右侧栏
  terminal?: ReactNode
}

export function TaskPage({ task, columnRef, remote }: { task: LiveTask; columnRef?: Ref<HTMLElement>; remote?: RemoteTaskSlots }) {
  const panel = useAppState((state) => state.panel)
  const designChatWidth = useAppState((state) => state.settings?.layout.designChatWidth ?? null)
  const suggestionsEnabled = useAppState((state) => state.settings?.suggestions?.nextPrompt !== false)
  const archived = useAppState((state) => state.tasks.find((item) => item.sessionId === task.sessionId)?.archived ?? false)
  const local = useProject(remote ? null : task.project)
  const project = remote ? remote.project : local.project
  const branch = remote ? remote.branch : local.branch
  const [confirm, setConfirm] = useState<{ mode: 'restore' | 'regenerate'; turnId: string; changes: CheckpointChange[] | null } | null>(null)
  const [scanScope, setScanScope] = useState<'task' | 'project' | null>(null)
  const [securityKind, setSecurityKind] = useState<SecurityDialogKind | null>(null)
  const [editingProject, setEditingProject] = useState(false)
  const [locate, setLocate] = useState<{ id: string; at: number } | null>(null)
  const deepScanEnabled = useAppState((state) => state.settings?.security.deepScan ?? false)
  const firstTurn = task.turns[0]?.id ?? null
  const monitorDiff = useTaskDiff(task.sessionId, firstTurn, task.info.checkpoints && panel === 'monitor', task.changeVersion, remote?.source)
  const monitorGit = useProjectGitState(remote ? null : task.project, panel === 'monitor' && !remote, task.changeVersion)

  const status = turnVerdict(task)
  // 斜杠菜单里的深度扫描；和任务监控里的按钮一样，运行中不能扫，还没跑过任务时没有「本任务改动」
  // 外接智能体用它自己的上下文和循环：没有压缩和深度扫描
  const commands: ComposerCommand[] = task.agent ? [] : [
    ...(!task.running ? [{ id: 'compact', label: 'compact', description: '手动压缩早期上下文，保留最近内容和完整聊天历史', keywords: ['compact', '压缩', '上下文'], icon: Archive, run: () => { compactTask(task.sessionId).catch((error: unknown) => showToast(`压缩失败：${errorMessage(error)}`)) } }] : []),
    ...(deepScanEnabled && !task.running ? [
      ...(task.turns.length > 0 ? [{ id: 'deep-scan-task', label: '深度扫描 · 本任务改动', description: '只读地跨文件追踪这个任务改过的代码，出一份安全报告', keywords: ['scan', 'security'], icon: ScanSearch, run: () => setScanScope('task') }] : []),
      { id: 'deep-scan-project', label: '深度扫描 · 整个项目', description: '只读地扫描整个项目，出一份安全报告', keywords: ['scan', 'security'], icon: ScanSearch, run: () => setScanScope('project') },
    ] : []),
    // 更多安全检查（v2）：手动发起，跑完勾选问题填进输入框
    ...(!remote ? [
      { id: 'security-licenses', label: '安全 · 依赖许可证', description: '列出依赖的许可证，标出 GPL、AGPL 这类强传染的', keywords: ['license', 'security', '许可证'], icon: ShieldCheck, run: () => setSecurityKind('licenses') },
      { id: 'security-scanners', label: '安全 · 外部扫描器', description: '用本机装的 Semgrep 或 CodeQL 扫整个项目', keywords: ['semgrep', 'codeql', 'security', 'scan'], icon: ShieldCheck, run: () => setSecurityKind('scanners') },
      { id: 'security-dynamic', label: '安全 · 动态测试', description: '对本机跑着的服务发探测请求，看有没有 XSS、开放跳转、路径穿越', keywords: ['dast', 'security', '动态'], icon: ShieldCheck, run: () => setSecurityKind('dynamic') },
    ] : []),
  ]
  const pinnedCount = useAppState((state) => state.pinned.filter((item) => item.sessionId === task.sessionId).length)
  const togglePanel = (target: SidePanel) => store.set((state) => ({ ...state, panel: state.panel === target ? null : target }))

  // 远程任务经对方做（对方开放了「可查看和操作」才有这些）
  const source = remote?.source
  const doRegenerate = (turnId: string) => void (source?.regenerate ? source.regenerate(turnId).catch((error: unknown) => showToast(errorMessage(error))) : regenerate(task.sessionId, turnId))
  const askRestore = async (mode: 'restore' | 'regenerate', turnId: string) => {
    if (remote && !(mode === 'restore' ? source?.restore : source?.regenerate)) return
    if (!task.info.checkpoints) {
      if (mode === 'regenerate') doRegenerate(turnId)
      return
    }
    // 撤销先弹出确认框，受影响的文件读回来再填进去；读文件要跑 git，可能要一会儿
    if (mode === 'restore') setConfirm({ mode, turnId, changes: null })
    try {
      const changes = source?.previewRestore ? await source.previewRestore(turnId) : await window.diffra.previewCheckpoint(task.sessionId, turnId)
      // 重新生成时没有文件要撤销就不用确认
      if (mode === 'regenerate' && changes.length === 0) doRegenerate(turnId)
      else setConfirm((current) => (mode === 'restore' && current?.turnId !== turnId ? current : { mode, turnId, changes }))
    } catch (error) {
      if (mode === 'restore') setConfirm(null)
      showToast(errorMessage(error))
    }
  }

  const confirmRestore = async () => {
    if (!confirm) return
    try {
      if (confirm.mode === 'restore') await (source?.restore ? source.restore(confirm.turnId) : restoreTurn(task.sessionId, confirm.turnId))
      else doRegenerate(confirm.turnId)
    } catch (error) {
      showToast(errorMessage(error))
    } finally {
      setConfirm(null)
    }
  }

  const confirmIndex = confirm ? task.turns.findIndex((turn) => turn.id === confirm.turnId) : -1

  const page = (
    <div className="flex h-full min-w-0 flex-col">
      <header className="app-drag flex h-12 shrink-0 items-center gap-2 border-b border-border/70 pr-3 pl-5">
        {remote?.badge}
        <span className="min-w-0 truncate font-bold" data-testid="task-title">
          {task.title}
        </span>
        {!remote && (
          <TaskMenu
            sessionId={task.sessionId}
            title={task.title}
            project={task.project}
            noProject={task.noProject}
            archived={archived}
            // 无项目任务的文件夹不是用户的项目，不给它存项目设置
            onProjectSettings={task.noProject ? undefined : () => setEditingProject(true)}
            onExport={task.turns.length > 0 ? (format) => void exportTurns(format, task.title || 'Diffra 任务', task.turns, (turns, shared) => <StaticTurns task={task} turns={turns} projectImages={!shared && !remote} />, { sessionId: task.sessionId, turnIds: null }) : undefined}
          >
            <Button variant="ghost" size="icon-sm" aria-label="任务菜单" className="text-muted-foreground">
              <Ellipsis className="size-4" />
            </Button>
          </TaskMenu>
        )}
        <StatusLabel status={status} />
        <div className="flex-1" />
        {/* 右侧面板互斥，做成一组，设计面板只有设计任务有；终端也在右侧栏（第 533 步），远程任务只有「完全控制」时有。远程任务没有浏览器和设计 */}
        <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-muted p-0.5">
          {PANEL_BUTTONS.filter(
            // 白板只在这个任务固定了东西（或者白板正开着）时有按钮
            (item) => (item.panel !== 'design' || task.design) && !(remote && (item.panel === 'browser' || item.panel === 'design')) && !(item.panel === 'terminal' && remote && !remote.terminal) && (item.panel !== 'visuals' || pinnedCount > 0 || panel === 'visuals'),
          ).map((item) => (
            <PanelButton
              key={item.panel}
              label={item.label}
              shortcut={item.panel === 'terminal' ? shortcutLabel('Ctrl+`') : undefined}
              active={panel === item.panel}
              // 本机终端没有标签页时顺手开一个
              onClick={() => (item.panel === 'terminal' && !remote ? toggleTerminalPanel(task.project) : togglePanel(item.panel))}
            >
              <item.icon className="size-4" />
            </PanelButton>
          ))}
        </div>
      </header>
      {remote?.notice}

      <div className="flex min-h-0 flex-1">
        {/* 开着设计面板时画布占主区，对话列放左边，宽度可拖 */}
        <section
          ref={columnRef}
          className={cn('@container relative flex min-w-0 flex-col', panel === 'design' ? 'w-[26rem] shrink-0' : 'flex-1')}
          style={panel === 'design' && designChatWidth !== null ? { width: designChatWidth, maxWidth: `calc(100% - ${DESIGN_CANVAS_MIN_REM}rem)` } : undefined}
        >
          {panel === 'design' && (
            // 和右侧面板一样，拖动条放在画布那一侧（对话列贴边的是滚动条），画布左边留出 ml-2（见 DesignPanel）
            <ResizeHandle
              orientation="vertical"
              grow={1}
              label="拖动调整对话列宽度"
              className="absolute inset-y-0 -right-2"
              measure={(handle) => {
                const column = handle.parentElement!
                const min = remPx(DESIGN_CHAT_MIN_REM)
                return { size: column.getBoundingClientRect().width, min, max: Math.max(min, column.parentElement!.clientWidth - remPx(DESIGN_CANVAS_MIN_REM)) }
              }}
              onResize={(size) => setLayout({ designChatWidth: size })}
              onCommit={(size) => void saveLayout({ designChatWidth: size })}
              onReset={() => void saveLayout({ designChatWidth: null })}
            />
          )}
          {/* 终端在对话列底部，右侧面板保持全高；对话区留出最小高度，终端拉高时由 flex 压缩终端而不是对话 */}
          {/* 对话列变窄时对话区和输入框一起收窄左右留白，两边才对齐；对话区的滚动层在 Conversation 里 */}
          <div className="flex min-h-40 flex-1 flex-col @max-[600px]:[&>div>.overflow-y-auto]:px-5">
            <Conversation
              task={task}
              locate={locate}
              onLocate={(id) => setLocate({ id, at: Date.now() })}
              onRestore={(turnId) => void askRestore('restore', turnId)}
              onRegenerate={(turnId) => void askRestore('regenerate', turnId)}
              readOnly={remote?.readOnly ?? false}
              earlier={remote?.earlier}
            />
          </div>
          <div className="px-8 pb-3.5 @max-[600px]:px-5">
            <div className="mx-auto flex max-w-(--content-max) flex-col gap-2">
              {remote ? (
                <>
                  <StepsBar turns={task.turns} running={task.running} />
                  {remote.composer}
                </>
              ) : (
                <>
                  {/* 固定在输入框上方，用户往上翻着看改动时也能看到；多行命令只让命令区滚动，否则卡片会把对话挤没，按钮也不能随之滚出视野 */}
                  {task.permission && (
                    <div className="[&_pre]:max-h-40">
                      <PermissionCard request={task.permission} project={task.project} onRespond={(optionId, answers) => respondPermission(task.sessionId, optionId, answers)} />
                    </div>
                  )}
                  {task.queue.map((item) => (
                    <div key={item.id} className="flex items-center gap-2 self-start rounded-lg border border-dashed bg-sidebar px-2.5 py-1.5 text-xs" data-testid="queued-message">
                      <span className="text-muted-foreground">
                        {item.options.plan ? '排队中 · 出计划' : item.options.goal ? '排队中 · 目标' : '排队中'}
                        {item.options.images.length > 0 && ` · ${item.options.images.length} 张图片`}
                      </span>
                      <span className="max-w-96 truncate">{item.text}</span>
                      <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => dequeue(task.sessionId, item.id)}>
                        撤回
                      </button>
                    </div>
                  ))}
                  <StepsBar turns={task.turns} running={task.running} />
                  <Composer
                    size="normal"
                    draftKey={composerDraftKey.task(task.sessionId)}
                    projectPath={task.project}
                    mcpTarget={{ sessionId: task.sessionId }}
                    commands={commands}
                    running={task.running}
                    permissionMode={task.permissionMode}
                    onPermissionModeChange={(mode) => void setPermissionMode(task.sessionId, mode)}
                    modelLabel={task.modelLabel}
                    modelRef={task.modelRef}
                    modelLocked={task.running}
                    onModelChange={(ref) => void setTaskModel(task.sessionId, ref)}
                    agent={task.agent ?? null}
                    planMode={task.planMode}
                    onPlanModeChange={(planMode) => setPlanMode(task.sessionId, planMode)}
                    suggestion={remote || task.running || task.permission || !suggestionsEnabled ? null : task.suggestion}
                    onSuggestionUsed={() => dismissSuggestion(task.sessionId)}
                    onSuggestionDismiss={() => dismissSuggestion(task.sessionId)}
                    onSend={(text, extras) => {
                      void sendMessage(task.sessionId, text, { plan: task.planMode, ...extras })
                      return true
                    }}
                    onStop={() => cancelTask(task.sessionId)}
                  />
                </>
              )}
              <div className="flex flex-wrap items-center gap-3.5 px-1 text-xs text-muted-foreground">
                <span title={task.project}>{task.noProject ? '无项目' : folderName(task.project)}</span>
                {branch &&
                  (remote && !source?.switchBranch ? (
                    <span className="flex items-center gap-1">
                      <GitBranch className="size-3" />
                      {branch}
                    </span>
                  ) : (
                    <BranchMenu
                      branch={branch}
                      load={() => (source?.listBranches ? source.listBranches() : window.diffra.projectBranches(task.project))}
                      onSwitch={async (next) => {
                        if (source?.switchBranch) return source.switchBranch(next)
                        await window.diffra.switchProjectBranch(task.project, next)
                        local.setBranch(next)
                        // 文件整批换了：任务监控、审阅重新读改动
                        updateLive(task.sessionId, (current) => ({ ...current, changeVersion: current.changeVersion + 1 }))
                      }}
                    />
                  ))}
                <div className="flex-1" />
                {task.usage && <CacheUsage usage={task.usage} />}
                {task.usage && <ContextUsage sessionId={task.sessionId} usage={task.usage} running={task.running} />}
              </div>
            </div>
          </div>
        </section>
        {panel === 'monitor' && <MonitorPanel task={task} branch={branch} device={remote ? remote.device : null} diff={monitorDiff} gitState={monitorGit} onLocate={(id) => setLocate({ id, at: Date.now() })} />}
        {panel === 'review' && <ReviewPanel task={task} onRestore={remote && !source?.restore ? undefined : (turnId) => void askRestore('restore', turnId)} />}
        {panel === 'browser' && !remote && <BrowserPanel sessionId={task.sessionId} />}
        {panel === 'design' && !remote && <DesignPanel sessionId={task.sessionId} project={task.project} noProject={task.noProject} />}
        {panel === 'terminal' && (remote ? remote.terminal : <TerminalPanel cwd={task.project} />)}
        {panel === 'file' && !remote && <FilePanel sessionId={task.sessionId} changeVersion={task.changeVersion} />}
        {panel === 'visuals' && <VisualsPanel sessionId={task.sessionId} />}
      </div>

      <DeepScanDialog sessionId={task.sessionId} scope={scanScope} onClose={() => setScanScope(null)} />
      {!remote && <SecurityToolsDialog sessionId={task.sessionId} cwd={task.project} kind={securityKind} onClose={() => setSecurityKind(null)} />}
      {!remote && <ProjectSettingsDialog project={project} open={editingProject} onClose={() => setEditingProject(false)} onSaved={local.setProject} />}
      <RestoreDialog open={confirm !== null} changes={confirm?.changes ?? null} mode={confirm?.mode} turnNumber={confirmIndex >= 0 ? confirmIndex + 1 : null} lastTurn={confirmIndex >= 0 && confirmIndex === task.turns.length - 1} onCancel={() => setConfirm(null)} onConfirm={confirmRestore} />
    </div>
  )
  if (!remote) return page
  return (
    <RemoteTaskContext.Provider value={remote.source}>
      <ReadOnlyContext.Provider value={remote.readOnly}>
        <ToolOutputContext.Provider value={remote.loadToolOutput}>{page}</ToolOutputContext.Provider>
      </ReadOnlyContext.Provider>
    </RemoteTaskContext.Provider>
  )
}

function StatusLabel({ status }: { status: Verdict }) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground',
        status.tone === 'confirm' && 'text-foreground',
        (status.tone === 'error' || status.tone === 'failed') && 'text-destructive',
      )}
      title={status.reason ?? undefined}
      data-testid="task-status"
      data-tone={status.tone}
    >
      <StatusIndicator tone={status.tone} />
      {status.label}
    </span>
  )
}

// 浅色下 warning 和 destructive 色相接近，和侧栏一样靠形状区分：等待确认空心圈，受阻暂停，未完成带感叹号，只有出错和验证未通过（旧记录）是实心点
function StatusIndicator({ tone }: { tone: VerdictTone }) {
  if (tone === 'running') return <LoaderCircle className="size-3 animate-spin text-muted-foreground" />
  if (tone === 'unfinished') return <CircleAlert className="size-3 text-warning" />
  if (tone === 'blocked') return <CirclePause className="size-3 text-warning" />
  const dot = {
    confirm: 'size-2 border-2 border-foreground',
    error: 'size-2 bg-destructive',
    failed: 'size-2 bg-destructive',
    waiting: 'size-2 border-2 border-muted-foreground/60',
    stopped: 'size-1.5 bg-muted-foreground/60',
    done: null,
    idle: null,
  }[tone]
  return dot && <span className={cn('shrink-0 rounded-full', dot)} />
}

const PANEL_BUTTONS = [
  { panel: 'design', label: '设计', icon: PenTool },
  { panel: 'terminal', label: '终端', icon: SquareTerminal },
  { panel: 'browser', label: '浏览器', icon: Globe },
  { panel: 'review', label: '审阅改动', icon: FileDiff },
  { panel: 'monitor', label: '任务监控', icon: PanelRight },
  { panel: 'visuals', label: '白板', icon: LayoutDashboard },
] as const

function PanelButton({ label, shortcut, active, onClick, children }: { label: string; shortcut?: string; active: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-pressed={active}
          onClick={onClick}
          className={cn('rounded-md', active ? 'bg-background text-foreground shadow-sm hover:bg-background dark:bg-accent dark:inset-ring dark:inset-ring-input dark:hover:bg-accent' : 'text-muted-foreground hover:bg-transparent dark:hover:bg-transparent')}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && <> <Kbd>{shortcut}</Kbd></>}
      </TooltipContent>
    </Tooltip>
  )
}
