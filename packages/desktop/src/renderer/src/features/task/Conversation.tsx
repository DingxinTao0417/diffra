import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PromptImage, StopReason, TaskProgressView } from '@diffra/core/types'
import type { PermissionRequestEvent } from '../../../../shared/ipc'
import { ArrowDown, Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, CircleAlert, Copy, ListChecks, LoaderCircle, MessageSquare, RefreshCw, Sparkles, Square, Target, Undo2, X } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DiffCounts, DiffView, diffStats, relativePath } from '@/features/session/DiffView'
import type { TranscriptItem, Turn } from '@/features/session/transcript'
import { formatDuration } from '@/lib/format'
import { imageUrl } from '@/lib/images'
import { finishVerdict } from '@/lib/turn-verdict'
import { sendMessage } from '@/state/actions'
import { type LiveTask, showToast, store } from '@/state/store'
import { Markdown } from './Markdown'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

type Block =
  | { type: 'item'; item: Exclude<TranscriptItem, ToolItem> }
  | { type: 'tools' | 'edits' | 'checks'; id: string; items: ToolItem[] }
  | { type: 'edit' | 'deep-scan' | 'compaction' | 'plan' | 'finish' | 'verify'; item: ToolItem }

const STOP_LABELS: Partial<Record<StopReason, string>> = {
  cancelled: '已停止',
  max_tokens: '上下文快用完了，已停止',
  max_turn_requests: '达到步数上限，已停止',
  refusal: '模型拒绝了这个任务',
}

const CHECK_PREFIXES = ['快速检查：', '完成检查：']

// 旧会话里存的是改名前的标题，显示时统一成监控面板的叫法
const SECURITY_TITLES = new Map([
  ['静态检查', '静态检查'],
  ['轻量扫描', '轻量扫描'],
  ['安全检查', '静态检查'],
  ['安全扫描', '轻量扫描'],
])

function toolBlockType(item: ToolItem): 'edit' | 'check' | 'review' | 'security' | 'deep-scan' | 'compaction' | 'plan' | 'finish' | 'verify' | null {
  if (item.title === '完成') return 'finish'
  if (item.title === '验证改动（不结束任务）') return 'verify'
  if (item.title === '计划') return 'plan'
  if (item.title === '上下文压缩') return 'compaction'
  if (item.title === '深度扫描报告') return 'deep-scan'
  if (item.title === '规范审查') return 'review'
  if (SECURITY_TITLES.has(item.title)) return 'security'
  if (CHECK_PREFIXES.some((prefix) => item.title.startsWith(prefix))) return 'check'
  if (item.content.some((content) => content.type === 'diff')) return 'edit'
  return null
}

// 连续的读文件、搜索、命令等普通工具调用收成一组；改动、检查、审查、上下文压缩、中途验证、完成单独显示
function toBlocks(items: TranscriptItem[]): Block[] {
  const blocks: Block[] = []
  for (const item of items) {
    if (item.kind !== 'tool') {
      blocks.push({ type: 'item', item })
      continue
    }
    const type = toolBlockType(item)
    if (type === 'edit') {
      const previous = blocks.at(-1)
      if (previous?.type === 'edits') previous.items.push(item)
      else blocks.push({ type: 'edits', id: item.id, items: [item] })
      continue
    }
    if (type === 'check' || type === 'review' || type === 'security') {
      const previous = blocks.at(-1)
      if (previous?.type === 'checks') previous.items.push(item)
      else blocks.push({ type: 'checks', id: item.id, items: [item] })
      continue
    }
    if (type) {
      blocks.push({ type, item })
      continue
    }
    const last = blocks.at(-1)
    if (last?.type === 'tools') last.items.push(item)
    else blocks.push({ type: 'tools', id: item.id, items: [item] })
  }
  return blocks
}

function textOf(item: ToolItem): string {
  return item.content.flatMap((content) => (content.type === 'content' && content.content.type === 'text' ? [content.content.text] : [])).join('\n')
}

// 工具还没跑完时标题是工具名，跑完才换成「读取 a.txt」这样的说明
const TOOL_ACTIONS: Record<string, string> = {
  read_file: '读取',
  list_files: '列出',
  search: '搜索',
  outline: '大纲',
  edit_file: '编辑',
  run_command: '执行',
}

function splitTitle(title: string): { action: string; target: string } {
  const action = TOOL_ACTIONS[title]
  if (action) return { action, target: '' }
  const space = title.indexOf(' ')
  return space < 0 ? { action: title, target: '' } : { action: title.slice(0, space), target: title.slice(space + 1) }
}

interface ConversationProps {
  task: LiveTask
  onRestore(turnId: string): void
  onRegenerate(turnId: string): void
}

