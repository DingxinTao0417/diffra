import { useCallback, useEffect, useMemo, useState } from 'react'
import { ASK_USER_SKIP, ASK_USER_SUBMIT, type PermissionMode, type SessionChecks, type SessionInfo } from '@diffra/core/types'
import { Archive, Eye, MousePointerClick, ShieldAlert, WifiOff } from 'lucide-react'
import type { PermissionRequestEvent, ProjectState } from '../../../../shared/ipc'
import { REMOTE_API } from '../../../../shared/remote'
import { type ModelRef, NO_HOOKS } from '../../../../shared/settings'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PermissionCard } from '@/features/session/PermissionCard'
import type { Turn } from '@/features/session/transcript'
import { Composer, type ComposerCommand } from '@/features/task/Composer'
import { composerDraftKey } from '@/features/task/composer-drafts'
import type { RemoteTaskSource } from '@/features/task/remote-task'
import { TaskPage } from '@/features/task/TaskView'
import { errorMessage } from '@/lib/errors'
import { formatTime } from '@/lib/format'
import type { LiveTask } from '@/state/store'
import { showToast, useAppState } from '@/state/store'
import { RemoteComposer } from './RemoteComposer'
import { RemoteTerminalPanel } from './RemoteTerminalPanel'
import {
  answerRemotePermission,
  changeRemote,
  dropRemoteTask,
  loadEarlierRemote,
  loadRemoteDetails,
  loadRemoteProviders,
  loadRemoteToolOutput,
  markRemoteOffline,
  type RemotePermission,
  remoteBranches,
  remoteCommands,
  remoteDiff,
  remoteKey,
  remoteRestorePreview,
  remoteSkills,
  retryRemote,
  sendRemote,
  stopRemote,
  subscribeRemote,
  unsubscribeRemote,
} from './remote-tasks'

// 对方是 0.3.x、或者配置还没取到时：没有检查点（不显示文件改动）、规范包这些
const REMOTE_INFO: SessionInfo = { bashPath: null, checkpoints: false, rulePacks: [], security: {}, checks: null }
// 订阅失败后自动重试：隔 2、4、8 秒各一次
const AUTO_RETRIES = 3

// 对方发来的确认换成本机确认卡片的格式：确认只有「允许一次」「拒绝」；提问（第 673 步）是它的选项、提交和不答
function permissionEventOf(sessionId: string, permission: RemotePermission): PermissionRequestEvent {
  const kindOf = (optionId: string) => (optionId === 'allow_once' || optionId === ASK_USER_SUBMIT ? 'allow_once' : optionId === 'reject' || optionId === ASK_USER_SKIP ? 'reject_once' : 'allow_always')
  return {
    requestId: permission.requestId,
    sessionId,
    toolCall: permission.toolCall as PermissionRequestEvent['toolCall'],
    options: permission.options.map((option) => ({ optionId: option.optionId, name: option.name, kind: kindOf(option.optionId) })),
  }
}

// 文件可能变了的信号（任务监控、审阅改动据此重新向对方要改动）：编辑、执行这类步骤完成的个数，加上结束的轮数、撤销过的轮数和提示（「已撤销……」）
function changeVersionOf(turns: Turn[]): number {
  let version = 0
  for (const turn of turns) {
    if (turn.endedAt) version++
    if (turn.restoredAt) version++
    for (const item of turn.items) {
      if (item.kind === 'notice') version++
      else if (item.kind === 'tool' && item.status === 'completed' && (item.toolKind === 'edit' || item.toolKind === 'execute' || item.toolKind === 'delete' || item.toolKind === 'move')) version++
    }
  }
  return version
}

