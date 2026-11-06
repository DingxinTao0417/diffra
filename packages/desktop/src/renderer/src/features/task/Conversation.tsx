import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { StopReason } from '@diffra/core/types'
import { ArrowDown, Check, ChevronDown, ChevronRight, Copy, File, LoaderCircle, RefreshCw, Undo2, X } from 'lucide-react'
import { cn } from 'cn'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DiffCounts, DiffView, diffStats, relativePath } from '@/features/session/DiffView'
import { PermissionCard } from '@/features/session/PermissionCard'
import type { TranscriptItem, Turn } from '@/features/session/transcript'
import { formatDuration } from '@/lib/format'
import { respondPermission } from '@/state/actions'
import { type LiveTask, showToast, store } from '@/state/store'
import { Markdown } from './Markdown'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

type Block =
  | { type: 'item'; item: Exclude<TranscriptItem, ToolItem> }
  | { type: 'tools'; id: string; items: ToolItem[] }
  | { type: 'edit' | 'check' | 'review' | 'finish'; item: ToolItem }

const STOP_LABELS: Partial<Record<StopReason, string>> = {
  cancelled: '已停止',
  max_tokens: '上下文快用完了，已停止',
  max_turn_requests: '达到步数上限，已停止',
  refusal: '模型拒绝了这个任务',
}

const CHECK_PREFIXES = ['快速检查：', '完成检查：']

function toolBlockType(item: ToolItem): 'edit' | 'check' | 'review' | 'finish' | null {
  if (item.title === '完成') return 'finish'
  if (item.title === '规范审查') return 'review'
  if (CHECK_PREFIXES.some((prefix) => item.title.startsWith(prefix))) return 'check'
  if (item.content.some((content) => content.type === 'diff')) return 'edit'
  return null
}

// 连续的读文件、搜索、命令等普通工具调用收成一组；改动、检查、审查、完成单独显示
function toBlocks(items: TranscriptItem[]): Block[] {
  const blocks: Block[] = []
  for (const item of items) {
    if (item.kind !== 'tool') {
      blocks.push({ type: 'item', item })
      continue
    }
    const type = toolBlockType(item)
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
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto px-8 pt-6 pb-4">
        <div className="mx-auto flex max-w-(--content-max) flex-col gap-7">
          {task.turns.length === 0 && <p className="text-sm text-muted-foreground">描述你要做的事，比如「修复登录页的报错」或「给 utils 加单元测试」。</p>}
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
        <button
          type="button"
          aria-label="回到底部"
          className="absolute bottom-3 left-1/2 flex size-7.5 -translate-x-1/2 items-center justify-center rounded-full border bg-background shadow-sm hover:bg-muted"
          onClick={scrollToBottom}
        >
          <ArrowDown className="size-3.5" />
        </button>
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
  const blocks = useMemo(() => toBlocks(turn.items), [turn.items])
  const changedFiles = useMemo(() => filesOf(turn.items), [turn.items])
  const stopLabel = turn.stopReason ? STOP_LABELS[turn.stopReason] : undefined

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
    <section data-testid="turn" data-turn-id={turn.id} className="flex flex-col gap-3.5">
      {blocks.map((block) => {
        switch (block.type) {
          case 'item':
            return <ItemView key={block.item.id} item={block.item} />
          case 'tools':
            return <ToolGroup key={block.id} items={block.items} />
          case 'edit':
            return <EditBlock key={block.item.id} item={block.item} projectPath={task.project} />
          case 'check':
            return <CheckRow key={block.item.id} item={block.item} />
          case 'review':
            return <ReviewBlock key={block.item.id} item={block.item} />
          case 'finish':
            return <FinishCard key={block.item.id} item={block.item} files={changedFiles} projectPath={task.project} />
        }
      })}
      {active && task.permission && <PermissionCard request={task.permission} onRespond={(optionId) => respondPermission(task.sessionId, optionId)} />}
      {active && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          进行中…
        </p>
      )}
      {stopLabel && <p className="text-sm text-muted-foreground">{stopLabel}</p>}
      {turn.error && (
        <p className="text-sm text-destructive" role="alert">
          {turn.error}
        </p>
      )}
      {!active && (
        <div className="flex items-center gap-1 text-muted-foreground" data-testid="turn-actions">
          <ActionButton label="复制回复" onClick={copy}>
            <Copy className="size-3.5" />
          </ActionButton>
          {task.info.checkpoints && (
            <ActionButton label="撤销到这一轮之前" disabled={task.running} onClick={onRestore}>
              <Undo2 className="size-3.5" />
            </ActionButton>
          )}
          {last && (
            <ActionButton label="重新生成" disabled={task.running} onClick={onRegenerate}>
              <RefreshCw className="size-3.5" />
            </ActionButton>
          )}
          {turn.startedAt && turn.endedAt && <span className="ml-auto text-xs">用时 {formatDuration(turn.endedAt - turn.startedAt)}</span>}
        </div>
      )}
    </section>
  )
}

function ActionButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className="flex size-7 items-center justify-center rounded-md hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function ItemView({ item }: { item: Exclude<TranscriptItem, ToolItem> }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="max-w-[80%] self-end rounded-[14px] bg-secondary px-3.5 py-2.5 leading-relaxed whitespace-pre-wrap" data-testid="user-message">
          {item.text}
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
            'rounded-[10px] border px-3 py-2 text-[0.93rem]',
            item.severity === 'error' && 'border-destructive/30 bg-destructive/5 text-destructive',
            item.severity === 'warning' && 'border-warning/30 bg-warning/5',
          )}
        >
          <div className="font-medium">{item.title}</div>
          {item.description && <div className="mt-1 whitespace-pre-wrap text-muted-foreground">{item.description}</div>}
        </div>
      )
  }
}

function Thought({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const preview = text.trim().split(/\r?\n/)[0] ?? ''
  return (
    <div className="text-[0.93rem] text-muted-foreground">
      <button type="button" className="flex max-w-full items-center gap-1.5 hover:text-foreground" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
        <span className="truncate">思考{preview && !open ? ` · ${preview}` : ''}</span>
      </button>
      {open && <div className="mt-1.5 border-l-2 pl-3 leading-relaxed whitespace-pre-wrap">{text}</div>}
    </div>
  )
}

function StatusIcon({ status, className }: { status: string; className?: string }) {
  if (status === 'completed') return <Check className={cn('size-3.5 shrink-0 text-success', className)} strokeWidth={2.6} />
  if (status === 'failed') return <X className={cn('size-3.5 shrink-0 text-destructive', className)} strokeWidth={2.6} />
  return <LoaderCircle className={cn('size-3.5 shrink-0 animate-spin text-muted-foreground', className)} />
}

function ToolGroup({ items }: { items: ToolItem[] }) {
  const busy = items.some((item) => item.status !== 'completed' && item.status !== 'failed')
  const failed = items.filter((item) => item.status === 'failed').length
  const [open, setOpen] = useState<boolean | null>(null)
  if (items.length === 1 && items[0]) return <ToolStep item={items[0]} />
  const expanded = open ?? busy
  return (
    <div className="flex flex-col gap-1.5">
      <button type="button" className="flex items-center gap-1.5 self-start text-[0.93rem] text-muted-foreground hover:text-foreground" onClick={() => setOpen(!expanded)}>
        {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        执行工具 {items.length} 次{failed > 0 ? ` · ${failed} 次失败` : ''}
        {busy && <LoaderCircle className="size-3 animate-spin" />}
      </button>
      {expanded && (
        <div className="flex flex-col gap-1 pl-4.5">
          {items.map((item) => (
            <ToolStep key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  )
}

function ToolStep({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false)
  const { action, target } = splitTitle(item.title)
  const output = textOf(item)
  return (
    <div className="text-[0.93rem]" data-testid="tool-call" data-kind="tool" data-status={item.status}>
      <button type="button" className="flex max-w-full items-center gap-2 text-left text-foreground/85" onClick={() => setOpen(!open)} disabled={!output}>
        <StatusIcon status={item.status} />
        <span className="shrink-0 text-muted-foreground">{action}</span>
        {target && <span className="min-w-0 truncate rounded bg-muted px-1.5 py-px font-mono text-xs">{target}</span>}
      </button>
      {open && output && <pre className="mt-1.5 ml-5.5 max-h-72 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">{output}</pre>}
    </div>
  )
}

function EditBlock({ item, projectPath }: { item: ToolItem; projectPath: string }) {
  return (
    <div className="flex flex-col gap-2" data-testid="tool-call" data-kind="edit" data-status={item.status}>
      {item.content.flatMap((content) =>
        content.type === 'diff'
          ? [
              <DiffView
                key={content.path}
                path={content.path}
                oldText={content.oldText ?? null}
                newText={content.newText}
                projectPath={projectPath}
                status={<StatusIcon status={item.status} />}
              />,
            ]
          : [],
      )}
    </div>
  )
}

function CheckRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(item.status === 'failed')
  const separator = item.title.indexOf('：')
  const label = item.title.slice(0, separator)
  const command = item.title.slice(separator + 1)
  const output = textOf(item)
  const result = item.status === 'completed' ? '通过' : item.status === 'failed' ? '没通过' : '运行中…'
  return (
    <div className="text-[0.93rem]" data-testid="tool-call" data-kind="check" data-status={item.status}>
      <button type="button" className="flex max-w-full items-center gap-2 text-left" onClick={() => setOpen(!open)} disabled={!output}>
        <StatusIcon status={item.status} />
        <span className="shrink-0 text-muted-foreground">{label}</span>
        <span className="min-w-0 truncate font-mono text-xs">{command}</span>
        <span className={cn('shrink-0', item.status === 'completed' && 'text-success', item.status === 'failed' && 'text-destructive')}>{result}</span>
      </button>
      {open && output && <pre className="mt-1.5 ml-5.5 max-h-72 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">{output}</pre>}
    </div>
  )
}

const FINDING_PATTERN = /^(\S+) {2}(\S+:\d+) {2}(.+)$/

function ReviewBlock({ item }: { item: ToolItem }) {
  const text = textOf(item)
  const common = { 'data-testid': 'tool-call', 'data-kind': 'review', 'data-status': item.status }
  if (item.status !== 'completed' && item.status !== 'failed') {
    return (
      <div {...common} className="flex items-center gap-2 text-[0.93rem] text-muted-foreground">
        <StatusIcon status={item.status} />
        规范审查中…
      </div>
    )
  }
  if (item.status === 'completed') {
    return (
      <div {...common} className="flex items-start gap-2 text-[0.93rem]">
        <StatusIcon status="completed" className="mt-1" />
        <span className="shrink-0 text-muted-foreground">规范审查</span>
        <span className="whitespace-pre-wrap">{text}</span>
      </div>
    )
  }
  const lines = text.split('\n').filter(Boolean)
  const findings = lines.map((line) => FINDING_PATTERN.exec(line))
  const count = findings.filter(Boolean).length
  return (
    <div {...common} className="flex flex-col gap-1.5 rounded-[10px] border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-[0.93rem]">
      <div className="flex items-center gap-2 font-medium text-destructive">
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

interface ChangedFile {
  path: string
  added: number
  removed: number
}

function filesOf(items: TranscriptItem[]): ChangedFile[] {
  const files = new Map<string, ChangedFile>()
  for (const item of items) {
    if (item.kind !== 'tool') continue
    for (const content of item.content) {
      if (content.type !== 'diff') continue
      const { added, removed } = diffStats(content.oldText ?? null, content.newText)
      const existing = files.get(content.path)
      files.set(content.path, { path: content.path, added: (existing?.added ?? 0) + added, removed: (existing?.removed ?? 0) + removed })
    }
  }
  return [...files.values()]
}

function FinishCard({ item, files, projectPath }: { item: ToolItem; files: ChangedFile[]; projectPath: string }) {
  const text = textOf(item)
  const passed = item.status === 'completed'
  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border px-3.5 py-3" data-testid="tool-call" data-kind="finish" data-status={item.status}>
      <div className={cn('flex items-center gap-2 font-medium', !passed && 'text-destructive')}>
        <StatusIcon status={item.status} className="size-4" />
        {passed ? '完成' : '还没完成'}
      </div>
      {text && (passed ? <Markdown text={text} /> : <p className="text-[0.93rem] text-muted-foreground">{text}</p>)}
      {passed && files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((file) => (
            <button
              key={file.path}
              type="button"
              className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[0.93rem] hover:bg-muted"
              onClick={() => store.set((state) => ({ ...state, panel: 'review' }))}
            >
              <File className="size-3.5" />
              <span className="font-mono text-xs">{relativePath(file.path, projectPath)}</span>
              <DiffCounts added={file.added} removed={file.removed} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Timeline({ turns, activeTurn, onJump }: { turns: Turn[]; activeTurn: string | null; onJump(turnId: string): void }) {
  return (
    <nav aria-label="对话时间线" className="absolute top-7 right-2.5 flex max-h-[70%] flex-col gap-1 overflow-hidden">
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
