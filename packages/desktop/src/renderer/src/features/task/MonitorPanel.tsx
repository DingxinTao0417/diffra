import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import type { BackgroundProcess } from '@diffra/core/types'
import {
  BookOpen,
  CircleCheck,
  CircleDashed,
  CircleX,
  File,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  Globe,
  Laptop,
  Link,
  LoaderCircle,
  type LucideIcon,
  Plus,
  Server,
  Square,
  SquareTerminal,
  TriangleAlert,
} from 'lucide-react'
import { cn } from 'cn'
import { splitFileReferences } from '../../../../shared/attachments'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useMcpStatus } from '@/features/mcp/useMcpStatus'
import { DiffCounts, relativePath } from '@/features/session/DiffView'
import type { Turn } from '@/features/session/transcript'
import { showTerminal } from '@/features/terminal/terminals'
import { errorMessage } from '@/lib/errors'
import { turnVerdict } from '@/lib/turn-verdict'
import { runDeepScan } from '@/state/actions'
import { type LiveTask, showToast, store, useAppState } from '@/state/store'
import { pickAttachments } from './Composer'
import { SidePanel } from './SidePanel'
import type { TaskDiff } from './useTaskDiff'

const COLLAPSED_LIMIT = 10
const OUTPUT_LINES = 300
const COMMIT_PROMPT = '把这些改动提交并推送'
const NO_PROCESSES: BackgroundProcess[] = []

interface MonitorPanelProps {
  task: LiveTask
  branch: string | null
  // 远程任务：对方设备的名字；本机任务是 null
  device: string | null
  diff: TaskDiff | null
  onLocate(itemId: string): void
}