export function Conversation({ task, onRestore, onRegenerate }: ConversationProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // 用户停在底部时，新内容进来就跟着滚；往上翻了就不打扰
  const stickRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const [activeTurn, setActiveTurn] = useState<string | null>(null)

  const onScroll = () => {
    const element = scrollRef.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    stickRef.current = distance < 80
    setAtBottom(distance < 200)
    let current: string | null = null
    for (const turn of task.turns) {
      const node = element.querySelector<HTMLElement>(`[data-turn-id="${turn.id}"]`)
      if (node && node.offsetTop <= element.scrollTop + 80) current = turn.id
    }
    setActiveTurn(current ?? task.turns[0]?.id ?? null)
  }

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element && stickRef.current) element.scrollTop = element.scrollHeight
  }, [task.turns, task.permission])

  // 切到这个任务时滚到底
  useEffect(() => {
    stickRef.current = true
    const element = scrollRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [task.sessionId])

  // 下面的排队提示、输入框变高会把对话区压矮，贴底时跟着滚
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      if (stickRef.current) element.scrollTop = element.scrollHeight
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const scrollToBottom = () => {
    const element = scrollRef.current
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
  }

  const scrollToTurn = (turnId: string) => {
    const element = scrollRef.current
    const node = element?.querySelector<HTMLElement>(`[data-turn-id="${turnId}"]`)
    if (element && node) element.scrollTo({ top: node.offsetTop - 16, behavior: 'smooth' })
  }

  return (
    <div className="relative min-h-0 flex-1">
      {/* 两侧都预留滚动条槽位，内容列无论是否滚动都居中，与下方输入框对齐；底部 24px 渐隐，pb-8 让贴底时最后一行落在渐隐区外 */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto px-8 pt-6 pb-8 [scrollbar-gutter:stable_both-edges] [mask-image:linear-gradient(to_bottom,black_calc(100%_-_24px),transparent)]"
      >
        <div className="mx-auto flex min-h-full max-w-(--content-max) flex-col gap-7">
          {task.turns.length === 0 && (
            <EmptyState icon={MessageSquare} title="描述你要做的事" description="比如「修复登录页的报错」或「给 utils 加单元测试」。" className="my-auto bg-transparent" />
          )}
          {task.turns.map((turn, index) => {
            const last = index === task.turns.length - 1
            return (
              <TurnView
                key={turn.id}
                turn={turn}
                task={task}
                active={task.running && last}
                last={last}
                onRestore={() => onRestore(turn.id)}
                onRegenerate={() => onRegenerate(turn.id)}
              />
            )
          })}
        </div>
      </div>
      {task.turns.length > 1 && <Timeline turns={task.turns} activeTurn={activeTurn ?? task.turns.at(-1)?.id ?? null} onJump={scrollToTurn} />}
      {!atBottom && (
        <Button variant="outline" size="icon" aria-label="回到底部" className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full shadow-overlay" onClick={scrollToBottom}>
          <ArrowDown />
        </Button>
      )}
    </div>
  )
}

interface TurnViewProps {
  turn: Turn
  task: LiveTask
  active: boolean
  last: boolean
  onRestore(): void
  onRegenerate(): void
}

function TurnView({ turn, task, active, last, onRestore, onRegenerate }: TurnViewProps) {
  // 等待确认的那一步由输入框上方的确认卡片代表，这里不再画一条转圈的待执行行
  const pendingToolId = active && task.permission ? task.permission.toolCall.toolCallId : null
  const blocks = useMemo(() => toBlocks(pendingToolId ? turn.items.filter((item) => item.id !== pendingToolId) : turn.items), [turn.items, pendingToolId])
  const [showEditDetails, setShowEditDetails] = useState(false)
  // 整轮的「展开代码详情」只挂在第一个改动组上，一轮里不会出现两个同名按钮
  const editToggleId = blocks.flatMap((block) => (block.type === 'edits' ? [block.id] : []))[0]
  // 目标模式一轮里有好几张完成卡片，每张只算上一张通过的卡之后的改动和失败的命令；打回的卡不切分，免得通过的卡漏掉打回前的改动
  const finishFiles = useMemo(() => {
    const result = new Map<string, { files: ChangedFile[]; commandsFailed: number }>()
    let start = 0
    turn.items.forEach((item, index) => {
      if (item.kind !== 'tool' || toolBlockType(item) !== 'finish') return
      const scope = turn.items.slice(start, index + 1)
      result.set(item.id, { files: filesOf(scope), commandsFailed: scope.filter((entry) => entry.kind === 'tool' && entry.succeeded === false).length })
      if (item.status === 'completed') start = index + 1
    })
    return result
  }, [turn.items])
  const lastFinishId = last ? [...finishFiles.keys()].at(-1) : undefined
  const lastPassedId = last ? turn.items.filter((item) => item.kind === 'tool' && toolBlockType(item) === 'finish' && item.status === 'completed' && (finishFiles.get(item.id)?.files.length ?? 0) > 0).at(-1)?.id : undefined
  const stopLabel = turn.stopReason ? STOP_LABELS[turn.stopReason] : undefined
  const canRegenerate = last && (turn.kind === 'prompt' || turn.kind === 'goal')
  const canRestore = task.info.checkpoints && turn.kind !== 'compact'

  const copy = () => {
    const text = turn.items
      .flatMap((item) => (item.kind === 'agent' ? [item.text] : item.kind === 'tool' && item.title === '完成' ? [textOf(item)] : []))
      .join('\n\n')
    navigator.clipboard.writeText(text).then(
      () => showToast('已复制回复'),
      (error: unknown) => console.error('复制失败', error),
    )
  }

  return (
    <section data-testid="turn" data-turn-id={turn.id} className="group/turn flex flex-col gap-3.5">
      {blocks.map((block) => {
        switch (block.type) {
          case 'item':
            return <ItemView key={block.item.id} item={block.item} goal={turn.kind === 'goal'} skills={turn.skills} images={turn.images} />
          case 'tools':
            return <ToolGroup key={block.id} items={block.items} />
          case 'edits':
            return (
              <EditGroup
                key={block.id}
                items={block.items}
                projectPath={task.project}
                expanded={showEditDetails}
                toggle={block.id === editToggleId ? <EditDetailsToggle expanded={showEditDetails} onToggle={() => setShowEditDetails(!showEditDetails)} /> : undefined}
              />
            )
          case 'edit':
            return <EditBlock key={block.item.id} item={block.item} projectPath={task.project} />
          case 'checks':
            return <CheckGroup key={block.id} items={block.items} />
          case 'deep-scan':
            return <DeepScanReport key={block.item.id} item={block.item} task={task} />
          case 'compaction':
            return <CompactionRow key={block.item.id} item={block.item} />
          case 'plan':
            return <PlanCard key={block.item.id} item={block.item} request={turn.prompt} task={task} />
          case 'verify':
            // 中途验证不改变本轮结论，通过也不画绿色；没配检查命令时提醒并默认展开，之后撤销过就不再提醒
            return <ToolStep key={block.item.id} item={block.item} unverified={!turn.restoredAt && finishVerdict(block.item).tone === 'unverified'} />
          case 'finish':
            return <FinishCard key={block.item.id} item={block.item} files={finishFiles.get(block.item.id)?.files ?? []} commandsFailed={finishFiles.get(block.item.id)?.commandsFailed ?? 0} projectPath={task.project} latest={block.item.id === lastPassedId} restored={Boolean(turn.restoredAt)} progress={block.item.id === lastFinishId ? task.progress : undefined} onRestore={!task.running && task.info.checkpoints ? onRestore : undefined} />
        }
      })}
      {active && task.permission && <PermissionPending toolCall={task.permission.toolCall} />}
      {active && !task.permission && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          进行中…
        </p>
      )}
      {stopLabel && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Square className="size-3.5" />
          {stopLabel}
        </p>
      )}
      {turn.error && (
        <div className="flex flex-col gap-2 rounded-xl border border-destructive/30 bg-destructive-soft px-3.5 py-3 text-sm" role="alert" data-testid="turn-error">
          <div className="flex items-center gap-2 font-semibold text-destructive">
            <CircleAlert className="size-4 shrink-0" />
            这一轮出错了
          </div>
          <p className="leading-relaxed break-words whitespace-pre-wrap">{turn.error}</p>
          {canRegenerate && (
            <Button variant="outline" size="sm" className="self-start" disabled={task.running} onClick={onRegenerate}>
              重试
            </Button>
          )}
        </div>
      )}
      {/* 只有最后一轮的操作栏常驻，其余轮悬停或键盘聚焦时才出现；用透明度隐藏，不占用也不改变布局 */}
      {!active && (
        <div
          className={cn('flex items-center gap-1 text-muted-foreground transition-opacity', !last && 'opacity-0 group-hover/turn:opacity-100 focus-within:opacity-100')}
          data-testid="turn-actions"
        >
          <ActionButton label="复制回复" onClick={copy}>
            <Copy className="size-4" />
          </ActionButton>
          {/* 出错卡片里已经有「重试」，同一个动作不再放第二个按钮 */}
          {canRegenerate && !turn.error && (
            <ActionButton label="重新生成" disabled={task.running} onClick={onRegenerate}>
              <RefreshCw className="size-4" />
            </ActionButton>
          )}
          {canRestore && (
            <>
              <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
              <ActionButton label="撤销到这一轮之前" disabled={task.running} onClick={onRestore}>
                <Undo2 className="size-4" />
              </ActionButton>
            </>
          )}
          {turn.startedAt && turn.endedAt && <span className="ml-auto text-xs tabular-nums">用时 {formatDuration(turn.endedAt - turn.startedAt)}</span>}
        </div>
      )}
    </section>
  )
}

