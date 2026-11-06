import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'
import type { CheckpointChange, SessionChecks } from '@diffra/core/types'
import { FolderOpen, Send, Square } from 'lucide-react'
import type { PermissionRequestEvent, ProjectState, SessionHandle } from '../../../../shared/ipc'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { errorMessage } from '@/lib/errors'
import { PermissionCard } from './PermissionCard'
import { ProjectPanel } from './ProjectPanel'
import { RestoreDialog } from './RestoreDialog'
import { applyUpdate, type TranscriptItem, type Turn } from './transcript'
import { TranscriptView } from './TranscriptView'

interface SessionViewProps {
  onOpenModels(): void
}

export function SessionView({ onOpenModels }: SessionViewProps) {
  const [project, setProject] = useState<ProjectState | null>(null)
  const [session, setSession] = useState<SessionHandle | null>(null)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [turns, setTurns] = useState<Turn[]>([])
  const [running, setRunning] = useState(false)
  const [usage, setUsage] = useState<{ used: number; size: number } | null>(null)
  const [permission, setPermission] = useState<PermissionRequestEvent | null>(null)
  const [draft, setDraft] = useState('')
  const [restore, setRestore] = useState<{ turnId: string; changes: CheckpointChange[] } | null>(null)
  // 事件监听只注册一次，用 ref 拿到当前会话 id
  const sessionIdRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const updateTurn = useCallback((turnId: string, change: (turn: Turn) => Turn) => {
    setTurns((current) => current.map((turn) => (turn.id === turnId ? change(turn) : turn)))
  }, [])

  const startSession = useCallback(async (target: ProjectState) => {
    sessionIdRef.current = null
    setSession(null)
    setTurns([])
    setUsage(null)
    setPermission(null)
    setSessionError(null)
    setHint(null)
    try {
      const handle = await window.diffra.createSession(target.path)
      sessionIdRef.current = handle.sessionId
      setSession(handle)
    } catch (error) {
      setSessionError(errorMessage(error))
    }
  }, [])

  const openProject = useCallback(
    async (target: ProjectState) => {
      setProject(target)
      await startSession(target)
    },
    [startSession],
  )

  useEffect(() => {
    window.diffra.getLastProject().then(
      (last) => {
        if (last) void openProject(last)
      },
      (error: unknown) => setSessionError(errorMessage(error)),
    )
  }, [openProject])

  useEffect(() => {
    const offUpdate = window.diffra.onSessionUpdate((notification) => {
      if (notification.sessionId !== sessionIdRef.current) return
      const { update } = notification
      if (update.sessionUpdate === 'usage_update') {
        setUsage({ used: update.used, size: update.size })
        return
      }
      setTurns((current) => {
        const last = current.at(-1)
        if (!last) return current
        return [...current.slice(0, -1), { ...last, items: applyUpdate(last.items, update) }]
      })
    })
    const offPermission = window.diffra.onPermissionRequest((request) => {
      if (request.sessionId === sessionIdRef.current) setPermission(request)
    })
    return () => {
      offUpdate()
      offPermission()
    }
  }, [])

  useEffect(() => {
    const element = scrollRef.current
    if (element && running) element.scrollTop = element.scrollHeight
  }, [turns, permission, running])

  const pickProject = async () => {
    try {
      const picked = await window.diffra.pickProject()
      if (picked) await openProject(picked)
    } catch (error) {
      setSessionError(errorMessage(error))
    }
  }

  const saveChecks = async (checks: SessionChecks) => {
    if (!project) return
    try {
      const updated = await window.diffra.saveProjectChecks(project.path, checks)
      setProject(updated)
      // 检查命令在新建会话时传给 core；还没开始干活就直接换一个新会话
      if (turns.length === 0) await startSession(updated)
      else setHint('检查命令已保存，从下一个新会话开始生效')
    } catch (error) {
      setSessionError(errorMessage(error))
    }
  }

  const send = async () => {
    const text = draft.trim()
    if (!session || !text || running) return
    const turnId = crypto.randomUUID()
    const userItem: TranscriptItem = { kind: 'user', id: `${turnId}-user`, text }
    setTurns((current) => [...current, { id: turnId, items: [userItem], stopReason: null, error: null }])
    setDraft('')
    setHint(null)
    setRunning(true)
    try {
      const stopReason = await window.diffra.sendPrompt(session.sessionId, turnId, text)
      updateTurn(turnId, (turn) => ({ ...turn, stopReason }))
    } catch (error) {
      updateTurn(turnId, (turn) => ({ ...turn, error: errorMessage(error) }))
    } finally {
      setRunning(false)
      setPermission(null)
    }
  }

  const stop = () => {
    if (!session) return
    window.diffra.cancelSession(session.sessionId).catch((error: unknown) => setSessionError(errorMessage(error)))
  }

  const respond = (optionId: string | null) => {
    if (!permission) return
    window.diffra.respondPermission(permission.requestId, optionId).catch((error: unknown) => setSessionError(errorMessage(error)))
    setPermission(null)
  }

  const openRestore = async (turnId: string) => {
    if (!session) return
    try {
      setRestore({ turnId, changes: await window.diffra.previewCheckpoint(session.sessionId, turnId) })
    } catch (error) {
      updateTurn(turnId, (turn) => ({ ...turn, error: errorMessage(error) }))
    }
  }

  const confirmRestore = async () => {
    if (!session || !restore) return
    const { turnId } = restore
    try {
      const restored = await window.diffra.restoreCheckpoint(session.sessionId, turnId)
      const notice: TranscriptItem = {
        kind: 'notice',
        id: crypto.randomUUID(),
        severity: 'info',
        title: `已撤销 ${restored.length} 个文件的改动`,
        description: restored.map((change) => change.path).join('\n'),
      }
      updateTurn(turnId, (turn) => ({ ...turn, items: [...turn.items, notice] }))
    } catch (error) {
      updateTurn(turnId, (turn) => ({ ...turn, error: errorMessage(error) }))
    } finally {
      setRestore(null)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      void send()
    }
  }

  if (!project) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-muted-foreground">选择一个项目文件夹，让 Diffra 在里面干活。</p>
        <Button onClick={pickProject}>
          <FolderOpen />
          选择项目文件夹
        </Button>
        {sessionError && <p className="text-sm text-destructive">{sessionError}</p>}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <ProjectPanel
        key={project.path}
        project={project}
        session={session}
        running={running}
        onPick={pickProject}
        onSaveChecks={saveChecks}
        onNewSession={() => void startSession(project)}
      />

      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
        {sessionError && (
          <Alert variant="destructive">
            <AlertTitle>无法开始会话</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>{sessionError}</p>
              <Button size="sm" variant="outline" onClick={onOpenModels}>
                去「模型」页
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
        {session && turns.length === 0 && (
          <p className="text-sm text-muted-foreground">描述你要做的事，比如「修复登录页的报错」或「给 utils 加单元测试」。</p>
        )}
        <TranscriptView
          turns={turns}
          projectPath={project.path}
          running={running}
          canRestore={session?.info.checkpoints ?? false}
          onRestore={(turnId) => void openRestore(turnId)}
        />
        {permission && <PermissionCard request={permission} onRespond={respond} />}
      </div>

      <div className="space-y-2 border-t px-6 py-3">
        <Textarea
          aria-label="任务"
          placeholder={session ? '描述任务，Ctrl+Enter 发送' : '会话还没准备好'}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={!session}
          className="min-h-20"
        />
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground" data-testid="context-usage">
            {usage ? `上下文 ${formatTokens(usage.used)} / ${formatTokens(usage.size)}` : ''}
          </span>
          <div className="ml-auto flex gap-2">
            {running ? (
              <Button variant="outline" onClick={stop}>
                <Square />
                停止
              </Button>
            ) : (
              <Button onClick={() => void send()} disabled={!session || draft.trim() === ''}>
                <Send />
                发送
              </Button>
            )}
          </div>
        </div>
      </div>

      <RestoreDialog changes={restore?.changes ?? null} onCancel={() => setRestore(null)} onConfirm={confirmRestore} />
    </div>
  )
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)
}
