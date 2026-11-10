import { type Ref, useState } from 'react'
import type { CheckpointChange } from '@diffra/core/types'
import { Archive, Check, CircleAlert, CirclePause, Ellipsis, FileDiff, GitBranch, Globe, LoaderCircle, PanelRight, PenTool, ScanSearch, SquareTerminal } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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
import { turnVerdict, type Verdict, type VerdictTone } from '@/lib/turn-verdict'
import { cancelTask, compactTask, dequeue, regenerate, respondPermission, restoreTurn, sendMessage, setPermissionMode, setPlanMode, setTaskModel } from '@/state/actions'
import { type LiveTask, type SidePanel, showToast, store, useAppState } from '@/state/store'
import { Composer, type ComposerCommand } from './Composer'
import { composerDraftKey } from './composer-drafts'
import { CacheUsage, ContextUsage } from './ContextUsage'
import { Conversation } from './Conversation'
import { DeepScanDialog, MonitorPanel } from './MonitorPanel'
import { ReviewPanel } from './ReviewPanel'
import { useTaskDiff } from './useTaskDiff'

export function TaskView({ sessionId, columnRef }: { sessionId: string; columnRef?: Ref<HTMLElement> }) {
  const task = useAppState((state) => state.live[sessionId])
  if (!task) return <p className="p-6 text-sm text-muted-foreground">正在打开任务…</p>
  return <TaskPage key={sessionId} task={task} columnRef={columnRef} />
}