function PermissionPending({ toolCall }: { toolCall: PermissionRequestEvent['toolCall'] }) {
  const input = toolCall.rawInput
  const command = typeof input === 'object' && input !== null && 'command' in input && typeof input.command === 'string' ? input.command : null
  const target = command ?? toolCall.title ?? ''
  return (
    <div data-testid="permission-pending">
      <DisclosureRow className="text-foreground/85">
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          <span className="size-2 rounded-full border-2 border-warning" />
        </span>
        <span className="shrink-0 text-muted-foreground">等待确认</span>
        {target && <span className="min-w-0 truncate rounded bg-muted px-1.5 py-px font-mono text-xs">{target}</span>}
      </DisclosureRow>
    </div>
  )
}

// 点开看大图
function ImageThumbnail({ image, label }: { image: PromptImage; label: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" aria-label={label} className="overflow-hidden rounded-lg border hover:opacity-90" onClick={() => setOpen(true)}>
        <img src={imageUrl(image)} alt={label} className="max-h-40 max-w-64 object-contain" data-testid="message-image" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] max-w-[90vw] sm:max-w-[90vw]">
          <DialogTitle className="sr-only">{label}</DialogTitle>
          <img src={imageUrl(image)} alt={label} className="max-h-[80vh] max-w-full object-contain" />
        </DialogContent>
      </Dialog>
    </>
  )
}

function ActionButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} disabled={disabled} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

// goal、skills、images 只用在提问气泡上：这一轮是目标模式、带了哪些 Skill 和图片
function ItemView({ item, goal, skills, images }: { item: Exclude<TranscriptItem, ToolItem>; goal: boolean; skills: string[]; images: PromptImage[] }) {
  switch (item.kind) {
    case 'user':
      if (!goal && skills.length === 0 && images.length === 0) {
        return (
          <div className="max-w-[80%] self-end rounded-2xl bg-secondary px-3.5 py-2.5 leading-relaxed whitespace-pre-wrap" data-testid="user-message">
            {item.text}
          </div>
        )
      }
      return (
        <div className="flex max-w-[80%] flex-col items-end gap-1.5 self-end">
          {images.length > 0 && (
            <div className="flex flex-wrap justify-end gap-2">
              {images.map((image, index) => (
                <ImageThumbnail key={index} image={image} label={`提问的图片 ${index + 1}`} />
              ))}
            </div>
          )}
          <div className="flex flex-wrap justify-end gap-1.5 text-xs text-muted-foreground empty:hidden" data-testid="message-tags">
            {goal && (
              <span className="flex items-center gap-1 rounded-md border px-1.5 py-0.5">
                <Target className="size-3" />
                目标
              </span>
            )}
            {skills.map((name) => (
              <span key={name} className="flex items-center gap-1 rounded-md border px-1.5 py-0.5">
                <Sparkles className="size-3" />
                {name}
              </span>
            ))}
          </div>
          <div className="rounded-2xl bg-secondary px-3.5 py-2.5 leading-relaxed whitespace-pre-wrap" data-testid="user-message">
            {item.text}
          </div>
        </div>
      )
    case 'agent':
      return (
        <div data-testid="agent-message">
          <Markdown text={item.text} />
        </div>
      )
    case 'thought':
      return <Thought text={item.text} />
    case 'notice':
      return (
        <div
          data-testid="notice"
          role={item.severity === 'error' ? 'alert' : undefined}
          className={cn(
            'rounded-xl border px-3 py-2 text-sm',
            item.severity === 'error' && 'border-destructive/30 bg-destructive-soft text-destructive',
            item.severity === 'warning' && 'border-warning/30 bg-warning-soft',
          )}
        >
          <div className="font-semibold">{item.title}</div>
          {item.description && <div className="mt-1 whitespace-pre-wrap text-muted-foreground">{item.description}</div>}
        </div>
      )
  }
}