// 别的设备授权给本机的会话：借用本机的任务页（TaskPage），顶栏标题前标出设备和级别；对话、任务监控、审阅改动和本机一样，数据向对方要。
// 只读时撤销、重新生成这些不显示；项目开放了「可查看和操作」时底下有输入框和对方发来的确认
export function RemoteTaskView({ deviceId, sessionId }: { deviceId: string; sessionId: string }) {
  const key = remoteKey(deviceId, sessionId)
  const peer = useAppState((state) => state.remote?.peers.find((item) => item.deviceId === deviceId) ?? null)
  const task = useAppState((state) => state.remoteTasks[key])
  const list = useAppState((state) => state.remoteLists[deviceId]?.list ?? null)
  const online = peer?.online ?? false
  const generation = task?.generation ?? 0

  // 对方在线时订阅，离开、对方掉线、要求重来时退订再订
  useEffect(() => {
    if (!online) {
      markRemoteOffline(key)
      return
    }
    void subscribeRemote(deviceId, sessionId)
    return () => unsubscribeRemote(deviceId, sessionId)
  }, [deviceId, sessionId, online, generation, key])
  useEffect(() => () => dropRemoteTask(key), [key])
  // 订阅失败、对方又在线时自动再试几次：网络抖一下、对方刚醒过来都会偶尔失败一次；对方明确拒绝的不试
  const retries = task?.retries ?? 0
  const failed = task?.status === 'error' && !task.refused
  useEffect(() => {
    if (!failed || !online || retries >= AUTO_RETRIES) return
    const timer = setTimeout(() => retryRemote(key, true), 2000 * 2 ** retries)
    return () => clearTimeout(timer)
  }, [failed, online, retries, key])
  // 任务页的配置：订阅上之后、一轮开始和结束时（对方可能换了模型、切了分支）向对方要；对方是 0.3.x 时不要（它不认这个请求）
  const supported = (list?.api ?? 1) >= REMOTE_API
  const ready = task?.status === 'ready'
  const running = task?.running ?? false
  useEffect(() => {
    if (ready && supported) void loadRemoteDetails(key)
  }, [ready, running, supported, key])

  // 订阅成功之前（或者失败了）先按列表里的信息显示标题和能不能操作
  const listed = list?.sessions.find((item) => item.sessionId === sessionId)
  const project = list?.projects.find((item) => item.id === (task?.projectId || listed?.projectId))
  const control = project?.level === 'control'
  const full = project?.full === true
  const permission = useMemo(() => (task?.permission ? permissionEventOf(sessionId, task.permission) : null), [task?.permission, sessionId])
  const loadToolOutput = useCallback((toolCallId: string) => loadRemoteToolOutput(key, toolCallId), [key])
  // 对方开放了「可查看和操作」（对方是新版）：模型、Skill、压缩、撤销、重新生成这些都经对方做
  const operable = control && supported
  const providers = task?.providers
  const source = useMemo<RemoteTaskSource>(
    () => ({
      diff: (turnId: string) => remoteDiff(key, turnId),
      ...(operable
        ? {
            providers,
            loadProviders: () => void loadRemoteProviders(key),
            listSkills: () => remoteSkills(key),
            listCommands: () => remoteCommands(key),
            compact: () => changeRemote(key, { method: 'session.compact' }),
            previewRestore: (turnId: string) => remoteRestorePreview(key, turnId),
            restore: (turnId: string) => changeRemote(key, { method: 'session.restore', turnId }),
            regenerate: (turnId: string) => changeRemote(key, { method: 'session.regenerate', turnId }),
            listBranches: () => remoteBranches(key),
            switchBranch: (branch: string) => changeRemote(key, { method: 'project.switchBranch', branch }),
          }
        : {}),
    }),
    [key, operable, providers],
  )
  // 「先出计划」开关在本机记，发消息时带上
  const [planMode, setPlanMode] = useState(false)
  const details = task?.details ?? null
  const turns = task?.turns
  const changeVersion = useMemo(() => changeVersionOf(turns ?? []), [turns])
  const title = task?.title || listed?.title || '…'
  const live = useMemo<LiveTask | null>(
    () =>
      task
        ? {
            // 带上设备，和本机任务的 id 不会撞
            sessionId: `remote:${key}`,
            project: project?.name ?? '',
            noProject: false,
            title,
            modelLabel: details?.modelLabel ?? '',
            ...(details?.modelRef ? { modelRef: details.modelRef as unknown as ModelRef } : {}),
            planLabel: details?.planLabel ?? null,
            fallbackLabel: details?.fallbackLabel ?? null,
            permissionMode: (details?.permissionMode ?? 'ask') as PermissionMode,
            design: false,
            planMode: details?.planMode ?? false,
            info: details ? (details.info as unknown as SessionInfo) : REMOTE_INFO,
            turns: task.turns,
            running: task.running && task.status === 'ready',
            usage: task.usage,
            permission: null,
            queue: [],
            changeVersion,
            unread: false,
            suggestion: null,
            progress: task.progress,
          }
        : null,
    [task, key, project?.name, title, details, changeVersion],
  )
  const projectState = useMemo<ProjectState | null>(
    () => (details?.project ? { path: project?.name ?? '', checks: details.project.checks as unknown as SessionChecks, readOnlyPaths: details.project.readOnlyPaths, allowedCommands: [], hooks: NO_HOOKS, security: {} } : null),
    [details, project?.name],
  )

  if (!peer) return <p className="p-8 text-sm text-muted-foreground">本机已经不再连接这台设备。</p>

  const badge = (
    <>
      <Badge variant="outline" className="shrink-0 gap-1" data-testid="remote-task-level">
        {full ? <ShieldAlert className="size-3" /> : control ? <MousePointerClick className="size-3" /> : <Eye className="size-3" />}
        {full ? '完全控制' : control ? '可操作' : '只读'}
      </Badge>
      <span className="shrink-0 text-muted-foreground">
        {peer.name}
        {project && ` · ${project.name}`}
      </span>
    </>
  )
  const notice = (
    <>
      {(!online || task?.status === 'offline') && (
        <p className="flex items-center gap-2 border-b bg-soft px-4 py-2 text-sm text-muted-foreground" role="status" data-testid="remote-offline">
          <WifiOff className="size-4" />
          {online ? '和对方的连接断了，正在重连…' : `对方已离线${peer.lastSeenAt ? `，内容停在 ${formatTime(peer.lastSeenAt)}` : ''}`}
        </p>
      )}
      {task?.status === 'error' && (
        <div className="flex items-center gap-2 border-b px-4 py-1.5 text-sm" role="alert" data-testid="remote-error">
          <span className="min-w-0 flex-1 text-destructive">{task.error}</span>
          <Button variant="outline" size="sm" disabled={!online} onClick={() => retryRemote(key, false)}>
            重试
          </Button>
        </div>
      )}
    </>
  )

  // 还没取到第一页：只有顶栏和提示
  if (!task || !live || (live.turns.length === 0 && task.status !== 'ready')) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="remote-task">
        <header className="app-drag flex h-12 shrink-0 items-center gap-2 border-b border-border/70 pr-3 pl-5">
          {badge}
          <span className="min-w-0 truncate font-bold" data-testid="task-title">
            {title}
          </span>
        </header>
        {notice}
        <p className="flex-1 p-8 text-sm text-muted-foreground">{task?.status === 'error' ? '' : '读取中…'}</p>
      </div>
    )
  }

  const toastFailure = (action: string) => (error: unknown) => showToast(`${action}失败：${errorMessage(error)}`)
  const commands: ComposerCommand[] = live.running ? [] : [{ id: 'compact', label: 'compact', description: '手动压缩早期上下文，保留最近内容和完整聊天历史', keywords: ['compact', '压缩', '上下文'], icon: Archive, run: () => void changeRemote(key, { method: 'session.compact' }).catch(toastFailure('压缩')) }]
  const composer = control ? (
    <>
      {permission && (
        <div className="[&_pre]:max-h-40">
          <PermissionCard
            request={permission}
            onRespond={(optionId, answers) =>
              optionId?.startsWith('ask-user-') ? answerRemotePermission(key, optionId, answers) : answerRemotePermission(key, optionId === 'allow_once' ? 'allow_once' : 'reject')
            }
          />
        </div>
      )}
      {operable ? (
        <Composer
          size="normal"
          draftKey={composerDraftKey.task(live.sessionId)}
          projectPath={null}
          mcpTarget={{ sessionId: live.sessionId }}
          commands={commands}
          disabled={!online || task.status !== 'ready'}
          running={live.running}
          permissionMode={live.permissionMode}
          onPermissionModeChange={(mode) => void changeRemote(key, { method: 'session.setPermissionMode', mode }).catch(toastFailure('切换权限模式'))}
          modelLabel={live.modelLabel || null}
          modelRef={live.modelRef}
          modelLocked={live.running}
          onModelChange={(ref) => void changeRemote(key, { method: 'session.setModel', ref }).catch(toastFailure('切换模型'))}
          planMode={planMode}
          onPlanModeChange={setPlanMode}
          onSend={(text, extras) => sendRemote(key, text, { ...extras, plan: planMode })}
          onStop={() => stopRemote(key)}
        />
      ) : (
        // 对方是 0.3.x：只能发文字
        <RemoteComposer deviceName={peer.name} running={task.running && task.status === 'ready'} disabled={!online || task.status !== 'ready'} onSend={(text) => sendRemote(key, text)} onStop={() => stopRemote(key)} />
      )}
    </>
  ) : null

  return (
    <div className="h-full min-h-0" data-testid="remote-task">
      <TaskPage
        task={live}
        remote={{
          badge,
          notice,
          composer,
          readOnly: true,
          earlier: online && task.status !== 'error' ? { count: task.start, loading: task.loadingEarlier, load: () => void loadEarlierRemote(key) } : undefined,
          loadToolOutput,
          source,
          project: projectState,
          branch: details?.branch ?? null,
          device: peer.name,
          ...(full && supported
            ? {
                // 对方电脑上的终端（「完全控制」），在右侧栏：面板关了、离开任务时对方的终端结束
                terminal: <RemoteTerminalPanel deviceId={deviceId} sessionId={sessionId} deviceName={peer.name} />,
              }
            : {}),
        }}
      />
    </div>
  )
}
