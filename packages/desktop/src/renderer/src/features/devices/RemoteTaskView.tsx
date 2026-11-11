import { useEffect, useMemo } from 'react'
import type { SessionInfo } from '@diffra/core/types'
import { Eye, LoaderCircle, MousePointerClick, WifiOff } from 'lucide-react'
import type { PermissionRequestEvent } from '../../../../shared/ipc'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PermissionCard } from '@/features/session/PermissionCard'
import { Conversation } from '@/features/task/Conversation'
import { formatTime } from '@/lib/format'
import type { LiveTask } from '@/state/store'
import { useAppState } from '@/state/store'
import { RemoteComposer } from './RemoteComposer'
import { answerRemotePermission, dropRemoteTask, loadEarlierRemote, markRemoteOffline, type RemotePermission, remoteKey, sendRemote, stopRemote, subscribeRemote, unsubscribeRemote } from './remote-tasks'

// 远程会话没有本机的检查点、规范包这些，对话里依赖它们的按钮本来也都藏了（只读）
const REMOTE_INFO: SessionInfo = { bashPath: null, checkpoints: false, rulePacks: [], security: { staticCheck: false, lightScan: false }, checks: null }
const noop = () => {}

// 对方发来的确认换成本机确认卡片的格式：远程只有「允许一次」「拒绝」
function permissionEventOf(sessionId: string, permission: RemotePermission): PermissionRequestEvent {
  return {
    requestId: permission.requestId,
    sessionId,
    toolCall: permission.toolCall as PermissionRequestEvent['toolCall'],
    options: permission.options.map((option) => ({ optionId: option.optionId, name: option.name, kind: option.optionId === 'allow_once' ? 'allow_once' : 'reject_once' })),
  }
}

// 别的设备授权给本机的会话，复用本机任务的对话渲染（Conversation 的 readOnly：撤销、重新生成这些远程都不能做）。
// 项目开放了「可查看和操作」时底下有输入框和对方发来的确认
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

  const project = list?.projects.find((item) => item.id === task?.projectId)
  const control = project?.level === 'control'
  const permission = useMemo(() => (task?.permission ? permissionEventOf(sessionId, task.permission) : null), [task?.permission, sessionId])
  const live = useMemo<LiveTask | null>(
    () =>
      task
        ? {
            // 带上设备，和本机任务的 id 不会撞
            sessionId: `remote:${key}`,
            project: project?.name ?? '',
            noProject: false,
            title: task.title,
            modelLabel: '',
            planLabel: null,
            fallbackLabel: null,
            permissionMode: 'ask',
            design: false,
            planMode: false,
            info: REMOTE_INFO,
            turns: task.turns,
            running: task.running && task.status === 'ready',
            usage: task.usage,
            permission: null,
            queue: [],
            changeVersion: 0,
            unread: false,
            progress: task.progress,
          }
        : null,
    [task, key, project?.name],
  )

  if (!peer) return <p className="p-8 text-sm text-muted-foreground">本机已经不再连接这台设备。</p>

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="remote-task">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-4 text-sm">
        <Badge variant="outline" className="gap-1" data-testid="remote-task-level">
          {control ? <MousePointerClick className="size-3" /> : <Eye className="size-3" />}
          {control ? '可操作' : '只读'}
        </Badge>
        <span className="truncate text-muted-foreground">
          {peer.name}
          {project && ` · ${project.name}`}
        </span>
        <span className="min-w-0 truncate font-bold" data-testid="remote-task-title">
          {task?.title || '…'}
        </span>
        <span className="flex-1" />
        {task?.running && task.status === 'ready' && (
          <span className="flex items-center gap-1.5 text-muted-foreground" data-testid="remote-task-running">
            <LoaderCircle className="size-3.5 animate-spin" />
            运行中
          </span>
        )}
      </header>
      {(!online || task?.status === 'offline') && (
        <p className="flex items-center gap-2 border-b bg-soft px-4 py-2 text-sm text-muted-foreground" role="status" data-testid="remote-offline">
          <WifiOff className="size-4" />
          {online ? '和对方的连接断了，正在重连…' : `对方已离线${peer.lastSeenAt ? `，内容停在 ${formatTime(peer.lastSeenAt)}` : ''}`}
        </p>
      )}
      {task?.status === 'error' && (
        <p className="border-b px-4 py-2 text-sm text-destructive" role="alert">
          {task.error}
        </p>
      )}
      {task && task.start > 0 && task.status !== 'error' && (
        <div className="flex justify-center border-b py-1.5">
          <Button variant="ghost" size="sm" disabled={task.loadingEarlier || !online} onClick={() => void loadEarlierRemote(key)}>
            {task.loadingEarlier ? '读取中…' : `看更早的 ${task.start} 轮`}
          </Button>
        </div>
      )}
      {live && live.turns.length > 0 ? (
        <Conversation task={live} locate={null} onLocate={noop} onRestore={noop} onRegenerate={noop} readOnly />
      ) : (
        <p className="flex-1 p-8 text-sm text-muted-foreground">{task?.status === 'loading' || !task ? '读取中…' : '这个任务还没有内容。'}</p>
      )}
      {control && task && (
        <div className="px-8 pb-3.5">
          <div className="mx-auto flex max-w-(--content-max) flex-col gap-2">
            {permission && (
              <div className="[&_pre]:max-h-40">
                <PermissionCard request={permission} onRespond={(optionId) => answerRemotePermission(key, optionId === 'allow_once' ? 'allow_once' : 'reject')} />
              </div>
            )}
            <RemoteComposer deviceName={peer.name} running={task.running && task.status === 'ready'} disabled={!online || task.status !== 'ready'} onSend={(text) => sendRemote(key, text)} onStop={() => stopRemote(key)} />
          </div>
        </div>
      )}
    </div>
  )
}
