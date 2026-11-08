import { useState } from 'react'
import { Check, ChevronRight, CircleAlert, CircleCheck, CircleDashed, CirclePause, CircleX, Info, LoaderCircle } from 'lucide-react'
import type { ProjectState } from '../../../../shared/ipc'
import { cn } from 'cn'
import { DiffCounts } from '@/features/session/DiffView'
import { useMcpStatus } from '@/features/mcp/useMcpStatus'
import { ProjectSettingsDialog } from '@/features/project/ProjectSettingsDialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { turnVerdict, type VerdictTone } from '@/lib/turn-verdict'
import { openSettings, runDeepScan } from '@/state/actions'
import { type LiveTask, store, useAppState } from '@/state/store'
import { splitTitle } from './Conversation'
import { SidePanel } from './SidePanel'
import type { TaskDiff } from './useTaskDiff'

const COLLAPSED_CHANGED_FILE_LIMIT = 10
const FAILED_COMMAND_LIMIT = 3

interface MonitorPanelProps {
  task: LiveTask
  project: ProjectState | null
  branch: string | null
  diff: TaskDiff | null
  onProjectSaved(project: ProjectState): void
  // 点了深度扫描，由任务页弹确认框
  onDeepScan(scope: 'task' | 'project'): void
  onLocate(itemId: string): void
}

