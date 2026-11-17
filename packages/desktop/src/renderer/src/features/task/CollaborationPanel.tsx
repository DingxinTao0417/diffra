import { type FormEvent, useId, useRef, useState } from 'react'
import type { CollaborationAcceptance, CollaborationRole, CollaborationView } from '@diffra/core/types'
import { Check, CircleDashed, CirclePause, CircleX, Clock, GitFork, GitMerge, LoaderCircle, Send, ShieldCheck, Square, TriangleAlert, Users } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { errorMessage } from '@/lib/errors'
import { formatDuration, formatTime, formatTokens } from '@/lib/format'
import { CardShell } from './cards/CardShell'

type Worker = CollaborationView['workers'][number]
type WorkerAction = { action: 'message' | 'interrupt' | 'retry' | 'integrate'; workerId: string; message?: string }

export interface CollaborationPanelProps {
  view: CollaborationView
  readOnly?: boolean
  onAction: (action: WorkerAction) => Promise<void>
}

const RECENT_MESSAGE_LIMIT = 10
const LEAD_ID = 'lead'
const ROLE_LABELS: Record<CollaborationRole, string> = { explorer: '探索', implementer: '实现', reviewer: '评审', tester: '测试' }
const WORKER_LABELS: Record<Worker['status'], string> = {
  queued: '排队', running: '进行中', completed: '完成', failed: '失败', cancelled: '已取消', interrupted: '已中断',
}
const TASK_LABELS: Record<CollaborationView['tasks'][number]['status'], string> = {
  pending: '待处理', in_progress: '进行中', completed: '完成', deleted: '已删除',
}
const ACCEPTANCE_LABELS: Record<CollaborationAcceptance['status'], string> = {
  pending: '待验收', reviewing: '评审中', testing: '测试中', passed: '验收通过', blocked: '验收受阻',
}
const ACTION_LABELS: Record<WorkerAction['action'], string> = {
  message: '发送消息', interrupt: '停止', retry: '恢复或重试', integrate: '整合改动',
}

function actionAvailable(worker: Worker, action: WorkerAction['action']): boolean {
  switch (action) {
    case 'interrupt': return worker.status === 'running' || worker.status === 'queued'
    case 'retry': return worker.status === 'interrupted' || worker.status === 'failed' || worker.status === 'cancelled'
    case 'integrate': return worker.status === 'completed' && worker.isolated && worker.hasUnmergedChanges && !worker.readOnly
    case 'message': return true
  }
}

function WorkerStatus({ status }: { status: Worker['status'] }) {
  const Icon = status === 'running' ? LoaderCircle : status === 'queued' ? Clock : status === 'completed' ? Check : status === 'failed' ? CircleX : status === 'interrupted' ? CirclePause : Square
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 text-xs', status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
      <Icon className={cn('size-3.5 shrink-0', status === 'running' && 'animate-spin motion-reduce:animate-none')} aria-hidden="true" />
      {WORKER_LABELS[status]}
    </span>
  )
}