function TaskPage({ task, columnRef }: { task: LiveTask; columnRef?: Ref<HTMLElement> }) {
  const panel = useAppState((state) => state.panel)
  const terminalOpen = useAppState((state) => state.terminalOpen)
  const archived = useAppState((state) => state.tasks.find((item) => item.sessionId === task.sessionId)?.archived ?? false)
  const { project, setProject, branch } = useProject(task.project)
  const [confirm, setConfirm] = useState<{ mode: 'restore' | 'regenerate'; turnId: string; changes: CheckpointChange[] | null } | null>(null)
  const [scanScope, setScanScope] = useState<'task' | 'project' | null>(null)
  const [locate, setLocate] = useState<{ id: string; at: number } | null>(null)
  const deepScanEnabled = useAppState((state) => state.settings?.security.deepScan ?? false)
  const firstTurn = task.turns[0]?.id ?? null
  const monitorDiff = useTaskDiff(task.sessionId, firstTurn, task.info.checkpoints && panel === 'monitor', task.changeVersion)

  const status = turnVerdict(task)
  // 斜杠菜单里的深度扫描；和任务监控里的按钮一样，运行中不能扫，还没跑过任务时没有「本任务改动」
  const commands: ComposerCommand[] = [
    ...(!task.running ? [{ id: 'compact', label: 'compact', description: '手动压缩早期上下文，保留最近内容和完整聊天历史', keywords: ['compact', '压缩', '上下文'], icon: Archive, run: () => { compactTask(task.sessionId).catch((error: unknown) => showToast(`压缩失败：${errorMessage(error)}`)) } }] : []),
    ...(deepScanEnabled && !task.running ? [
      ...(task.turns.length > 0 ? [{ id: 'deep-scan-task', label: '深度扫描 · 本任务改动', description: '只读地跨文件追踪这个任务改过的代码，出一份安全报告', keywords: ['scan', 'security'], icon: ScanSearch, run: () => setScanScope('task') }] : []),
      { id: 'deep-scan-project', label: '深度扫描 · 整个项目', description: '只读地扫描整个项目，出一份安全报告', keywords: ['scan', 'security'], icon: ScanSearch, run: () => setScanScope('project') },
    ] : []),
  ]
  const togglePanel = (target: SidePanel) => store.set((state) => ({ ...state, panel: state.panel === target ? null : target }))

  const askRestore = async (mode: 'restore' | 'regenerate', turnId: string) => {
    if (!task.info.checkpoints) {
      if (mode === 'regenerate') void regenerate(task.sessionId, turnId)
      return
    }
    // 撤销先弹出确认框，受影响的文件读回来再填进去；读文件要跑 git，可能要一会儿
    if (mode === 'restore') setConfirm({ mode, turnId, changes: null })
    try {
      const changes = await window.diffra.previewCheckpoint(task.sessionId, turnId)
      // 重新生成时没有文件要撤销就不用确认
      if (mode === 'regenerate' && changes.length === 0) void regenerate(task.sessionId, turnId)
      else setConfirm((current) => (mode === 'restore' && current?.turnId !== turnId ? current : { mode, turnId, changes }))
    } catch (error) {
      if (mode === 'restore') setConfirm(null)
      showToast(errorMessage(error))
    }
  }

  const confirmRestore = async () => {
    if (!confirm) return
    try {
      if (confirm.mode === 'restore') await restoreTurn(task.sessionId, confirm.turnId)
      else void regenerate(task.sessionId, confirm.turnId)
    } catch (error) {
      showToast(errorMessage(error))
    } finally {
      setConfirm(null)
    }
  }

  const confirmIndex = confirm ? task.turns.findIndex((turn) => turn.id === confirm.turnId) : -1

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 pr-3 pl-5">
        <span className="min-w-0 truncate" data-testid="task-title">
          {task.title}
        </span>
        <TaskMenu sessionId={task.sessionId} title={task.title} project={task.project} noProject={task.noProject} archived={archived}>
          <Button variant="ghost" size="icon-sm" aria-label="任务菜单" className="text-muted-foreground">
            <Ellipsis className="size-4" />
          </Button>
        </TaskMenu>
        <StatusLabel status={status} />
        <div className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="终端 Ctrl+`"
              aria-pressed={terminalOpen}
              className={cn('text-muted-foreground', terminalOpen && 'bg-accent text-foreground hover:bg-accent dark:hover:bg-accent')}
              onClick={() => toggleTerminalPanel(task.project)}
            >
              <SquareTerminal className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            终端 <Kbd>Ctrl+`</Kbd>
          </TooltipContent>
        </Tooltip>
        <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
        {/* 右侧面板互斥，做成一组，设计面板只有设计任务有；终端是独立开关，放在分隔线另一侧 */}
        <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted p-0.5">
          {PANEL_BUTTONS.filter((item) => item.panel !== 'design' || task.design).map((item) => (
            <PanelButton key={item.panel} label={item.label} active={panel === item.panel} onClick={() => togglePanel(item.panel)}>
              <item.icon className="size-4" />
            </PanelButton>
          ))}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 开着设计面板时画布占主区，对话列固定宽度放左边 */}
        <section ref={columnRef} className={cn('@container flex min-w-0 flex-col', panel === 'design' ? 'w-[26rem] shrink-0' : 'flex-1')}>
          {/* 终端在对话列底部，右侧面板保持全高；对话区留出最小高度，终端拉高时由 flex 压缩终端而不是对话 */}
          {/* 对话列变窄时对话区和输入框一起收窄左右留白，两边才对齐；对话区的滚动层在 Conversation 里 */}
          <div className="flex min-h-40 flex-1 flex-col @max-[600px]:[&>div>.overflow-y-auto]:px-5">
            <Conversation task={task} locate={locate} onLocate={(id) => setLocate({ id, at: Date.now() })} onRestore={(turnId) => void askRestore('restore', turnId)} onRegenerate={(turnId) => void askRestore('regenerate', turnId)} />
          </div>
          <div className="px-8 pb-3.5 @max-[600px]:px-5">
            <div className="mx-auto flex max-w-(--content-max) flex-col gap-2">
              {/* 固定在输入框上方，用户往上翻着看改动时也能看到；多行命令只让命令区滚动，否则卡片会把对话挤没，按钮也不能随之滚出视野 */}
              {task.permission && (
                <div className="[&_pre]:max-h-40">
                  <PermissionCard request={task.permission} onRespond={(optionId) => respondPermission(task.sessionId, optionId)} />
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
                planMode={task.planMode}
                onPlanModeChange={(planMode) => setPlanMode(task.sessionId, planMode)}
                onSend={(text, extras) => {
                  void sendMessage(task.sessionId, text, { plan: task.planMode, ...extras })
                  return true
                }}
                onStop={() => cancelTask(task.sessionId)}
              />
              <div className="flex flex-wrap items-center gap-3.5 px-1 text-xs text-muted-foreground">
                <span title={task.project}>{task.noProject ? '无项目' : folderName(task.project)}</span>
                {branch && (
                  <span className="flex items-center gap-1">
                    <GitBranch className="size-3" />
                    {branch}
                  </span>
                )}
                <div className="flex-1" />
                {task.usage && <CacheUsage usage={task.usage} />}
                {task.usage && <ContextUsage sessionId={task.sessionId} usage={task.usage} running={task.running} />}
              </div>
            </div>
          </div>
          {terminalOpen && <TerminalPanel cwd={task.project} />}
        </section>
        {panel === 'monitor' && <MonitorPanel task={task} project={project} branch={branch} diff={monitorDiff} onProjectSaved={setProject} onDeepScan={setScanScope} onLocate={(id) => setLocate({ id, at: Date.now() })} />}
        {panel === 'review' && <ReviewPanel task={task} onRestore={(turnId) => void askRestore('restore', turnId)} />}
        {panel === 'browser' && <BrowserPanel sessionId={task.sessionId} />}
        {panel === 'design' && <DesignPanel sessionId={task.sessionId} project={task.project} noProject={task.noProject} />}
      </div>

      <DeepScanDialog sessionId={task.sessionId} scope={scanScope} onClose={() => setScanScope(null)} />
      <RestoreDialog open={confirm !== null} changes={confirm?.changes ?? null} mode={confirm?.mode} turnNumber={confirmIndex >= 0 ? confirmIndex + 1 : null} lastTurn={confirmIndex >= 0 && confirmIndex === task.turns.length - 1} onCancel={() => setConfirm(null)} onConfirm={confirmRestore} />
    </div>
  )
}

function StatusLabel({ status }: { status: Verdict }) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground',
        status.tone === 'confirm' && 'text-warning',
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

// 浅色下 warning 和 destructive 色相接近，和侧栏一样靠形状区分：等待确认空心圈，受阻暂停，未验证带感叹号，只有出错和验证未通过是实心点
function StatusIndicator({ tone }: { tone: VerdictTone }) {
  if (tone === 'running') return <LoaderCircle className="size-3 animate-spin text-muted-foreground" />
  // success-color-allow: 全应用唯一表示状态的绿色，只在本轮被接受的 finish 经检查命令验证过时出现
  if (tone === 'verified') return <Check className="size-3 text-success" />
  if (tone === 'unverified' || tone === 'unfinished') return <CircleAlert className="size-3 text-warning" />
  if (tone === 'blocked') return <CirclePause className="size-3 text-warning" />
  const dot = {
    confirm: 'size-2 border-2 border-warning',
    error: 'size-2 bg-destructive',
    failed: 'size-2 bg-destructive',
    waiting: 'size-2 border-2 border-muted-foreground/60',
    stopped: 'size-1.5 bg-muted-foreground/60',
    nochange: null,
    done: null,
    idle: null,
  }[tone]
  return dot && <span className={cn('shrink-0 rounded-full', dot)} />
}

const PANEL_BUTTONS = [
  { panel: 'design', label: '设计', icon: PenTool },
  { panel: 'browser', label: '浏览器', icon: Globe },
  { panel: 'review', label: '审阅改动', icon: FileDiff },
  { panel: 'monitor', label: '任务监控', icon: PanelRight },
] as const

function PanelButton({ label, active, onClick, children }: { label: string; active: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-pressed={active}
          onClick={onClick}
          className={cn('rounded-sm', active ? 'bg-background text-foreground shadow-xs ring-1 ring-border hover:bg-background dark:bg-accent dark:hover:bg-accent' : 'text-muted-foreground hover:bg-transparent dark:hover:bg-transparent')}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
