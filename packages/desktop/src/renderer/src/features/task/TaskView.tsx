import { useState } from 'react'
import type { CheckpointChange } from '@diffra/core/types'
import { Archive, Check, Ellipsis, FileDiff, GitBranch, Globe, LoaderCircle, PanelRight, ScanSearch, SquareTerminal } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useProject } from '@/features/project/useProject'
import { BrowserPanel } from '@/features/browser/BrowserPanel'
import { PermissionCard } from '@/features/session/PermissionCard'
import { RestoreDialog } from '@/features/session/RestoreDialog'
import type { Usage } from '@/features/session/transcript'
import { TaskMenu } from '@/features/shell/TaskMenu'
import { TerminalPanel } from '@/features/terminal/TerminalPanel'
import { toggleTerminalPanel } from '@/features/terminal/terminals'
import { errorMessage } from '@/lib/errors'
import { folderName, formatTokens } from '@/lib/format'
import { type TaskStatus, taskStatus } from '@/lib/task-status'
import { cancelTask, compactTask, dequeue, regenerate, respondPermission, restoreTurn, sendMessage, setPermissionMode, setPlanMode, setTaskModel } from '@/state/actions'
import { type LiveTask, type SidePanel, showToast, store, useAppState } from '@/state/store'
import { Composer, type ComposerCommand } from './Composer'
import { Conversation } from './Conversation'
import { DeepScanDialog, MonitorPanel } from './MonitorPanel'
import { ReviewPanel } from './ReviewPanel'
import { useTaskDiff } from './useTaskDiff'

export function TaskView({ sessionId }: { sessionId: string }) {
  const task = useAppState((state) => state.live[sessionId])
  if (!task) return <p className="p-6 text-sm text-muted-foreground">正在打开任务…</p>
  return <TaskPage key={sessionId} task={task} />
}

function TaskPage({ task }: { task: LiveTask }) {
  const panel = useAppState((state) => state.panel)
  const terminalOpen = useAppState((state) => state.terminalOpen)
  const archived = useAppState((state) => state.tasks.find((item) => item.sessionId === task.sessionId)?.archived ?? false)
  const { project, setProject, branch } = useProject(task.project)
  const [confirm, setConfirm] = useState<{ mode: 'restore' | 'regenerate'; turnId: string; changes: CheckpointChange[] | null } | null>(null)
  const [scanScope, setScanScope] = useState<'task' | 'project' | null>(null)
  const deepScanEnabled = useAppState((state) => state.settings?.security.deepScan ?? false)
  const firstTurn = task.turns[0]?.id ?? null
  const monitorDiff = useTaskDiff(task.sessionId, firstTurn, task.info.checkpoints && panel === 'monitor', task.changeVersion)

  const status = taskStatus(task)
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

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 pr-3 pl-5">
        <span className="min-w-0 truncate font-medium" data-testid="task-title">
          {task.title}
        </span>
        <TaskMenu sessionId={task.sessionId} title={task.title} project={task.project} archived={archived}>
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
        {/* 三个右侧面板互斥，做成一组；终端是独立开关，放在分隔线另一侧 */}
        <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted p-0.5">
          {PANEL_BUTTONS.map((item) => (
            <PanelButton key={item.panel} label={item.label} active={panel === item.panel} onClick={() => togglePanel(item.panel)}>
              <item.icon className="size-4" />
            </PanelButton>
          ))}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col">
          <Conversation task={task} onRestore={(turnId) => void askRestore('restore', turnId)} onRegenerate={(turnId) => void askRestore('regenerate', turnId)} />
          <div className="px-8 pb-3.5">
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
                  <button type="button" className="text-primary hover:underline" onClick={() => dequeue(task.sessionId, item.id)}>
                    撤回
                  </button>
                </div>
              ))}
              <Composer
                size="normal"
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
                <span title={task.project}>{folderName(task.project)}</span>
                {branch && (
                  <span className="flex items-center gap-1">
                    <GitBranch className="size-3" />
                    {branch}
                  </span>
                )}
                <div className="flex-1" />
                {task.usage && <UsageMeter usage={task.usage} />}
              </div>
            </div>
          </div>
        </section>
        {panel === 'monitor' && <MonitorPanel task={task} project={project} branch={branch} diff={monitorDiff} onProjectSaved={setProject} onDeepScan={setScanScope} />}
        {panel === 'review' && <ReviewPanel task={task} onRestore={(turnId) => void askRestore('restore', turnId)} />}
        {panel === 'browser' && <BrowserPanel sessionId={task.sessionId} />}
      </div>
      {terminalOpen && <TerminalPanel cwd={task.project} />}

      <DeepScanDialog sessionId={task.sessionId} scope={scanScope} onClose={() => setScanScope(null)} />
      <RestoreDialog open={confirm !== null} changes={confirm?.changes ?? null} mode={confirm?.mode} onCancel={() => setConfirm(null)} onConfirm={confirmRestore} />
    </div>
  )
}