export function CollaborationPanel({ view, readOnly = false, onAction }: CollaborationPanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<WorkerAction | null>(null)
  const [feedback, setFeedback] = useState<{ workerId: string; error: boolean; text: string } | null>(null)
  const [integratingId, setIntegratingId] = useState<string | null>(null)
  const pendingRef = useRef(false)
  const messageId = useId()
  const detailId = useId()
  const selected = view.workers.find((worker) => worker.id === selectedId) ?? view.workers[0]
  const integrating = view.workers.find((worker) => worker.id === integratingId)
  const memberName = (id: string) => id === LEAD_ID ? '主智能体' : view.workers.find((worker) => worker.id === id)?.name ?? id
  const count = (status: Worker['status']) => view.workers.filter((worker) => worker.status === status).length
  const unmerged = view.workers.filter((worker) => worker.hasUnmergedChanges).length
  const draft = selected ? drafts[selected.id] ?? '' : ''

  const perform = async (action: WorkerAction) => {
    const worker = view.workers.find((candidate) => candidate.id === action.workerId)
    if (readOnly || pendingRef.current || !worker || !actionAvailable(worker, action.action)) return
    if (action.action === 'message' && !action.message?.trim()) return
    pendingRef.current = true
    setPending(action)
    setFeedback(null)
    try {
      await onAction(action)
    } catch (error: unknown) {
      setFeedback({ workerId: worker.id, error: true, text: `${ACTION_LABELS[action.action]}失败：${errorMessage(error)}。请检查后重试。` })
      return
    } finally {
      pendingRef.current = false
      setPending(null)
    }
    if (action.action === 'message') setDrafts((current) => ({ ...current, [worker.id]: '' }))
    const text = action.action === 'message' ? '消息已发送，送达状态见消息列表。' : `${ACTION_LABELS[action.action]}请求已完成，结果以最新状态为准。`
    setFeedback({ workerId: worker.id, error: false, text })
  }

  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (selected) void perform({ action: 'message', workerId: selected.id, message: draft.trim() })
  }

  return (
    <CardShell className="@container min-w-0 max-w-full" title="多智能体协作" icon={<Users className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />} data-testid="collaboration-panel" data-read-only={readOnly}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" data-testid="collaboration-counts" aria-label="协作状态概览">
        <span className="font-bold text-foreground">最多 {view.parallelism} 个工人并行</span>
        <span>进行中 {count('running')}</span>
        <span>排队 {count('queued')}</span>
        <span>中断 {count('interrupted')}</span>
        <span>完成 {count('completed')}</span>
        {count('failed') > 0 && <span className="text-destructive">失败 {count('failed')}</span>}
        {count('cancelled') > 0 && <span>取消 {count('cancelled')}</span>}
      </div>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground" data-testid="collaboration-isolation">
        <GitFork className="size-3.5 shrink-0" aria-hidden="true" />
        <span>worktree 隔离 {view.workers.filter((worker) => worker.isolated).length} / {view.workers.length}</span>
        <span className={unmerged > 0 ? 'text-warning' : undefined}>未整合改动：{unmerged} 个工人</span>
        <span>完成不等于验收通过</span>
      </p>
      {readOnly && <p className="text-xs text-muted-foreground">只读视图：可以查看状态，不能发送消息、停止、恢复或整合改动。</p>}
      {pending && <p role="status" className="text-xs break-words text-muted-foreground">正在{ACTION_LABELS[pending.action]}：{memberName(pending.workerId)}…</p>}
      {feedback && <p role={feedback.error ? 'alert' : 'status'} className={cn('text-xs break-words whitespace-pre-wrap [overflow-wrap:anywhere]', feedback.error ? 'text-destructive' : 'text-muted-foreground')}>{memberName(feedback.workerId)}：{feedback.text}</p>}

      {view.workers.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">还没有协作工人。主智能体委派任务后，这里会显示进度、消息和交回的结果。</p>
      ) : (
        <div className="grid min-w-0 grid-cols-1 items-start gap-3 @2xl:grid-cols-3">
          <ul className="flex min-w-0 flex-col gap-1" aria-label="协作工人">
            {view.workers.map((worker) => (
              <li key={worker.id} className="min-w-0" data-testid="collaboration-worker" data-worker-id={worker.id} data-status={worker.status}>
                <button type="button" aria-pressed={selected?.id === worker.id} aria-controls={detailId} onClick={() => setSelectedId(worker.id)} className={cn('flex w-full min-w-0 flex-col gap-1 rounded-lg border px-2.5 py-2 text-left outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring', selected?.id === worker.id ? 'border-input bg-soft' : 'border-transparent')}>
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="min-w-0 flex-1 font-bold break-words [overflow-wrap:anywhere]">{worker.name}</span>
                    <WorkerStatus status={worker.status} />
                  </span>
                  <span className="line-clamp-2 text-xs break-words text-muted-foreground [overflow-wrap:anywhere]">{worker.task}</span>
                  <span className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                    <span>{ROLE_LABELS[worker.role]}</span>
                    <span>{worker.readOnly ? '只读' : '可写'}</span>
                    <span>{worker.isolated ? 'worktree 隔离' : '未隔离'}</span>
                    {worker.hasUnmergedChanges && <span className={selected?.id === worker.id ? 'text-foreground' : 'text-warning'}>有未整合改动</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {selected && (
            <section id={detailId} className="flex min-w-0 flex-col gap-3 rounded-lg border p-3 @2xl:col-span-2" aria-label={`工人 ${selected.name} 的详情`} aria-busy={pending?.workerId === selected.id} data-testid="collaboration-worker-detail" data-worker-id={selected.id}>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h3 className="min-w-0 font-bold break-words [overflow-wrap:anywhere]">{selected.name}</h3>
                <WorkerStatus status={selected.status} />
              </div>
              <p className="max-h-48 overflow-y-auto text-sm break-words whitespace-pre-wrap [overflow-wrap:anywhere]">{selected.task}</p>
              <dl className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-1 text-xs @sm:grid-cols-2">
                <div className="min-w-0 break-words [overflow-wrap:anywhere]"><dt className="inline text-muted-foreground">角色：</dt><dd className="inline">{ROLE_LABELS[selected.role]}{selected.typeName ? `（${selected.typeName}）` : ''} · {selected.readOnly ? '只读' : '可写'}</dd></div>
                <div><dt className="inline text-muted-foreground">上下文：</dt><dd className="inline">{selected.context === 'fresh' ? 'fresh · 独立上下文' : 'fork · 继承主智能体上下文'}</dd></div>
                <div><dt className="inline text-muted-foreground">开始：</dt><dd className="inline">{selected.startedAt === null ? '尚未开始' : formatTime(selected.startedAt)}</dd></div>
                <div><dt className="inline text-muted-foreground">结束：</dt><dd className="inline">{selected.endedAt === null ? '尚未结束' : formatTime(selected.endedAt)}</dd></div>
                <div><dt className="inline text-muted-foreground">Token：</dt><dd className="inline tabular-nums" title={selected.tokens.toLocaleString()}>{formatTokens(selected.tokens)}</dd></div>
                {selected.startedAt !== null && selected.endedAt !== null && <div><dt className="inline text-muted-foreground">用时：</dt><dd className="inline tabular-nums">{formatDuration(selected.endedAt - selected.startedAt)}</dd></div>}
                <div><dt className="inline text-muted-foreground">隔离：</dt><dd className="inline">{selected.isolated ? '独立 worktree' : '无 worktree'}</dd></div>
                <div><dt className="inline text-muted-foreground">结果版本：</dt><dd className="inline tabular-nums">r{selected.resultRevision}</dd></div>
              </dl>
              <p className={cn('text-xs', selected.hasUnmergedChanges ? 'text-warning' : 'text-muted-foreground')}>{selected.hasUnmergedChanges ? '隔离工作区有未整合改动，尚未写入项目。' : '没有待整合的改动。'}</p>
              <Paths label="认领文件" paths={selected.files} />
              <Paths label="认领节点" paths={selected.nodes} />
              <Paths label="改动文件" paths={selected.edited} />
              <div className="flex min-w-0 flex-col gap-1" data-testid="collaboration-worker-result">
                <h4 className="text-xs font-bold">交回结果</h4>
                <p className="max-h-48 overflow-y-auto text-sm break-words whitespace-pre-wrap [overflow-wrap:anywhere]">{selected.summary ?? (selected.status === 'running' || selected.status === 'queued' ? '尚未交回结果。' : '没有交回摘要，请查看待处理问题或发送消息后重试。')}</p>
                {selected.issues && <p className="max-h-48 overflow-y-auto text-xs break-words whitespace-pre-wrap text-warning [overflow-wrap:anywhere]">待处理：{selected.issues}</p>}
                {selected.verdict && <p className="text-xs text-muted-foreground">验证结论：{selected.verdict === 'passed' ? (selected.status === 'completed' ? '通过' : '已记录通过结论，但本次未完成') : selected.verdict === 'blocked' ? '受阻' : '需要修改'}</p>}
                {selected.checks.length > 0 && (
                  <ul className="min-w-0 text-xs" aria-label="工人检查结果">
                    {selected.checks.map((check, index) => <li key={`${index}:${check.command}`} className="flex min-w-0 items-start gap-2 py-0.5"><span className="shrink-0 text-muted-foreground">{check.succeeded ? '命令通过' : '命令未通过'}</span><code className="min-w-0 flex-1 overflow-x-auto whitespace-pre">{check.command}</code></li>)}
                  </ul>
                )}
              </div>
              <RecentMessages messages={view.messages.filter((message) => message.sender === selected.id || message.recipient === selected.id)} memberName={memberName} />
              {!readOnly && (
                <>
                  <form className="flex min-w-0 flex-col gap-1.5" onSubmit={send}>
                    <label htmlFor={messageId} className="text-xs font-bold">给这个工人发消息</label>
                    <Textarea id={messageId} value={draft} onChange={(event) => setDrafts((current) => ({ ...current, [selected.id]: event.target.value }))} disabled={pending !== null} placeholder="补充要求、提醒依赖或说明待处理问题" className="max-h-48 min-w-0 resize-y text-sm [overflow-wrap:anywhere]" />
                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="submit" size="sm" disabled={pending !== null || !draft.trim()}><Send aria-hidden="true" />发送消息</Button>
                      {selected.status !== 'running' && <span className="text-xs text-muted-foreground">工人当前未运行，送达状态见消息列表。</span>}
                    </div>
                  </form>
                  <div className="flex flex-wrap items-center gap-2" aria-label="工人控制">
                    <Button type="button" variant="outline" size="sm" disabled={pending !== null || !actionAvailable(selected, 'interrupt')} onClick={() => void perform({ action: 'interrupt', workerId: selected.id })}><Square aria-hidden="true" />停止工人</Button>
                    <Button type="button" variant="outline" size="sm" disabled={pending !== null || !actionAvailable(selected, 'retry')} onClick={() => void perform({ action: 'retry', workerId: selected.id })}>{selected.status === 'interrupted' ? '恢复工人' : '重试工人'}</Button>
                    <Button type="button" variant="outline" size="sm" disabled={pending !== null || !actionAvailable(selected, 'integrate')} title="只有已完成的可写工人存在未整合 worktree 改动时才能整合" onClick={() => setIntegratingId(selected.id)}><GitMerge aria-hidden="true" />整合改动</Button>
                  </div>
                  <p className="text-xs text-muted-foreground">停止只影响这个工人，已有改动保留；恢复或重试会继续使用模型。</p>
                </>
              )}
            </section>
          )}
        </div>
      )}

      <SharedTasks tasks={view.tasks} memberName={memberName} />
      <Acceptance acceptance={view.acceptance} memberName={memberName} />
      <Dialog open={!readOnly && integrating !== undefined} onOpenChange={(open) => !open && setIntegratingId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="break-words [overflow-wrap:anywhere]">整合「{integrating?.name}」的改动？</DialogTitle>
            <DialogDescription>会把这个工人的未整合改动写入当前项目。请先确认交回的结果；整合改动不代表验收通过。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setIntegratingId(null)}>取消</Button>
            <Button type="button" disabled={pending !== null || !integrating || !actionAvailable(integrating, 'integrate')} onClick={() => { if (integrating) { setIntegratingId(null); void perform({ action: 'integrate', workerId: integrating.id }) } }}>确认整合</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </CardShell>
  )
}

function Paths({ label, paths }: { label: string; paths: string[] }) {
  if (paths.length === 0) return null
  return <div className="min-w-0 text-xs"><p className="mb-1 text-muted-foreground">{label}</p><ul className="max-h-24 min-w-0 overflow-auto rounded-md bg-muted/40 px-2 py-1 font-mono">{paths.map((path) => <li key={path} className="break-words whitespace-pre-wrap [overflow-wrap:anywhere]">{path}</li>)}</ul></div>
}

function RecentMessages({ messages, memberName }: { messages: CollaborationView['messages']; memberName: (id: string) => string }) {
  const recent = messages.slice(-RECENT_MESSAGE_LIMIT)
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="collaboration-messages">
      <h4 className="text-xs font-bold">最近消息{messages.length > RECENT_MESSAGE_LIMIT ? `（最近 ${RECENT_MESSAGE_LIMIT} 条，共 ${messages.length} 条）` : ''}</h4>
      {recent.length === 0 ? <p className="text-xs text-muted-foreground">还没有与这个工人的消息往来。</p> : (
        <ol className="max-h-64 min-w-0 space-y-2 overflow-y-auto rounded-md bg-muted/40 p-2">
          {recent.map((message) => (
            <li key={message.id} className="min-w-0" data-testid="collaboration-message" data-status={message.status}>
              <div className="flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 text-xs break-words text-muted-foreground [overflow-wrap:anywhere]"><span>{memberName(message.sender)} → {memberName(message.recipient)}</span><time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time><span>{message.status === 'pending' ? '待送达' : '已送达'}</span></div>
              <p className="text-xs break-words whitespace-pre-wrap [overflow-wrap:anywhere]">{message.content}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function SharedTasks({ tasks, memberName }: { tasks: CollaborationView['tasks']; memberName: (id: string) => string }) {
  return (
    <section className="flex min-w-0 flex-col gap-2 border-t pt-3" aria-label="共享任务" data-testid="collaboration-tasks">
      <h3 className="text-sm font-bold">共享任务</h3>
      {tasks.length === 0 ? <p className="text-xs text-muted-foreground">还没有共享任务。任务建立后，这里会显示负责人、依赖和写入范围。</p> : (
        <div className="min-w-0 max-w-full overflow-x-auto rounded-lg border outline-none focus-visible:ring-2 focus-visible:ring-ring" role="region" aria-label="共享任务表，可横向滚动" tabIndex={0}>
          <table className="w-full min-w-xl table-fixed text-left text-xs">
            <thead className="bg-muted/40 text-muted-foreground"><tr><th scope="col" className="w-1/3 px-2.5 py-2 font-normal">任务 / 版本</th><th scope="col" className="px-2.5 py-2 font-normal">状态 / 负责人</th><th scope="col" className="px-2.5 py-2 font-normal">依赖</th><th scope="col" className="px-2.5 py-2 font-normal">写入范围</th></tr></thead>
            <tbody className="divide-y align-top">
              {tasks.map((task) => (
                <tr key={task.id} data-testid="collaboration-task" data-status={task.status} data-ready={task.ready}>
                  <td className="px-2.5 py-2 break-words [overflow-wrap:anywhere]"><p className="font-bold">{task.subject}</p><p className="text-muted-foreground">{task.id} · revision {task.revision}</p>{task.description && <p className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap text-muted-foreground">{task.description}</p>}</td>
                  <td className="px-2.5 py-2 break-words [overflow-wrap:anywhere]"><p>{TASK_LABELS[task.status]}</p>{task.status === 'pending' && <p className={task.ready ? 'text-muted-foreground' : 'text-warning'}>{task.ready ? '就绪 · ready' : '依赖阻塞'}</p>}<p className="mt-1 text-muted-foreground">{task.owner === null ? '未认领' : memberName(task.owner)}</p></td>
                  <td className="px-2.5 py-2 break-words [overflow-wrap:anywhere]">{task.blockedBy.length === 0 ? <span className="text-muted-foreground">无依赖</span> : <ul className="space-y-1">{task.blockedBy.map((id) => { const dependency = tasks.find((candidate) => candidate.id === id); return <li key={id} title={dependency?.subject}>{id}<span className="block text-muted-foreground">{dependency?.status === 'completed' ? '已完成' : '待完成'}</span></li> })}</ul>}</td>
                  <td className="px-2.5 py-2 break-words [overflow-wrap:anywhere]">{task.writeScopes.length === 0 ? <span className="text-muted-foreground">未声明范围</span> : <ul>{task.writeScopes.map((scope) => <li key={scope}><code>{scope}</code></li>)}</ul>}{task.writeScopeWarnings.map((warning, index) => <p key={`${index}:${warning}`} className="mt-1 text-warning" data-testid="collaboration-scope-warning"><TriangleAlert className="mr-1 inline size-3.5" aria-hidden="true" />{warning}</p>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function Acceptance({ acceptance, memberName }: { acceptance: CollaborationAcceptance; memberName: (id: string) => string }) {
  const passed = acceptance.status === 'passed'
  return (
    <section className="flex min-w-0 flex-col gap-1.5 border-t pt-3" aria-label="协作验收" data-testid="collaboration-acceptance" data-status={acceptance.status}>
      {/* success-color-allow: 仅 core 已确认 passed 的协作验收结果使用成功色，工人完成不算验证通过 */}
      <h3 className={cn('flex flex-wrap items-center gap-1.5 text-sm font-bold', passed ? 'text-success' : acceptance.status === 'blocked' ? 'text-warning' : 'text-foreground')}>
        {passed ? <ShieldCheck className="size-4 shrink-0" aria-hidden="true" /> : <CircleDashed className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
        {ACCEPTANCE_LABELS[acceptance.status]}
      </h3>
      <p className="text-xs break-words text-muted-foreground [overflow-wrap:anywhere]">评审：{acceptance.reviewerId === null ? '尚未分配' : memberName(acceptance.reviewerId)}；测试：{acceptance.testerId === null ? '尚未分配' : memberName(acceptance.testerId)}</p>
      {acceptance.reason && <p className="max-h-48 overflow-y-auto text-xs break-words whitespace-pre-wrap [overflow-wrap:anywhere]">{acceptance.reason}</p>}
      {!passed && <p className="text-xs text-muted-foreground">评审和测试确认通过前，不把任务标记为验收成功。</p>}
    </section>
  )
}