export function MonitorPanel({ task, project, branch, diff, onProjectSaved, onDeepScan, onLocate }: MonitorPanelProps) {
  const [editing, setEditing] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null)
  const filesExpanded = expandedSessionId === task.sessionId
  const deepScanEnabled = useAppState((state) => state.settings?.security.deepScan ?? false)
  const mcp = useMcpStatus({ sessionId: task.sessionId })
  const verdict = turnVerdict(task)
  const verdictTurn = task.turns.findLast((turn) => turn.kind === 'prompt' || turn.kind === 'goal')
  const failedCommands = verdictTurn?.items.flatMap((item) => (item.kind === 'tool' && item.succeeded === false ? [item] : [])) ?? []
  // 有完成条件时下面的完成条件区已经写了这句原因，不重复
  const verdictReason = verdict.reason && !(task.progress?.requirements.length && verdict.reason === task.progress.reason) ? verdict.reason : null
  const checks = task.info.checks ?? project?.checks
  // 检查命令建会话时就定了，项目设置之后改过的要新任务才用上
  const projectChecks = task.info.checks ? project?.checks : undefined
  const openReview = () => store.set((state) => ({ ...state, panel: 'review' }))
  const mcpFailed = mcp.statuses?.some((server) => server.state === 'failed') ?? false
  const configProblems = [mcpFailed ? 'MCP 连接失败' : null, task.info.bashPath ? null : '没找到 Git Bash'].filter((item) => item !== null)

  return (
    <SidePanel
      width="narrow"
      testId="monitor-panel"
      title="任务监控"
      controls={
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {task.turns.length} 轮 · {verdict.label}
        </span>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 text-sm [scrollbar-gutter:stable] [&>section+section]:border-t [&>section+section]:pt-3">
        {verdict.tone !== 'idle' && (
          <Section title="本轮结论">
            <div className="flex items-center gap-2">
              <VerdictIcon tone={verdict.tone} />
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-foreground/90',
                  verdict.tone === 'confirm' && 'text-warning',
                  (verdict.tone === 'error' || verdict.tone === 'failed') && 'text-destructive',
                )}
              >
                {verdict.label}
              </span>
              {failedCommands.length > 0 && (
                <span className="shrink-0 text-muted-foreground">
                  {verdict.tone === 'verified' ? `过程中 ${failedCommands.length} 条命令失败` : `${failedCommands.length} 条命令失败`}
                </span>
              )}
            </div>
            {verdictReason && <p className="text-muted-foreground">{verdictReason}</p>}
            {failedCommands.length > 0 && (
              <div className="flex flex-col">
                {failedCommands.slice(-FAILED_COMMAND_LIMIT).reverse().map((item) => {
                  const command = splitTitle(item.title).target
                  return (
                    <button
                      key={item.id}
                      type="button"
                      aria-label={`跳到失败的命令：${command}`}
                      className="-mx-1.5 flex h-7 items-center gap-2 rounded-md px-1.5 text-left font-mono text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                      data-testid="monitor-failed-command"
                      onClick={() => onLocate(item.id)}
                    >
                      <CircleAlert className={cn('size-3.5 shrink-0', verdict.tone === 'verified' ? 'text-muted-foreground' : 'text-warning')} />
                      <span className="min-w-0 truncate" title={command}>
                        {command}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
            {failedCommands.length > FAILED_COMMAND_LIMIT && <p className="text-muted-foreground">还有 {failedCommands.length - FAILED_COMMAND_LIMIT} 条命令失败</p>}
          </Section>
        )}

        {/* 每轮没调 finish 时 core 都会写一句 blocked 原因；没定义完成条件时只在主动暂停等待时显示原因 */}
        {task.progress && (task.progress.requirements.length > 0 || (task.progress.status === 'waiting' && task.progress.reason)) && (
          <Section title="完成条件">
            {task.progress.reason && <p className="text-muted-foreground">{task.progress.reason}</p>}
            {task.progress.requirements.map((item) => (
              // success-color-allow: 完成条件的证据已核对
              <Row key={item.id} status={item.receiptId ? 'success' : 'off'} label={item.title} value={item.receiptId ? '证据已核对' : '待完成'} />
            ))}
          </Section>
        )}

        <Section
          title={diff?.state === 'ready' ? `本任务改动 · ${diff.files.length} 个文件` : '本任务改动'}
          action={task.info.checkpoints ? <SectionAction onClick={openReview}>审阅</SectionAction> : undefined}
        >
          {!task.info.checkpoints && <p className="text-muted-foreground">检查点不可用（需要 Git），看不到改动汇总</p>}
          {diff?.state === 'loading' && (
            <div role="status" aria-label="正在读取改动" className="flex h-7 items-center gap-2 motion-safe:animate-pulse">
              <div className="h-3 w-2/3 rounded-sm bg-muted" />
              <div className="ml-auto h-3 w-10 rounded-sm bg-muted" />
            </div>
          )}
          {diff?.state === 'error' && <p className="text-destructive">{diff.message}</p>}
          {diff?.state === 'ready' && diff.files.length === 0 && <p className="text-muted-foreground">还没有改动文件</p>}
          {diff?.state === 'ready' && diff.files.length > 0 && (
            <div className="flex flex-col">
              {diff.files.slice(0, filesExpanded ? diff.files.length : COLLAPSED_CHANGED_FILE_LIMIT).map((file) => {
                const nameStart = file.path.lastIndexOf('/') + 1
                return (
                  <button
                    key={file.path}
                    type="button"
                    title={file.path}
                    className="-mx-1.5 flex h-7 items-center gap-2 rounded-md px-1.5 text-left font-mono text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                    data-testid="monitor-file"
                    onClick={openReview}
                  >
                    <span className="flex min-w-0 flex-1">
                      {/* 目录从左侧截断，文件名始终可见；bdi 防止 rtl 把末尾的斜杠挪到左边 */}
                      <span className="min-w-0 truncate text-muted-foreground [direction:rtl]">
                        <bdi dir="ltr">{file.path.slice(0, nameStart)}</bdi>
                      </span>
                      <span className="max-w-full shrink-0 truncate text-foreground">{file.path.slice(nameStart)}</span>
                    </span>
                    {file.binary ? <span className="shrink-0 text-muted-foreground">二进制</span> : <DiffCounts added={file.added} removed={file.removed} />}
                  </button>
                )
              })}
            </div>
          )}
          {diff?.state === 'ready' && diff.files.length > COLLAPSED_CHANGED_FILE_LIMIT && (
            <Button
              variant="ghost"
              size="xs"
              aria-expanded={filesExpanded}
              className="-mx-2 self-start text-muted-foreground"
              onClick={() => setExpandedSessionId(filesExpanded ? null : task.sessionId)}
            >
              {filesExpanded ? '收起改动列表' : `展开全部（剩余 ${diff.files.length - COLLAPSED_CHANGED_FILE_LIMIT} 个）`}
            </Button>
          )}
        </Section>

        <Section title="检查" action={<SectionAction onClick={() => setEditing(true)}>编辑检查命令</SectionAction>}>
          {checks && (
            <>
              <Row
                status={checks.afterEdit ? 'on' : 'off'}
                label="快速检查"
                value={checks.afterEdit ?? '未配置'}
                mono={!!checks.afterEdit}
                note={projectChecks && projectChecks.afterEdit !== checks.afterEdit ? '新任务生效' : undefined}
              />
              <Row
                status={checks.beforeFinish || checks.afterEdit ? 'on' : 'off'}
                label="完成检查"
                value={checks.beforeFinish ?? (checks.afterEdit ? '同快速检查' : '未配置')}
                mono={!!checks.beforeFinish}
                note={projectChecks && (projectChecks.beforeFinish ?? projectChecks.afterEdit) !== (checks.beforeFinish ?? checks.afterEdit) ? '新任务生效' : undefined}
              />
            </>
          )}
        </Section>

        {deepScanEnabled && (
          <Section
            title="深度扫描"
            hint="只读地跨文件追踪数据流，出一份报告，勾选后交给智能体修复。"
            action={
              <>
                <SectionAction disabled={task.running || task.turns.length === 0} onClick={() => onDeepScan('task')}>
                  扫描本任务改动
                </SectionAction>
                <SectionAction disabled={task.running} onClick={() => onDeepScan('project')}>
                  扫描整个项目
                </SectionAction>
              </>
            }
          />
        )}

        <section className="flex flex-col gap-3">
          <button
            type="button"
            aria-expanded={configOpen}
            className="-mx-1.5 flex flex-col gap-1 rounded-md px-1.5 py-1 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setConfigOpen(!configOpen)}
          >
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', configOpen && 'rotate-90')} />
              任务配置
            </span>
            {!configOpen && (
              <span className="truncate pl-5.5 text-muted-foreground">
                {task.modelLabel} · {branch ?? '不是 Git 仓库'}
                {configProblems.map((problem) => (
                  <span key={problem} className="text-destructive">
                    {' · '}
                    {problem}
                  </span>
                ))}
              </span>
            )}
          </button>

          {/* 折叠只用 CSS 隐藏，内容留在 DOM 里，e2e 的 toContainText 仍能读到 */}
          <div className={cn('flex flex-col gap-4', !configOpen && 'hidden')}>
            <Section title="安全" action={<SectionAction onClick={() => openSettings('security')}>安全设置</SectionAction>}>
              <Row status={task.info.security.staticCheck ? 'on' : 'off'} label="静态检查" value={task.info.security.staticCheck ? '完成前自动检查' : '未开'} />
              <Row status={task.info.security.lightScan ? 'on' : 'off'} label="轻量扫描" value={task.info.security.lightScan ? '完成前自动扫描' : '未开'} />
            </Section>

            <Section title="规范">
              {task.info.rulePacks.length > 0 ? <Row status="on" label="完成前规范审查" value="已开" /> : <Row status="off" label="没有选中的规则包，不会审查" />}
              {task.info.rulePacks.length > 0 && (
                <div className="flex gap-2">
                  <span className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 text-foreground/90" data-testid="monitor-rule-packs">
                    {task.info.rulePacks.join('、')}
                  </span>
                </div>
              )}
            </Section>

            <Section title="模型" action={<SectionAction onClick={() => openSettings('models')}>模型与角色</SectionAction>}>
              <Row label="编码" value={task.modelLabel} />
              <Row label="规划" value={task.planLabel ?? '沿用编码模型'} />
              <Row label="备用" value={task.fallbackLabel ?? '不使用'} />
            </Section>

            {mcp.statuses && mcp.statuses.length > 0 && (
              <Section
                title="MCP"
                action={
                  <>
                    {mcpFailed && <SectionAction onClick={mcp.retry}>重新连接</SectionAction>}
                    <SectionAction onClick={() => openSettings('mcp')}>MCP 设置</SectionAction>
                  </>
                }
              >
                {mcp.statuses.map((server) => (
                  <Row
                    key={server.name}
                    status={server.state === 'connected' ? 'on' : 'bad'}
                    label={server.name}
                    value={server.state === 'connected' ? `${server.tools.length} 个工具` : '连接失败'}
                  />
                ))}
              </Section>
            )}

            <Section title="项目保护">
              <Row label="禁止修改的目录" value={project && project.readOnlyPaths.length > 0 ? project.readOnlyPaths.join(', ') : '无'} mono={!!project?.readOnlyPaths.length} />
              <Row status="on" label="密钥文件" value="不读进模型" title=".env、私钥等密钥文件不会读进模型" />
            </Section>

            <Section title="环境">
              <Row label="分支" value={branch ?? '不是 Git 仓库'} />
              <Row status={task.info.checkpoints ? 'on' : 'bad'} label="检查点" value={task.info.checkpoints ? '可撤销' : '不可用（需要 Git）'} />
              <Row status={task.info.bashPath ? 'on' : 'bad'} label="命令执行" value={task.info.bashPath ? 'Git Bash' : '没找到 Git Bash'} />
            </Section>
          </div>
        </section>

        <ProjectSettingsDialog project={project} open={editing} onClose={() => setEditing(false)} onSaved={onProjectSaved} />
      </div>
    </SidePanel>
  )
}

// 任务监控里的按钮和输入框的斜杠命令都从这里确认，扫描要花不少调用
export function DeepScanDialog({ sessionId, scope, onClose }: { sessionId: string; scope: 'task' | 'project' | null; onClose(): void }) {
  return (
    <Dialog open={scope !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{scope === 'project' ? '深度扫描整个项目？' : '深度扫描本任务改动？'}</DialogTitle>
          <DialogDescription>
            评审模型会读代码、搜索，跨文件追踪数据流，通常要调用模型十几到几十次、几分钟，用量在「设置 → 用量」里能看到。扫描只读，不改文件、不执行命令。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            onClick={() => {
              if (scope) void runDeepScan(sessionId, scope)
              onClose()
            }}
          >
            开始扫描
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Section({ title, hint, action, children }: { title: string; hint?: string; action?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex min-h-6 items-center gap-1">
        <span className="min-w-0 truncate text-xs text-muted-foreground">{title}</span>
        {hint && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`${title}说明`}
                className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Info className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-60">{hint}</TooltipContent>
          </Tooltip>
        )}
        <div className="-mr-2 ml-auto flex shrink-0 items-center">{action}</div>
      </div>
      {children}
    </section>
  )
}

const STATUS_ICONS = {
  // success-color-allow: 只给完成条件的「证据已核对」，配置已开、连接正常用 on
  success: <CircleCheck className="size-3.5 shrink-0 text-success" />,
  on: <CircleCheck className="size-3.5 shrink-0 text-muted-foreground" />,
  off: <CircleDashed className="size-3.5 shrink-0 text-muted-foreground" />,
  bad: <CircleX className="size-3.5 shrink-0 text-destructive" />,
}

// 形状和颜色跟顶栏 TaskView 的 StatusIndicator 保持一致，放大到面板行的 14px 图标槽
function VerdictIcon({ tone }: { tone: VerdictTone }) {
  if (tone === 'running') return <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
  // success-color-allow: 和顶栏同一个结论，只在本轮被接受的 finish 经检查命令验证过时出现
  if (tone === 'verified') return <Check className="size-3.5 shrink-0 text-success" />
  if (tone === 'unverified' || tone === 'unfinished') return <CircleAlert className="size-3.5 shrink-0 text-warning" />
  if (tone === 'blocked') return <CirclePause className="size-3.5 shrink-0 text-warning" />
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
  return <span className="flex size-3.5 shrink-0 items-center justify-center">{dot && <span className={cn('rounded-full', dot)} />}</span>
}

// 每行都留 14px 图标槽，有无状态图标的行标签都对齐
function Row({ status, label, value, mono, note, title }: { status?: keyof typeof STATUS_ICONS; label: string; value?: string; mono?: boolean; note?: string; title?: string }) {
  return (
    <div className="flex items-center gap-2" title={title}>
      {status ? STATUS_ICONS[status] : <span className="size-3.5 shrink-0" />}
      <span className="min-w-0 flex-1 truncate text-foreground/90" title={title ? undefined : label}>
        {label}
      </span>
      {value && (
        <span
          className={cn('min-w-0 max-w-[60%] truncate text-right', mono ? 'font-mono text-xs' : 'text-muted-foreground', status === 'bad' && 'text-destructive')}
          title={title ? undefined : value}
        >
          {value}
        </span>
      )}
      {note && <span className="shrink-0 text-xs text-muted-foreground">{note}</span>}
    </div>
  )
}

function SectionAction({ disabled, onClick, children }: { disabled?: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <Button variant="ghost" size="xs" disabled={disabled} className="text-foreground/80 hover:text-foreground" onClick={onClick}>
      {children}
    </Button>
  )
}