// 右侧栏只放这个任务的状态和产出，参照 Qoder（第 529 步）：运行中、环境、子智能体、产出、看过的网页、用户给的资料（摘要卡第 543 步去掉）。
// 检查、安全、规范、模型、MCP 这些配置在设置页和项目设置里改
export function MonitorPanel({ task, branch, device, diff, onLocate }: MonitorPanelProps) {
  const [expanded, setExpanded] = useState<{ sessionId: string; files: boolean; agents: boolean } | null>(null)
  const show = expanded?.sessionId === task.sessionId ? expanded : { sessionId: task.sessionId, files: false, agents: false }
  const [output, setOutput] = useState<BackgroundProcess | null>(null)
  const remote = device !== null
  const mcp = useMcpStatus(remote ? null : { sessionId: task.sessionId })
  const terminals = useAppState((state) => state.terminals)
  const processes = useAppState((state) => state.processes[task.sessionId] ?? NO_PROCESSES)
  const verdict = turnVerdict(task)
  const agents = useMemo(() => taskAgents(task.turns), [task.turns])
  const pages = useMemo(() => (remote ? [] : visitedPages(task.turns)), [remote, task.turns])
  const sources = useMemo(() => attachedSources(task.turns), [task.turns])
  // 改动文件是哪个子智能体改的（工人用 apply_patch 改的；命令改的看不出是谁）
  const owners = useMemo(() => fileOwners(task), [task])
  const servers = terminals.filter((terminal) => terminal.devServer?.sessionId === task.sessionId && terminal.exitCode === null)
  const files = diff?.state === 'ready' ? diff.files : []
  const added = files.reduce((sum, file) => sum + file.added, 0)
  const removed = files.reduce((sum, file) => sum + file.removed, 0)
  const mcpFailed = mcp.statuses?.some((server) => server.state === 'failed') ?? false
  const openReview = (path?: string) => store.set((state) => ({ ...state, panel: 'review', reviewFile: path ?? null }))
  const openPage = (url: string) => {
    store.set((state) => ({ ...state, panel: 'browser' }))
    window.diffra.browserNavigate(task.sessionId, url).catch((error: unknown) => showToast(errorMessage(error)))
  }
  const stopProcess = (id: number) => window.diffra.stopProcess(task.sessionId, id).catch((error: unknown) => showToast(`停止失败：${errorMessage(error)}`))
  const stopServer = (id: string) => window.diffra.killTerminal(id).catch((error: unknown) => showToast(`停止失败：${errorMessage(error)}`))

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
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4 text-sm [scrollbar-gutter:stable]">
        {(servers.length > 0 || processes.length > 0) && (
          <Section title="运行中">
            {servers.map((server) => (
              <RunningRow
                key={server.id}
                icon={Server}
                command={server.devServer!.command}
                url={server.devServer!.url}
                onOpen={openPage}
                onOutput={() => showTerminal(server.id)}
                onStop={() => void stopServer(server.id)}
              />
            ))}
            {processes.map((process) => (
              <RunningRow
                key={process.id}
                icon={SquareTerminal}
                command={process.command}
                url={process.url}
                onOpen={remote ? undefined : openPage}
                onOutput={() => setOutput(process)}
                onStop={() => void stopProcess(process.id)}
              />
            ))}
          </Section>
        )}

        {/* 目标模式的完成条件；没定义完成条件时只在主动暂停等待时显示原因 */}
        {task.progress && (task.progress.requirements.length > 0 || (task.progress.status === 'waiting' && task.progress.reason)) && (
          <Section title="完成条件">
            {task.progress.reason && <p className="text-muted-foreground">{task.progress.reason}</p>}
            {task.progress.requirements.map((item) => (
              <div key={item.id} className="flex items-center gap-2">
                {/* success-color-allow: 完成条件的证据已核对 */}
                {item.receiptId ? <CircleCheck className="size-3.5 shrink-0 text-success" /> : <CircleDashed className="size-3.5 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1 truncate text-foreground" title={item.title}>
                  {item.title}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{item.receiptId ? '证据已核对' : '待完成'}</span>
              </div>
            ))}
          </Section>
        )}

        <Section title="环境信息">
          <Row
            leading={<IconBox icon={GitCompareArrows} />}
            testId="monitor-changes"
            onClick={task.info.checkpoints && diff?.state === 'ready' ? () => openReview() : undefined}
            label={files.length > 0 ? `审阅 ${files.length} 个文件的改动` : undefined}
          >
            {!task.info.checkpoints ? (
              <span className="truncate text-muted-foreground">检查点不可用（需要 Git）</span>
            ) : diff?.state === 'error' ? (
              <span className="truncate text-destructive" title={diff.message}>
                {diff.message}
              </span>
            ) : diff?.state !== 'ready' ? (
              <span className="text-muted-foreground">正在读取改动…</span>
            ) : files.length === 0 ? (
              <span className="text-muted-foreground">还没有改动文件</span>
            ) : (
              <>
                <DiffCounts added={added} removed={removed} />
                <span className="text-xs text-muted-foreground">{files.length} 个文件</span>
              </>
            )}
          </Row>
          <Row leading={<IconBox icon={Laptop} />}>
            <span className="truncate text-foreground">{device ?? '本地'}</span>
          </Row>
          <Row leading={<IconBox icon={GitBranch} />}>
            <span className="truncate text-foreground">{branch ?? '不是 Git 仓库'}</span>
          </Row>
          {branch && !remote && (
            <Row
              leading={<IconBox icon={GitCommitHorizontal} />}
              testId="monitor-commit"
              onClick={() => store.set((state) => ({ ...state, composerInsert: { target: task.sessionId, text: COMMIT_PROMPT, mode: 'fill' } }))}
            >
              <span className="text-foreground">提交或推送</span>
            </Row>
          )}
          {!task.info.bashPath && (
            <Row leading={<IconBox icon={TriangleAlert} tone="bad" />}>
              <span className="truncate text-destructive">没找到 Git Bash，命令跑不了</span>
            </Row>
          )}
          {mcpFailed && (
            <Row leading={<IconBox icon={TriangleAlert} tone="bad" />} onClick={mcp.retry} label="MCP 连接失败，重新连接">
              <span className="truncate text-destructive">MCP 连接失败</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">重新连接</span>
            </Row>
          )}
        </Section>

        {agents.length > 0 && (
          <Section title="子智能体">
            {agents.slice(0, show.agents ? agents.length : COLLAPSED_LIMIT).map(({ item, card }) => {
              const running = item.status !== 'completed' && item.status !== 'failed'
              const state = running ? '进行中' : item.status === 'completed' ? '已交回' : '未完成'
              return (
                <Row
                  key={item.id}
                  leading={<span className="size-5 shrink-0 rounded-full" style={{ background: `radial-gradient(circle at 30% 30%, color-mix(in oklab, ${card.color} 35%, white), ${card.color})` }} aria-hidden="true" />}
                  testId="monitor-agent"
                  status={item.status}
                  title={[card.task, card.files.length > 0 ? `认领：${card.files.join('、')}` : ''].filter(Boolean).join('\n')}
                  label={`跳到子智能体 ${card.name}（${state}）`}
                  onClick={() => onLocate(item.id)}
                >
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    <span className="text-foreground">{card.name}</span> · {card.task}
                  </span>
                  {running ? (
                    <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                  ) : item.status === 'failed' ? (
                    <CircleX className="size-3.5 shrink-0 text-destructive" />
                  ) : null}
                </Row>
              )
            })}
            <ExpandButton total={agents.length} expanded={show.agents} onToggle={() => setExpanded({ ...show, agents: !show.agents })} />
          </Section>
        )}

        {files.length > 0 && (
          <Section title="产出">
            {files.slice(0, show.files ? files.length : COLLAPSED_LIMIT).map((file) => {
              const nameStart = file.path.lastIndexOf('/') + 1
              return (
                <Row key={file.path} leading={<IconBox icon={File} />} testId="monitor-file" title={file.path} label={`审阅 ${file.path}`} onClick={() => openReview(file.path)}>
                  <span className="flex min-w-0 flex-1">
                    <span className="max-w-full shrink-0 truncate text-foreground">{file.path.slice(nameStart)}</span>
                    {/* 目录从左侧截断，文件名始终可见；bdi 防止 rtl 把末尾的斜杠挪到左边 */}
                    <span className="ml-2 min-w-0 truncate text-xs leading-5 text-muted-foreground [direction:rtl]">
                      <bdi dir="ltr">{file.path.slice(0, Math.max(0, nameStart - 1))}</bdi>
                    </span>
                  </span>
                  {(owners.get(file.path) ?? []).map((owner) => (
                    <span key={owner.id} className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground" title={`子智能体 ${owner.name} 改的`} data-testid="monitor-file-agent">
                      <span className="size-2 rounded-full" style={{ backgroundColor: owner.color }} aria-hidden="true" />
                      {owner.name}
                    </span>
                  ))}
                  {file.binary ? <span className="shrink-0 text-xs text-muted-foreground">二进制</span> : <DiffCounts added={file.added} removed={file.removed} />}
                </Row>
              )
            })}
            <ExpandButton total={files.length} expanded={show.files} onToggle={() => setExpanded({ ...show, files: !show.files })} />
          </Section>
        )}

        {pages.length > 0 && (
          <Section title="网页查阅">
            {pages.map((url) => (
              <Row key={url} leading={<IconBox icon={Globe} />} testId="monitor-page" title={url} label={`在浏览器里打开 ${url}`} onClick={() => openPage(url)}>
                <span className="truncate text-foreground">{url.replace(/^https?:\/\//, '')}</span>
              </Row>
            ))}
          </Section>
        )}

        {(sources.length > 0 || !remote) && (
          <Section
            title="来源"
            action={
              !remote && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-xs" aria-label="添加文件" className="text-muted-foreground" onClick={() => pickAttachments(task.sessionId)}>
                      <Plus />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>添加文件到输入框</TooltipContent>
                </Tooltip>
              )
            }
          >
            {sources.length === 0 && <p className="text-muted-foreground">附加的文件、提到的网址和用到的 Skill 会列在这里</p>}
            {sources.map((source) =>
              source.kind === 'url' ? (
                <Row key={`url:${source.url}`} leading={<IconBox icon={Link} />} testId="monitor-source" title={source.url} label={remote ? undefined : `在浏览器里打开 ${source.url}`} onClick={remote ? undefined : () => openPage(source.url)}>
                  <span className="truncate text-foreground">{source.url.replace(/^https?:\/\//, '')}</span>
                </Row>
              ) : source.kind === 'skill' ? (
                <Row key={`skill:${source.name}`} leading={<IconBox icon={BookOpen} />} testId="monitor-source" title={`Skill：${source.name}`}>
                  <span className="truncate text-foreground">{source.name}</span>
                </Row>
              ) : (
                <Row key={`file:${source.path}`} leading={<IconBox icon={source.kind === 'directory' ? Folder : File} />} testId="monitor-source" title={source.path}>
                  <span className="truncate text-foreground">{relativePath(source.path, task.project)}</span>
                </Row>
              ),
            )}
          </Section>
        )}
      </div>
      <ProcessOutputDialog sessionId={task.sessionId} process={output} onClose={() => setOutput(null)} onStop={(id) => void stopProcess(id)} />
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

function taskAgents(turns: Turn[]) {
  return turns.flatMap((turn) => turn.items.flatMap((item) => (item.kind === 'tool' && item.agentCard ? [{ item, card: item.agentCard }] : [])))
}

function fileOwners(task: LiveTask) {
  const owners = new Map<string, Array<{ id: string; name: string; color: string }>>()
  for (const turn of task.turns) {
    for (const item of turn.items) {
      if (item.kind !== 'tool' || !item.agent || item.status !== 'completed') continue
      for (const content of item.content) {
        if (content.type !== 'diff') continue
        const path = relativePath(content.path, task.project)
        const list = owners.get(path) ?? []
        if (!list.some((owner) => owner.id === item.agent!.id)) owners.set(path, [...list, item.agent])
      }
    }
  }
  return owners
}

// 智能体在内置浏览器里打开过的网址（标题见 core 的 browserTitle），最近打开的在前
const PAGE_TITLE = /^浏览器 (?:打开|新标签页) (https?:\/\/\S+)$/
function visitedPages(turns: Turn[]): string[] {
  const urls = new Set<string>()
  for (const turn of turns) {
    for (const item of turn.items) {
      const url = item.kind === 'tool' && item.status === 'completed' ? PAGE_TITLE.exec(item.title)?.[1] : undefined
      if (!url) continue
      urls.delete(url)
      urls.add(url)
    }
  }
  return [...urls].reverse()
}

type Source = { kind: 'file' | 'directory'; path: string } | { kind: 'url'; url: string } | { kind: 'skill'; name: string }

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`，。、；：！？）」』】]+/g
// 用户自己发的消息里附加的文件、提到的网址、选的 Skill；别的任务发来的、出计划之外的内部轮次不算
function attachedSources(turns: Turn[]): Source[] {
  const seen = new Set<string>()
  const sources: Source[] = []
  const add = (key: string, source: Source) => {
    if (seen.has(key)) return
    seen.add(key)
    sources.push(source)
  }
  for (const turn of turns) {
    if (turn.from || (turn.kind !== 'prompt' && turn.kind !== 'goal' && turn.kind !== 'plan')) continue
    const { text, files } = splitFileReferences(turn.prompt)
    for (const file of files) add(`file:${file.path}`, { kind: file.kind, path: file.path })
    for (const match of text.match(URL_IN_TEXT) ?? []) {
      const url = match.replace(/[.,;:)]+$/, '')
      add(`url:${url}`, { kind: 'url', url })
    }
    for (const skill of turn.skills) add(`skill:${skill}`, { kind: 'skill', name: skill })
  }
  return sources
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children?: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <div className="flex min-h-6 items-center gap-1">
        <span className="min-w-0 truncate text-muted-foreground">{title}</span>
        <div className="-mr-1 ml-auto flex shrink-0 items-center">{action}</div>
      </div>
      {children}
    </section>
  )
}

function IconBox({ icon: Icon, tone }: { icon: LucideIcon; tone?: 'bad' }) {
  return (
    <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-md bg-muted', tone === 'bad' ? 'text-destructive' : 'text-muted-foreground')}>
      <Icon className="size-3.5" />
    </span>
  )
}

// 每行左边一个 24px 的图标块；能点的行整行是按钮
function Row({ leading, onClick, label, title, testId, status, children }: { leading: ReactNode; onClick?: () => void; label?: string; title?: string; testId?: string; status?: string; children: ReactNode }) {
  const className = '-mx-1.5 flex min-h-8 items-center gap-2.5 rounded-md px-1.5 py-1 text-left'
  const body = (
    <>
      {leading}
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
    </>
  )
  if (!onClick) {
    return (
      <div className={className} title={title} data-testid={testId} data-status={status}>
        {body}
      </div>
    )
  }
  return (
    <button type="button" aria-label={label} title={title} data-testid={testId} data-status={status} className={cn(className, 'outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring')} onClick={onClick}>
      {body}
    </button>
  )
}

function ExpandButton({ total, expanded, onToggle }: { total: number; expanded: boolean; onToggle(): void }) {
  if (total <= COLLAPSED_LIMIT) return null
  return (
    <Button variant="ghost" size="xs" aria-expanded={expanded} className="-mx-2 self-start text-muted-foreground" onClick={onToggle}>
      {expanded ? '收起' : `展开全部（剩余 ${total - COLLAPSED_LIMIT} 个）`}
    </Button>
  )
}

// 「运行中」的一行：开发服务器（终端里跑的）或转到后台的命令；看输出、停止，有本地地址时能在浏览器里打开
function RunningRow({ icon, command, url, onOpen, onOutput, onStop }: { icon: LucideIcon; command: string; url: string | null; onOpen?: (url: string) => void; onOutput(): void; onStop(): void }) {
  return (
    <div className="-mx-1.5 flex min-h-8 items-center gap-2.5 rounded-md px-1.5 py-1" data-testid="monitor-running">
      <IconBox icon={icon} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-mono text-xs text-foreground" title={command}>
          {command}
        </span>
        {url && <span className="truncate text-xs text-muted-foreground">{url}</span>}
      </div>
      <div className="-mr-1 flex shrink-0 items-center">
        {url && onOpen && <IconAction icon={Globe} label="在浏览器里打开" target={command} onClick={() => onOpen(url)} />}
        <IconAction icon={SquareTerminal} label="查看输出" target={command} onClick={onOutput} />
        <IconAction icon={Square} label="停止" target={command} onClick={onStop} />
      </div>
    </div>
  )
}

// 读屏念出是哪条命令的：页面上还有输入框的「停止」，只念「停止」分不清
function IconAction({ icon: Icon, label, target, onClick }: { icon: LucideIcon; label: string; target: string; onClick(): void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={`${label}：${target}`} className="text-muted-foreground hover:text-foreground" onClick={onClick}>
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

// 后台命令的最近输出；不动交给模型的那份。命令在框开着时结束了也照样看得到最后的输出
function ProcessOutputDialog({ sessionId, process, onClose, onStop }: { sessionId: string; process: BackgroundProcess | null; onClose(): void; onStop(id: number): void }) {
  const [output, setOutput] = useState<{ id: number; text: string; running: boolean } | { id: number; error: string } | null>(null)
  const [version, setVersion] = useState(0)
  const preRef = useRef<HTMLPreElement>(null)
  const id = process?.id ?? null
  useEffect(() => {
    if (id === null) return
    let stale = false
    window.diffra.processOutput(sessionId, id).then(
      (result) => !stale && setOutput({ id, ...result }),
      (error: unknown) => !stale && setOutput({ id, error: errorMessage(error) }),
    )
    return () => {
      stale = true
    }
  }, [sessionId, id, version])
  const current = output && output.id === id ? output : null
  useEffect(() => {
    const pre = preRef.current
    if (pre) pre.scrollTop = pre.scrollHeight
  }, [current])
  const text = current && 'text' in current ? current.text.split('\n').slice(-OUTPUT_LINES).join('\n').trim() : ''
  return (
    <Dialog open={process !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>命令输出</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs">{process?.command}</DialogDescription>
        </DialogHeader>
        {current && 'error' in current ? (
          <p className="text-sm text-destructive">{current.error}</p>
        ) : (
          <pre ref={preRef} className="max-h-[60vh] min-h-24 overflow-auto rounded-md bg-muted p-3 font-mono text-xs break-all whitespace-pre-wrap" data-testid="process-output">
            {current ? text || '（还没有输出）' : '正在读取…'}
          </pre>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setVersion((value) => value + 1)}>
            刷新
          </Button>
          {current && 'running' in current && current.running && process && (
            <Button
              variant="ghost"
              onClick={() => {
                onStop(process.id)
                onClose()
              }}
            >
              停止
            </Button>
          )}
          <Button onClick={onClose}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