function Thought({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const preview = text.trim().split(/\r?\n/)[0] ?? ''
  return (
    <div className="text-sm text-muted-foreground">
      <button type="button" className="flex max-w-full items-center gap-1.5 hover:text-foreground" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
        <span className="truncate">思考{preview && !open ? ` · ${preview}` : ''}</span>
      </button>
      {open && <div className="mt-1.5 border-l-2 pl-3 leading-relaxed whitespace-pre-wrap">{text}</div>}
    </div>
  )
}

// success-color-allow: 跑完只是过程，默认画中性；只有检查命令通过这类验证结果才传 tone="success"
function StatusIcon({ status, tone = 'muted', className }: { status: string; tone?: 'muted' | 'success'; className?: string }) {
  // success-color-allow: 只有 CheckRow 传 tone="success"，检查命令通过才走到绿色
  if (status === 'completed') return <Check className={cn('size-3.5 shrink-0', tone === 'success' ? 'text-success' : 'text-muted-foreground', className)} strokeWidth={2.6} />
  if (status === 'failed') return <X className={cn('size-3.5 shrink-0 text-destructive', className)} strokeWidth={2.6} />
  if (status === 'command-failed') return <CircleAlert className={cn('size-3.5 shrink-0 text-warning', className)} />
  return <LoaderCircle className={cn('size-3.5 shrink-0 animate-spin text-muted-foreground', className)} />
}

function ToolGroup({ items }: { items: ToolItem[] }) {
  const busy = items.some((item) => item.status !== 'completed' && item.status !== 'failed')
  const failed = items.filter((item) => item.status === 'failed').length
  const commandsFailed = items.filter((item) => item.succeeded === false).length
  const [open, setOpen] = useState<boolean | null>(null)
  if (items.length === 1 && items[0]) return <ToolStep item={items[0]} />
  const expanded = open ?? busy
  return (
    <div className="flex flex-col gap-1.5" data-testid="tool-group">
      <DisclosureRow open={expanded} onToggle={() => setOpen(!expanded)} className="text-muted-foreground hover:text-foreground">
        <StatusIcon status={busy ? 'in_progress' : failed > 0 ? 'failed' : commandsFailed > 0 ? 'command-failed' : 'completed'} />
        执行工具 {items.length} 次{failed > 0 ? ` · ${failed} 次失败` : ''}{commandsFailed > 0 ? ` · ${commandsFailed} 条命令失败` : ''}
      </DisclosureRow>
      {expanded && (
        <div className="flex flex-col gap-0.5 pl-5">
          {items.map((item) => (
            <ToolStep key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  )
}

function ToolStep({ item, unverified = false }: { item: ToolItem; unverified?: boolean }) {
  // 命令失败的结果是跑完之后才到的，所以默认展开要跟着 item 算，不能只在挂载时定
  const [open, setOpen] = useState<boolean | null>(null)
  const commandFailed = item.succeeded === false
  const expanded = open ?? (commandFailed || unverified)
  const { action, target } = splitTitle(item.title)
  const output = textOf(item)
  const elapsed = useElapsed(item.startedAt, item.status !== 'completed' && item.status !== 'failed')
  return (
    <div className="text-sm" data-testid="tool-call" data-kind="tool" data-status={item.status} data-succeeded={item.succeeded === undefined ? undefined : String(item.succeeded)}>
      <DisclosureRow open={expanded} onToggle={output ? () => setOpen(!expanded) : undefined} className="text-foreground/85">
        {unverified ? <CircleAlert className="size-3.5 shrink-0 text-warning" /> : <StatusIcon status={commandFailed ? 'command-failed' : item.status} />}
        <span className="shrink-0 text-muted-foreground">{action}</span>
        {target && <span className="min-w-0 truncate rounded bg-muted px-1.5 py-px font-mono text-xs">{target}</span>}
        {elapsed !== null && <span className="shrink-0 text-xs text-muted-foreground tabular-nums" data-testid="tool-elapsed">{formatDuration(elapsed)}</span>}
      </DisclosureRow>
      {expanded && output && <pre className="mt-1.5 ml-5 max-h-72 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">{output}</pre>}
    </div>
  )
}

// 运行中每秒刷新一次；结束后不再计时，也不显示
function useElapsed(startedAt: number | undefined, running: boolean): number | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running || startedAt === undefined) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running, startedAt])
  return running && startedAt !== undefined ? now - startedAt : null
}

// 对话里可以点开的一行。有内容可展开才是按钮，带箭头和 hover；没有时箭头位置留空，和相邻的行对齐
function DisclosureRow({ open, onToggle, className, children }: { open?: boolean; onToggle?: () => void; className?: string; children: React.ReactNode }) {
  const base = '-mx-1.5 flex w-fit max-w-[calc(100%+0.75rem)] items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-sm'
  if (!onToggle) {
    return (
      <div className={cn(base, className)}>
        <span className="size-3.5 shrink-0" />
        {children}
      </div>
    )
  }
  return (
    <button type="button" aria-expanded={open} className={cn(base, 'cursor-pointer hover:bg-accent/60', className)} onClick={onToggle}>
      {open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
      {children}
    </button>
  )
}

// 计划：可以直接改文字；点「按计划执行」，把这一轮的需求和改过的计划作为新的一轮发给编码模型
function PlanCard({ item, request, task }: { item: ToolItem; request: string; task: LiveTask }) {
  const original = textOf(item)
  const [text, setText] = useState(original)
  const execute = () => void sendMessage(task.sessionId, `按下面的计划完成任务。\n\n需求：\n${request}\n\n计划：\n${text.trim()}`)
  return (
    <div className="flex flex-col gap-2.5 rounded-xl border px-3.5 py-3" data-testid="tool-call" data-kind="plan" data-status={item.status}>
      <div className="flex items-center gap-2 font-semibold">
        <ListChecks className="size-4 text-primary" />
        计划
      </div>
      <textarea
        aria-label="计划内容"
        value={text}
        rows={Math.min(24, text.split('\n').length + 1)}
        onChange={(event) => setText(event.target.value)}
        className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm leading-relaxed outline-none focus:border-ring/60"
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={task.running || text.trim() === ''} className="px-3.5" onClick={execute}>
          按计划执行
        </Button>
        {text !== original && (
          <button type="button" className="text-sm text-muted-foreground hover:text-foreground" onClick={() => setText(original)}>
            恢复原计划
          </button>
        )}
        <span className="text-xs text-muted-foreground">可以先改计划再执行；不满意就在下面接着说。</span>
      </div>
    </div>
  )
}

// 上下文压缩：第一行是省略和压缩的说明，展开看摘要全文
function CompactionRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false)
  const text = textOf(item)
  const [headline = '', ...rest] = text.split('\n')
  const detail = rest.join('\n').trim()
  return (
    <div className="text-sm" data-testid="tool-call" data-kind="compaction" data-status={item.status}>
      <button type="button" className="flex max-w-full items-start gap-2 text-left text-foreground/85" onClick={() => setOpen(!open)} disabled={!detail}>
        <StatusIcon status={item.status} className="mt-1" />
        <span className="shrink-0 text-muted-foreground">上下文压缩</span>
        <span className="min-w-0 text-muted-foreground">{item.status === 'completed' || item.status === 'failed' ? headline : '正在压缩…'}</span>
        {detail && (open ? <ChevronDown className="mt-1 size-3 shrink-0" /> : <ChevronRight className="mt-1 size-3 shrink-0" />)}
      </button>
      {open && detail && <div className="mt-1.5 ml-5.5 max-h-96 overflow-auto rounded-md bg-muted p-2.5 leading-relaxed whitespace-pre-wrap">{detail}</div>}
    </div>
  )
}

function EditGroup({ items, projectPath, expanded, toggle }: { items: ToolItem[]; projectPath: string; expanded: boolean; toggle?: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  useEffect(() => setOpen(expanded), [expanded])
  if (items.length === 1 && items[0]) return <EditBlock item={items[0]} projectPath={projectPath} expanded={expanded} toggle={toggle} />
  const files = filesOf(items)
  return (
    <div className="space-y-2" data-testid="edit-group">
      <div className="flex items-center gap-2">
        <DisclosureRow open={open} onToggle={() => setOpen(!open)} className="text-muted-foreground hover:text-foreground">
          <StatusIcon status={items.some((item) => item.status === 'failed') ? 'failed' : items.every((item) => item.status === 'completed') ? 'completed' : 'in_progress'} />
          修改 {files.length} 个文件 · {items.length} 次编辑
          <DiffCounts added={files.reduce((total, file) => total + file.added, 0)} removed={files.reduce((total, file) => total + file.removed, 0)} />
        </DisclosureRow>
        {toggle && open && <span className="ml-auto flex pr-1">{toggle}</span>}
      </div>
      <div hidden={!open} className="space-y-2 border-l pl-3">{items.map((item) => <EditBlock key={item.id} item={item} projectPath={projectPath} expanded={expanded} />)}</div>
    </div>
  )
}

// 每个文件只有一行标题：收起时是普通行，展开后这一行就是改动卡片的顶栏，代码区直接接在下面
function EditBlock({ item, projectPath, expanded = false, toggle }: { item: ToolItem; projectPath: string; expanded?: boolean; toggle?: React.ReactNode }) {
  const [open, setOpen] = useState(expanded)
  useEffect(() => setOpen(expanded), [expanded])
  const diffs = item.content.flatMap((content) => (content.type === 'diff' ? [content] : []))
  return (
    <div className="flex flex-col gap-2" data-testid="tool-call" data-kind="edit" data-status={item.status}>
      {diffs.map((content, index) => {
        const path = relativePath(content.path, projectPath)
        return (
          <div key={content.path} className={cn('overflow-hidden rounded-lg border', !open && 'border-transparent')}>
            <div className={cn('flex items-center', open ? 'border-b bg-muted/50 hover:bg-accent dark:bg-muted dark:hover:bg-accent' : 'hover:bg-muted/60')}>
              <button type="button" aria-expanded={open} aria-label={`查看改动 ${path}`} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm focus-visible:-outline-offset-2" onClick={() => setOpen(!open)}>
                {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
                <StatusIcon status={item.status} />
                <span className="shrink-0 text-muted-foreground">{content.oldText === null ? '新建' : '编辑'}</span>
                <span title={path} className="min-w-0 flex-1 truncate font-mono text-xs">{path}</span>
                <DiffCounts {...diffStats(content.oldText ?? null, content.newText)} />
              </button>
              {index === 0 && toggle && <span className="flex pr-1">{toggle}</span>}
            </div>
            {open && <DiffView oldText={content.oldText ?? null} newText={content.newText} />}
          </div>
        )
      })}
    </div>
  )
}

// 一轮里所有改动一起展开或收起
function EditDetailsToggle({ expanded, onToggle }: { expanded: boolean; onToggle(): void }) {
  const label = expanded ? '收起代码详情' : '展开代码详情'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={label} className="text-muted-foreground" onClick={onToggle}>
          {expanded ? <ChevronsDownUp /> : <ChevronsUpDown />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

// 连续的检查、扫描、审查全部干净通过时收成一行，点开看各项；有一项没过、有提醒或附注就逐项显示。
// 收起时各项仍留在 DOM 里（hidden），按 data-kind 数卡片的地方不受影响
function CheckGroup({ items }: { items: ToolItem[] }) {
  const [open, setOpen] = useState(false)
  const rows = items.map((item) => <CheckItem key={item.id} item={item} />)
  if (items.length < 2 || !items.every(checkPassed)) return <>{rows}</>
  const names = [...new Set(items.map(checkName))]
  // 只有检查命令真跑过才算验证；只有安全检查和规范审查时，没发现问题不等于检查通过
  const verified = items.some((item) => toolBlockType(item) === 'check')
  return (
    <div className="flex flex-col gap-1.5" data-testid="check-group">
      <DisclosureRow open={open} onToggle={() => setOpen(!open)} className="text-foreground/85">
        {/* success-color-allow: 组里有检查命令且全部通过时才画绿色 */}
        <Check className={cn('size-3.5 shrink-0', verified ? 'text-success' : 'text-muted-foreground')} strokeWidth={2.6} />
        <span className="shrink-0 text-muted-foreground">{verified ? '自动检查通过' : '未发现问题'}</span>
        <span className="min-w-0 truncate">{names.join('、')}</span>
      </DisclosureRow>
      <div hidden={!open} className="flex flex-col gap-0.5 pl-5">
        {rows}
      </div>
    </div>
  )
}

function CheckItem({ item }: { item: ToolItem }) {
  const type = toolBlockType(item)
  if (type === 'review') return <ReviewBlock item={item} />
  if (type === 'security') return <SecurityBlock item={item} />
  return <CheckRow item={item} />
}

function checkName(item: ToolItem): string {
  const type = toolBlockType(item)
  if (type === 'review') return '规范审查'
  if (type === 'security') return SECURITY_TITLES.get(item.title) ?? item.title
  return item.title.slice(0, item.title.indexOf('：'))
}

// 有 result 时只有 passed 算干净通过，提醒、只看了一部分、工具出错都要单独显示。
// 旧记录没有 result：安全和审查的结果只有一行「没有发现…」才算干净，带提醒项或附注的单独显示
function checkPassed(item: ToolItem): boolean {
  if (item.status !== 'completed') return false
  if (item.result) return item.result === 'passed'
  if (toolBlockType(item) === 'check') return true
  const lines = textOf(item).split('\n').filter(Boolean)
  return lines.length === 1 && !SECURITY_LINE.test(lines[0] ?? '')
}

function CheckRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(item.status === 'failed')
  const separator = item.title.indexOf('：')
  const label = item.title.slice(0, separator)
  const command = item.title.slice(separator + 1)
  const output = textOf(item)
  const result = item.status === 'completed' ? '通过' : item.status === 'failed' ? '没通过' : '运行中…'
  return (
    <div className="text-sm" data-testid="tool-call" data-kind="check" data-status={item.status}>
      <DisclosureRow open={open} onToggle={output ? () => setOpen(!open) : undefined}>
        {/* success-color-allow: 检查命令通过 */}
        <StatusIcon status={item.status} tone="success" />
        <span className="shrink-0 text-muted-foreground">{label}</span>
        <span className="min-w-0 truncate font-mono text-xs">{command}</span>
        {/* success-color-allow: 检查命令通过 */}
        <span className={cn('shrink-0', item.status === 'completed' && 'text-success', item.status === 'failed' && 'text-destructive')}>{result}</span>
      </DisclosureRow>
      {open && output && <pre className="mt-1.5 ml-5 max-h-72 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">{output}</pre>}
    </div>
  )
}

const FINDING_PATTERN = /^(\S+) {2}(\S+:\d+) {2}(.+)$/

function ReviewBlock({ item }: { item: ToolItem }) {
  const text = textOf(item)
  const common = { 'data-testid': 'tool-call', 'data-kind': 'review', 'data-status': item.status }
  if (item.status !== 'completed' && item.status !== 'failed') {
    return (
      <div {...common}>
        <DisclosureRow className="text-muted-foreground">
          <StatusIcon status={item.status} />
          规范审查中…
        </DisclosureRow>
      </div>
    )
  }
  // 评审模型出错不拦截完成，只提醒；core 的正文是「审查没有完成，这次不拦截：原因」，这里只留原因
  if (item.result === 'error') {
    return (
      <div {...common}>
        <DisclosureRow className="items-start">
          <CircleAlert className="mt-1 size-3.5 shrink-0 text-warning" />
          <span className="shrink-0">规范审查没有完成，这次不拦截</span>
          <span className="whitespace-pre-wrap text-muted-foreground">{text.slice(text.indexOf('：') + 1)}</span>
        </DisclosureRow>
      </div>
    )
  }
  if (item.status === 'completed') {
    return (
      <div {...common}>
        <DisclosureRow className="items-start">
          {item.result === 'partial' ? <CircleAlert className="mt-1 size-3.5 shrink-0 text-warning" /> : <StatusIcon status="completed" className="mt-1" />}
          <span className="shrink-0 text-muted-foreground">规范审查</span>
          <span className="whitespace-pre-wrap">{text}</span>
        </DisclosureRow>
      </div>
    )
  }
  const lines = text.split('\n').filter(Boolean)
  const findings = lines.map((line) => FINDING_PATTERN.exec(line))
  const count = findings.filter(Boolean).length
  return (
    <div {...common} className="flex flex-col gap-1.5 rounded-xl border border-destructive/25 bg-destructive-soft px-3 py-2.5 text-sm">
      <div className="flex items-center gap-2 font-semibold text-destructive">
        <X className="size-3.5" strokeWidth={2.6} />
        {count > 0 ? `规范审查 · ${count} 处问题，已打回` : '规范审查'}
      </div>
      {lines.map((line, index) => {
        const match = findings[index]
        if (!match) return <div key={index} className="leading-relaxed">{line}</div>
        return (
          <div key={index} className="flex flex-wrap gap-x-2.5 leading-relaxed">
            <span className="font-mono text-xs leading-6 text-destructive">{match[1]}</span>
            <span className="font-mono text-xs leading-6">{match[2]}</span>
            <span>{match[3]}</span>
          </div>
        )
      })}
    </div>
  )
}

// 安全检查卡片的一行：级别  规则号  路径:行号  说明
const SECURITY_LINE = /^(高危|提醒|已放行) {2}(\S+) {2}(\S+:\d+) {2}(.+)$/
const LEVEL_STYLES: Record<string, string> = {
  高危: 'bg-destructive/10 text-destructive',
  提醒: 'bg-warning/10 text-warning',
  已放行: 'bg-muted text-muted-foreground',
}

function SecurityBlock({ item }: { item: ToolItem }) {
  const text = textOf(item)
  const title = SECURITY_TITLES.get(item.title) ?? item.title
  const common = { 'data-testid': 'tool-call', 'data-kind': 'security', 'data-status': item.status }
  if (item.status !== 'completed' && item.status !== 'failed') {
    return (
      <div {...common}>
        <DisclosureRow className="text-muted-foreground">
          <StatusIcon status={item.status} />
          {title}中…
        </DisclosureRow>
      </div>
    )
  }
  const rows = text
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ line, match: SECURITY_LINE.exec(line) }))
  const findings = rows.filter((row) => row.match)
  if (findings.length === 0) {
    // 检查出错、只看了一部分、只有附注都不拦截，提醒留意；旧记录没有 result，出错时照旧按 failed 画
    const attention = item.result === 'error' || item.result === 'partial' || item.result === 'warned'
    const failed = item.status === 'failed' && !attention
    return (
      <div {...common}>
        <DisclosureRow className={cn('items-start', failed && 'text-muted-foreground')}>
          {attention ? <CircleAlert className="mt-1 size-3.5 shrink-0 text-warning" /> : <StatusIcon status={failed ? 'failed' : 'completed'} className="mt-1" />}
          <span className="shrink-0 text-muted-foreground">{title}</span>
          <span className="whitespace-pre-wrap">{text}</span>
        </DisclosureRow>
      </div>
    )
  }
  const high = findings.filter((row) => row.match?.[1] === '高危').length
  return (
    <div
      {...common}
      className={cn(
        'flex flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-sm',
        high > 0 ? 'border-destructive/25 bg-destructive-soft' : 'border-warning/25 bg-warning-soft',
      )}
    >
      <div className={cn('flex items-center gap-2 font-semibold', high > 0 && 'text-destructive')}>
        {high > 0 ? <X className="size-3.5" strokeWidth={2.6} /> : <CircleAlert className="size-3.5 text-warning" />}
        {high > 0 ? `${title} · ${high} 处高危问题，已打回` : `${title} · 没有高危问题，${findings.length} 条需要留意`}
      </div>
      {rows.map(({ line, match }, index) =>
        match ? (
          <div key={index} className="flex flex-wrap items-baseline gap-x-2.5 leading-relaxed" data-testid="security-finding">
            <span className={cn('shrink-0 rounded px-1.5 text-xs', LEVEL_STYLES[match[1] ?? ''])}>{match[1]}</span>
            <span className="font-mono text-xs">{match[2]}</span>
            <span className="font-mono text-xs">{match[3]}</span>
            <span>{match[4]}</span>
          </div>
        ) : (
          <div key={index} className="leading-relaxed">
            {line}
          </div>
        ),
      )}
    </div>
  )
}

interface ReportFinding {
  level: string
  ruleId: string
  location: string
  problem: string
  flow: string | null
  fix: string | null
}

// 报告卡片：第一行总结，然后每个问题一行，下面缩进的「链路」「修复」行属于上面那个问题
function parseReport(text: string): { summary: string; findings: ReportFinding[] } {
  const [summary = '', ...rest] = text.split('\n')
  const findings: ReportFinding[] = []
  for (const line of rest) {
    const match = SECURITY_LINE.exec(line)
    if (match) {
      findings.push({ level: match[1] ?? '', ruleId: match[2] ?? '', location: match[3] ?? '', problem: match[4] ?? '', flow: null, fix: null })
      continue
    }
    const current = findings.at(-1)
    if (current && line.startsWith('  链路：')) current.flow = line.slice('  链路：'.length)
    else if (current && line.startsWith('  修复：')) current.fix = line.slice('  修复：'.length)
  }
  return { summary, findings }
}

function DeepScanReport({ item, task }: { item: ToolItem; task: LiveTask }) {
  const { summary, findings } = useMemo(() => parseReport(textOf(item)), [item])
  // 默认勾上高危的
  const [selected, setSelected] = useState<Set<number>>(() => new Set(findings.flatMap((finding, index) => (finding.level === '高危' ? [index] : []))))
  const toggle = (index: number) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  const fix = () => {
    const lines = findings
      .filter((_, index) => selected.has(index))
      .map(
        (finding, index) =>
          `${index + 1}. [${finding.ruleId}] ${finding.location} ${finding.problem}` +
          (finding.flow ? `\n   链路：${finding.flow}` : '') +
          (finding.fix ? `\n   修复建议：${finding.fix}` : ''),
      )
    void sendMessage(task.sessionId, `修复深度安全扫描发现的这些问题：\n${lines.join('\n')}`)
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border px-3.5 py-3 text-sm" data-testid="tool-call" data-kind="deep-scan" data-status={item.status}>
      <div className="font-semibold">深度扫描报告</div>
      <p className="text-muted-foreground">{summary}</p>
      {findings.length === 0 && <p>没有发现可以确认的安全问题。</p>}
      {findings.map((finding, index) => (
        <label key={index} className="flex cursor-pointer gap-2.5 rounded-lg border px-3 py-2" data-testid="deep-scan-finding">
          <Checkbox className="mt-0.5" checked={selected.has(index)} onCheckedChange={() => toggle(index)} />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className={cn('rounded px-1.5 text-xs', LEVEL_STYLES[finding.level])}>{finding.level}</span>
              <span className="font-mono text-xs">{finding.ruleId}</span>
              <span className="font-mono text-xs">{finding.location}</span>
            </div>
            <div>{finding.problem}</div>
            {finding.flow && <div className="text-xs text-muted-foreground">链路：{finding.flow}</div>}
            {finding.fix && <div className="text-xs text-muted-foreground">修复：{finding.fix}</div>}
          </div>
        </label>
      ))}
      {findings.length > 0 && (
        <Button disabled={selected.size === 0} className="self-start" onClick={fix}>
          {task.running ? `排队修复选中的 ${selected.size} 个问题` : `修复选中的 ${selected.size} 个问题`}
        </Button>
      )}
    </div>
  )
}

interface ChangedFile {
  path: string
  added: number
  removed: number
}

function filesOf(items: TranscriptItem[]): ChangedFile[] {
  const files = new Map<string, { oldText: string | null; newText: string }>()
  for (const item of items) {
    if (item.kind !== 'tool' || item.status !== 'completed') continue
    for (const content of item.content) {
      if (content.type !== 'diff') continue
      const existing = files.get(content.path)
      files.set(content.path, { oldText: existing ? existing.oldText : content.oldText ?? null, newText: content.newText })
    }
  }
  return [...files].map(([path, content]) => ({ path, ...diffStats(content.oldText, content.newText) }))
}

function FinishCard({ item, files, commandsFailed, projectPath, latest, restored, onRestore, progress }: { item: ToolItem; files: ChangedFile[]; commandsFailed: number; projectPath: string; latest: boolean; restored: boolean; onRestore?: () => void; progress?: TaskProgressView }) {
  const text = textOf(item)
  const passed = item.status === 'completed'
  const verdict = finishVerdict(item)
  const noChecks = passed && item.unverified === true
  // 没有检查点时 core 判断不了命令或 MCP 工具改没改文件，直接放行、不跑检查；这条路径不带「没配检查命令」的标记
  const unknownChanges = verdict.tone === 'unverified' && !noChecks
  // 最终检查通过了，过程中失败的命令不再需要留意，只作说明
  const verified = verdict.tone === 'verified'
  // 之后撤销过：改动不一定还在，结论不再上色、不提醒，也不再指向审阅和撤销。
  // 不看 files：只靠命令改的文件没有 diff，files 为空，但检查照样跑过、照样会画成已验证
  const undone = restored && passed && verdict.tone !== 'nochange'
  const warnings = passed && !undone
    ? [noChecks && '没有配置检查命令', unknownChanges && '没有检查点，无法判断命令或 MCP 工具是否改了文件，这次没有跑检查', commandsFailed > 0 && !verified && `有 ${commandsFailed} 条命令失败`].filter((warning): warning is string => warning !== false)
    : []
  const openReview = () => store.set((state) => ({ ...state, panel: 'review' }))
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4" data-testid="tool-call" data-kind="finish" data-status={item.status} data-unverified={noChecks ? 'true' : undefined} data-restored={undone ? 'true' : undefined}>
      <div className={cn('flex items-center gap-2 font-semibold', !undone && verdict.tone === 'failed' && 'text-destructive', !undone && verdict.tone === 'unverified' && 'text-warning')}>
        {undone ? (
          <StatusIcon status={item.status} className="size-4" />
        ) : verdict.tone === 'unverified' ? (
          <CircleAlert className="size-4 shrink-0" />
        ) : verified ? (
          // success-color-allow: 完成卡只在经检查命令验证过（或复用已验证的工作区）时画绿色，旧卡没有 verification，不会走到这里
          <Check className="size-4 shrink-0 text-success" strokeWidth={2.6} />
        ) : (
          <StatusIcon status={item.status} className="size-4" />
        )}
        {verdict.label}
        {undone && <span className="font-normal text-muted-foreground">· 之后撤销过改动</span>}
        {passed && files.length > 0 && (
          <span className="ml-auto flex items-center gap-1.5 text-xs font-normal text-muted-foreground tabular-nums" data-testid="finish-counts">
            {files.length} 个文件 <DiffCounts added={files.reduce((total, file) => total + file.added, 0)} removed={files.reduce((total, file) => total + file.removed, 0)} />
          </span>
        )}
      </div>
      {warnings.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-sm" role="note" data-testid="finish-warnings">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="flex flex-col gap-0.5">
            {warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        </div>
      )}
      {verified && commandsFailed > 0 && !undone && <p className="text-sm text-muted-foreground">过程中有 {commandsFailed} 条命令失败（最终检查已通过）</p>}
      {text && (passed ? <Markdown text={text} /> : <p className="text-sm text-muted-foreground">{text}</p>)}
      {passed && progress && progress.requirements.length > 0 && <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {/* success-color-allow: 完成条件的证据已核对 */}
        {progress.requirements.map((requirement) => <span key={requirement.id} className="flex items-center gap-1">{requirement.receiptId ? <Check className="size-3 text-success" /> : <span>○</span>}{requirement.title} · {requirement.receiptId ? '证据已核对' : '待完成'}</span>)}
      </div>}
      {passed && files.length > 0 && (
        <div className="-mx-2 flex flex-col">
          {files.map((file) => {
            const path = relativePath(file.path, projectPath)
            const slash = path.lastIndexOf('/')
            const row = (
              <>
                <span className="min-w-0 flex-1 truncate font-mono text-xs">
                  {slash >= 0 && <span className="text-muted-foreground">{path.slice(0, slash + 1)}</span>}
                  {path.slice(slash + 1)}
                </span>
                <span className="tabular-nums">
                  <DiffCounts added={file.added} removed={file.removed} />
                </span>
              </>
            )
            return undone ? (
              <div key={file.path} title={path} className="flex items-center gap-2 px-2 py-1 text-muted-foreground">
                {row}
              </div>
            ) : (
              <button key={file.path} type="button" title={path} className="flex items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-accent" onClick={openReview}>
                {row}
              </button>
            )
          })}
        </div>
      )}
      {passed && files.length > 0 && !undone && (
        <div className="flex items-center gap-2">
          <Button variant={latest ? 'default' : 'outline'} size="sm" onClick={openReview}>审阅改动</Button>
          {onRestore && <Button variant="ghost" size="sm" onClick={onRestore}>撤销本轮</Button>}
        </div>
      )}
    </div>
  )
}

function Timeline({ turns, activeTurn, onJump }: { turns: Turn[]; activeTurn: string | null; onJump(turnId: string): void }) {
  return (
    <nav aria-label="对话时间线" className="absolute top-7 right-5 flex max-h-[70%] flex-col gap-1 overflow-hidden">
      {turns.map((turn) => (
        <Tooltip key={turn.id}>
          <TooltipTrigger asChild>
            <button type="button" aria-label={`跳到：${turn.prompt.slice(0, 30)}`} className="flex h-2.5 w-4 items-center justify-end" onClick={() => onJump(turn.id)}>
              <span className={cn('h-0.5 rounded-full', turn.id === activeTurn ? 'w-3 bg-primary' : 'w-2 bg-muted-foreground/50')} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" className="max-w-64 truncate">
            {turn.prompt.split(/\r?\n/)[0]}
          </TooltipContent>
        </Tooltip>
      ))}
    </nav>
  )
}