function StatusLabel({ status }: { status: TaskStatus }) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground',
        status.tone === 'confirm' && 'text-warning',
        status.tone === 'error' && 'text-destructive',
      )}
      data-testid="task-status"
      data-tone={status.tone}
    >
      <StatusIndicator tone={status.tone} />
      {status.label}
    </span>
  )
}

// 浅色下 warning 和 destructive 色相接近，和侧栏一样靠形状区分：等待确认空心圈，出错实心点
function StatusIndicator({ tone }: { tone: TaskStatus['tone'] }) {
  if (tone === 'running') return <LoaderCircle className="size-3 animate-spin text-primary" />
  if (tone === 'done') return <Check className="size-3" />
  const dot = {
    confirm: 'size-2 border-2 border-warning',
    error: 'size-2 bg-destructive',
    blocked: 'size-2 bg-warning',
    waiting: 'size-2 border-2 border-muted-foreground/60',
    stopped: 'size-1.5 bg-muted-foreground/60',
    idle: null,
  }[tone]
  return dot && <span className={cn('shrink-0 rounded-full', dot)} />
}

const PANEL_BUTTONS = [
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

const USAGE_PARTS = [
  { key: 'system', label: '系统提示词', className: 'bg-primary' },
  { key: 'tools', label: '工具定义', className: 'bg-primary/75' },
  { key: 'rules', label: '编码规范和项目规则', className: 'bg-primary/50' },
  { key: 'messages', label: '对话和工具结果', className: 'bg-primary/25' },
] as const

function UsageMeter({ usage }: { usage: Usage }) {
  const percent = usage.size > 0 ? Math.min(100, Math.round((usage.used / usage.size) * 100)) : 0
  const breakdown = usage.breakdown
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="flex items-center gap-1.5 hover:text-foreground" data-testid="context-usage">
          <span className="flex h-1 w-12 overflow-hidden rounded-full bg-accent">
            <span className={cn('rounded-full', percent >= 80 ? 'bg-warning' : 'bg-primary')} style={{ width: `${percent}%` }} />
          </span>
          上下文 {percent}%
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3 text-sm">
        <div className="flex items-center">
          <span className="font-medium">上下文</span>
          <span className="ml-auto text-muted-foreground">
            {formatTokens(usage.used)} / {formatTokens(usage.size)} · {percent}%
          </span>
        </div>
        {breakdown && (
          <>
            <span className="flex h-1.5 overflow-hidden rounded-full bg-accent">
              {USAGE_PARTS.map((part) => (
                <span key={part.key} className={part.className} style={{ width: `${usage.size > 0 ? (breakdown[part.key] / usage.size) * 100 : 0}%` }} />
              ))}
            </span>
            <div className="space-y-1.5">
              {USAGE_PARTS.map((part) => (
                <div key={part.key} className="flex items-center gap-2">
                  <span className={cn('size-2 rounded-sm', part.className)} />
                  <span className="flex-1">{part.label}</span>
                  <span className="text-muted-foreground">{formatTokens(breakdown[part.key])}</span>
                </div>
              ))}
            </div>
          </>
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">分项按字数估算，总数以模型返回的用量为准。</p>
      </PopoverContent>
    </Popover>
  )
}
