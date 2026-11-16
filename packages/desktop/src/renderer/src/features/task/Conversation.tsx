import { Fragment, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { type ModelErrorKind, type PromptImage, type RemoteSource, STEPS_CARD_TITLE } from '@diffra/core/types'
import type { PermissionRequestEvent } from '../../../../shared/ipc'
import type { ModelRef } from '../../../../shared/settings'
import { ArrowDown, ArrowUpRight, Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, CircleAlert, Copy, Download, History, ListChecks, LoaderCircle, Map as MapIcon, MessageSquare, MonitorSmartphone, RefreshCw, FileText, SearchCheck, Sparkles, Square, Target, Undo2, Wrench, X } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DiffCounts, DiffView, diffStats, relativePath } from '@/features/session/DiffView'
import { editKey, editMeta, type EditTexts, replayEdits } from '@/features/session/edit-replay'
import type { TranscriptItem, Turn } from '@/features/session/transcript'
import { TodoAcceptanceCard } from '@/features/todos/TodoAcceptanceCard'
import { errorMessage } from '@/lib/errors'
import { formatDuration, formatTokens } from '@/lib/format'
import { imageUrl } from '@/lib/images'
import { finishVerdict } from '@/lib/turn-verdict'
import { compactTask, diagnose, fillComposer, generateCandidates, openSettings, openTask, sendMessage, setTaskModel, switchTurnVersion } from '@/state/actions'
import { type LiveTask, showToast, store, useAppState } from '@/state/store'
import { ModelMenu } from './Composer'
import { AnswerContext, type AnswerTarget } from './answer-links'
import { Markdown } from './Markdown'
import { QuestionBar } from './QuestionBar'
import { ReadOnlyContext, useReadOnly } from './read-only'
import { useRemoteTask } from './remote-task'
import { StaticProjectContext, useStatic } from './static-context'
import { SelectionAsk } from './SelectionAsk'
import { TurnVersions, VersionCompare, versionOrder } from './TurnVersions'
import { ConversationSearch } from './ConversationSearch'
import { ExportMenu, exportTurns } from './export'
import { SpeakButton } from './SpeakButton'
import { TurnMap } from './TurnMap'
import { TurnReplay } from './TurnReplay'
import { PromptImagesContext } from './rich/annotations'
import { PluginBlocksContext, useSessionPluginBlocks } from './rich/PluginBlock'
import { McpAppCard } from './McpAppCard'
import { useFullOutput } from './tool-output'
import { VisualCard, VisualHistoryContext, type VisualVersion } from './VisualCard'
import { PhotosCard } from './cards/PhotosCard'
import { CARD_COMPACT, CardShell } from './cards/CardShell'
import { AgentTeam } from './cards/AgentTeam'
import { BrowserSummary, isBrowserStep } from './cards/BrowserSummary'
import { CompactionBar } from './cards/CompactionBar'
import { PlanSteps, planProgressText, splitPlan, stepStatuses } from './cards/PlanSteps'
import { CandidatesCard, CandidatesDialog } from './cards/CandidatesCard'
import { FINDING_PATTERN, levelStyle, ReviewFindings, SecurityFindings } from './cards/FindingLists'
import { LocationLink } from './cards/LocationLink'
import { ShellAction } from './rich/BlockShell'
import { ToolOutputView } from './cards/ToolOutputView'
import { TurnReport, type TurnReportData } from './cards/TurnReport'
import { parseTestSummary, splitCommandOutput } from './cards/output-parsers'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

// 过程组里的一项：思考，或者普通工具调用、改动
type ProcessItem = Extract<TranscriptItem, { kind: 'thought' }> | ToolItem

type Block =
  | { type: 'item'; item: Exclude<TranscriptItem, ProcessItem> }
  | { type: 'process'; id: string; items: ProcessItem[] }
  | { type: 'checks'; id: string; items: ToolItem[] }
  | { type: 'edit' | 'deep-scan' | 'compaction' | 'plan' | 'verify' | 'agent' | 'diagnosis' | 'visual' | 'photos' | 'mcp-ui' | 'wait' | 'task' | 'candidates'; item: ToolItem }

const isRunning = (item: TranscriptItem | undefined) => item?.kind === 'tool' && item.status !== 'completed' && item.status !== 'failed'

// 这几种块在跑的时候自己会转圈（StatusIcon、LoaderCircle）；步骤清单、计划、可视化、定位结果、深度扫描报告不转
const SPINNING_BLOCKS = new Set<Block['type']>(['edit', 'agent', 'task', 'compaction', 'verify', 'wait'])


// 这一轮最后一块已经在显示进度时（过程组在跑、思考中、工具调用在跑），下面不再多一行「进行中…」，免得两个圈一起转（第 496 步）。
// 运行中的过程组标题行一直在转；只有一项时是那一行自己：思考在转，工具调用跑完就不转了
function showsProgress(block: Block | undefined): boolean {
  if (!block || block.type === 'item') return false
  if (block.type === 'process') return block.items.length > 1 || block.items[0]?.kind === 'thought' || isRunning(block.items[0])
  if (block.type === 'checks') return block.items.some(isRunning)
  return SPINNING_BLOCKS.has(block.type) && isRunning(block.item)
}

// 模型接口出错时怎么说；auth、not-found 要去设置里改，其余可以接着发或者换个模型
const MODEL_ERROR_TEXT: Record<ModelErrorKind, string> = {
  auth: '模型的密钥无效或没有权限，这一轮停在这里',
  'not-found': '找不到这个模型或接口地址，这一轮停在这里',
  unsupported: '模型不支持这类请求，这一轮停在这里',
  'rate-limit': '请求太多或额度用完了，这一轮停在这里',
  server: '模型服务出错，这一轮停在这里',
  timeout: '模型请求超时，这一轮停在这里',
  network: '连不上模型服务，这一轮停在这里',
  unknown: '模型调用失败，这一轮停在这里',
}

type StopAction = 'continue' | 'switch-model' | 'compact' | 'settings' | 'diagnose'

// 一轮不正常停下时的一句话原因和下一步（第一个是主按钮）；正常结束、主动暂停等待时没有
export function stopSummary(turn: Turn): { text: string; actions: StopAction[] } | null {
  const stop = turn.outcome?.stop ?? null
  if (turn.stopReason === 'cancelled' || stop === 'cancelled') {
    const [, stalled] = Object.entries(turn.silence).sort(([, a], [, b]) => a.since - b.since)[0] ?? []
    if (stalled && turn.endedAt) {
      const who = stalled.agent ? `子智能体「${stalled.agent}」的模型` : '模型'
      return { text: `${who}已 ${formatDuration(turn.endedAt - stalled.since)}没有输出，你停止了这一轮`, actions: ['switch-model', 'continue'] }
    }
    return { text: '你停止了这一轮', actions: ['continue', 'diagnose'] }
  }
  if (stop === 'model-error') {
    const kind = turn.outcome?.errorKind ?? 'unknown'
    return { text: MODEL_ERROR_TEXT[kind], actions: kind === 'auth' || kind === 'not-found' ? ['settings', 'switch-model'] : ['continue', 'switch-model'] }
  }
  // 外接智能体出错：原因在它报的错里（下面的提示卡片有它最后的输出）；没装、没登录要去设置或终端里处理
  if (stop === 'agent-error') {
    const failure = turn.outcome?.agentError
    return { text: failure ? `${failure.message}，这一轮停在这里` : '外接智能体出错，这一轮停在这里', actions: failure?.kind === 'not-installed' || failure?.kind === 'version' ? ['settings', 'continue'] : ['continue'] }
  }
  if (stop === 'context-limit' || turn.stopReason === 'max_tokens') return { text: '上下文快用完了，这一轮停在这里', actions: ['compact', 'continue'] }
  if (stop === 'step-limit' || turn.stopReason === 'max_turn_requests') return { text: '达到了单次任务的步数上限，这一轮停在这里', actions: ['continue', 'diagnose'] }
  if (stop === 'check-exhausted') return { text: '快速检查一直没修好，这一轮停在这里', actions: ['diagnose', 'continue'] }
  if (stop === 'gate-exhausted') return { text: '完成检查一直没通过，这一轮停在这里', actions: ['diagnose', 'continue'] }
  if (stop === 'stuck') return { text: '一直在重复同样的操作，这一轮停在这里', actions: ['diagnose', 'continue'] }
  if (stop === 'no-finish') return { text: '改了文件，但没有走完完成检查', actions: ['diagnose', 'continue'] }
  if (stop === 'goal-exhausted') return { text: '目标模式的轮数用完了', actions: ['continue', 'diagnose'] }
  if (turn.stopReason === 'refusal') return { text: '模型拒绝了这个任务', actions: ['switch-model'] }
  return null
}

const CHECK_PREFIXES = ['快速检查：', '完成检查：']

// 旧会话里存的是改名前的标题，显示时统一成监控面板的叫法
const SECURITY_TITLES = new Map([
  ['静态检查', '静态检查'],
  ['轻量扫描', '轻量扫描'],
  ['安全检查', '静态检查'],
  ['安全扫描', '轻量扫描'],
])

function toolBlockType(item: ToolItem): 'edit' | 'check' | 'review' | 'architecture' | 'security' | 'deep-scan' | 'compaction' | 'plan' | 'finish' | 'verify' | 'agent' | 'diagnosis' | 'visual' | 'photos' | 'mcp-ui' | 'wait' | 'task' | 'steps' | 'candidates' | null {
  if (item.candidates) return 'candidates'
  if (item.photos && !item.parentId) return 'photos'
  if (item.agentCard) return 'agent'
  if (item.diagnosis) return 'diagnosis'
  if (item.visual) return 'visual'
  // MCP 工具带的界面（第 683 步）单独成卡
  if (item.mcpUi && !item.parentId) return 'mcp-ui'
  // 等 CI 这类长时间等待单独一行、默认展开，看得到第几次检查
  if (item.toolKind === 'execute' && item.title.startsWith('等待 ')) return 'wait'
  // 指向别的任务的卡片（发消息、新建、等它做完）单独一行，「打开任务」不收进工具组
  if (item.taskLink) return 'task'
  if (item.title === '完成') return 'finish'
  if (item.title === '验证改动（不结束任务）') return 'verify'
  if (item.title === '计划') return 'plan'
  if (item.title === STEPS_CARD_TITLE) return 'steps'
  if (item.title === '上下文压缩') return 'compaction'
  if (item.title === '深度扫描报告') return 'deep-scan'
  if (item.title === '规范审查') return 'review'
  if (item.title === '架构检查') return 'architecture'
  if (SECURITY_TITLES.has(item.title)) return 'security'
  if (CHECK_PREFIXES.some((prefix) => item.title.startsWith(prefix))) return 'check'
  if (item.content.some((content) => content.type === 'diff')) return 'edit'
  return null
}

// 从 start 开始连着的子智能体卡片
function agentRun(blocks: Block[], start: number): ToolItem[] {
  const run: ToolItem[] = []
  for (let index = start; blocks[index]?.type === 'agent'; index++) run.push((blocks[index] as { item: ToolItem }).item)
  return run
}

const isEdit = (item: ProcessItem): boolean => item.kind === 'tool' && toolBlockType(item) === 'edit'

// 两段回复之间的过程（思考、读文件、搜索、命令、改动）收成一组（第 454 步）：思考不再把组打断，不然每次调用前都先想一下的模型会一行一行铺开。
// 回复、提示、检查、审查、上下文压缩、中途验证、完成、子智能体等单独显示，也把组断开。子智能体自己的工具调用收进它的卡片，不在这里排
function toBlocks(items: TranscriptItem[]): Block[] {
  const blocks: Block[] = []
  const toProcess = (item: ProcessItem) => {
    const last = blocks.at(-1)
    if (last?.type === 'process') last.items.push(item)
    else blocks.push({ type: 'process', id: item.id, items: [item] })
  }
  for (const item of items) {
    if (item.kind === 'thought') {
      toProcess(item)
      continue
    }
    if (item.kind !== 'tool') {
      blocks.push({ type: 'item', item })
      continue
    }
    if (item.parentId) continue
    const type = toolBlockType(item)
    // 结束门禁的结论卡（标题「完成」）不画（第 526 步）：结论看顶栏，检查的结果在检查卡上，改了哪些文件写在这一轮底部。
    // 步骤清单也不画，在输入框上方的步骤条里看（第 542 步）
    if (type === 'finish' || type === 'steps') continue
    if (type === 'check' || type === 'review' || type === 'architecture' || type === 'security') {
      const previous = blocks.at(-1)
      if (previous?.type === 'checks') previous.items.push(item)
      else blocks.push({ type: 'checks', id: item.id, items: [item] })
      continue
    }
    if (type && type !== 'edit') {
      blocks.push({ type, item })
      continue
    }
    toProcess(item)
  }
  return blocks
}

function textOf(item: ToolItem): string {
  return item.content.flatMap((content) => (content.type === 'content' && content.content.type === 'text' ? [content.content.text] : [])).join('\n')
}

// 工具还没跑完时标题是工具名，跑完才换成「执行 pnpm test」这样的说明；read_file 这些旧工具只在旧记录里有
const TOOL_ACTIONS: Record<string, string> = {
  exec_command: '执行',
  write_stdin: '查看命令输出',
  apply_patch: '修改文件',
  view_image: '查看图片',
  read_file: '读取',
  list_files: '列出',
  search: '搜索',
  outline: '大纲',
  edit_file: '编辑',
  run_command: '执行',
}

export function splitTitle(title: string): { action: string; target: string } {
  const action = TOOL_ACTIONS[title]
  if (action) return { action, target: '' }
  const space = title.indexOf(' ')
  return space < 0 ? { action: title, target: '' } : { action: title.slice(0, space), target: title.slice(space + 1) }
}

// 显式写 smooth 不受全局 CSS 的 scroll-behavior 管，开了「减少动态效果」要在这里改成瞬时；每次滚动时读，系统设置可能在运行中改
function scrollBehavior(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}

interface ConversationProps {
  task: LiveTask
  locate: { id: string; at: number } | null
  // 定位结果里点了某一步：滚到对话里那一步
  onLocate(id: string): void
  onRestore(turnId: string): void
  onRegenerate(turnId: string): void
  // 远程会话：只看，不提供作用于本机的操作（见 read-only.ts）
  readOnly?: boolean
  // 远程会话：上面还有 count 轮没取过来。滚到顶继续往上拉（或点顶上那一行）取一页；count 为 0 时说已经是最早的一轮
  earlier?: { count: number; loading: boolean; load(): void }
}

// 滚到顶以后继续往上滚这么多像素算拉到位，开始取更早的轮次；拉的过程中顶上那一行跟着变高
const PULL_THRESHOLD = 64

export function Conversation({ task, locate, onLocate, onRestore, onRegenerate, readOnly = false, earlier }: ConversationProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [pull, setPull] = useState(0)
  const pullTimer = useRef<number | undefined>(undefined)
  // 上一次画完时的第一轮和滚动位置：前面插进更早的轮次后，按多出来的高度把正在看的内容留在原处
  const scrolled = useRef<{ first: string | undefined; height: number; top: number }>({ first: undefined, height: 0, top: 0 })
  // 用户停在底部时，新内容进来就跟着滚；往上翻了就不打扰
  const stickRef = useRef(true)
  // 定位和时间线跳转用的平滑滚动起步那几帧还在底部 80px 内，onScroll 会把贴底改回去，流式输出一到就被拉回底部；滚出这一带之前不改贴底
  const locatingRef = useRef(false)
  // 上一次滚动事件时的位置：往上的位移不会重新打开贴底（第 530 步）
  const lastTopRef = useRef(0)
  // 按着鼠标拖滚动条
  const draggingRef = useRef(false)
  const [atBottom, setAtBottom] = useState(true)
  const [activeTurn, setActiveTurn] = useState<string | null>(null)
  const workIndex = lastWorkIndex(task.turns)
  const { sessionId, project, running, permission, info, progress, modelLabel, modelRef } = task
  const agent = task.agent
  const turnTask = useMemo<TurnTask>(() => ({ sessionId, project, running, permission, info, progress, modelLabel, modelRef, agent }), [sessionId, project, running, permission, info, progress, modelLabel, modelRef, agent])
  // 上层每次都传新的回调；存进 ref、给每一轮一个不变的包装，已经结束的轮次才能跳过重画，调用时也总是最新的回调
  const callbacks = useRef({ onLocate, onRestore, onRegenerate })
  callbacks.current = { onLocate, onRestore, onRegenerate }
  const locateItem = useCallback((id: string) => callbacks.current.onLocate(id), [])
  const restoreTurn = useCallback((turnId: string) => callbacks.current.onRestore(turnId), [])
  const regenerateTurn = useCallback((turnId: string) => callbacks.current.onRegenerate(turnId), [])
  // 回答里的链接和文件引用（第 534、535 步）：远程任务的文件在对方电脑上、也没有内置浏览器，不给
  const remote = useRemoteTask()
  const turns = task.turns
  const answerTarget = useMemo<AnswerTarget | null>(() => {
    if (remote || readOnly) return null
    const changed = new Set(turns.flatMap((turn) => turn.items.flatMap((item) => (item.kind === 'tool' ? item.content.flatMap((content) => (content.type === 'diff' ? [relativePath(content.path, project)] : [])) : []))))
    return { sessionId, project, changed }
  }, [remote, readOnly, turns, sessionId, project])

  // 同名的可视化按出现顺序排成几版（第 668 步）：每张卡片能切到别的版本、和上一版对比
  const visualHistory = useMemo(() => visualHistoryOf(turns), [turns])
  // 开着的插件注册的富块（第 682 步）；远程任务没有
  const pluginBlocks = useSessionPluginBlocks(sessionId, !remote && !readOnly)

  const onScroll = () => {
    const element = scrollRef.current
    if (!element) return
    scrolled.current = { first: task.turns[0]?.id, height: element.scrollHeight, top: element.scrollTop }
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    const movedUp = element.scrollTop < lastTopRef.current
    lastTopRef.current = element.scrollTop
    if (distance >= 80) locatingRef.current = false
    // 往上滚时只会停掉贴底：滚轮往上的平滑滚动前几帧还在底部这一带，以前在这里又打开贴底，下一段输出一到就被拉回底部（第 530 步）。
    // 内容变矮时浏览器把位置往上挪，也是往上的位移，这时离底部还近，照常跟随
    if (movedUp) {
      if (distance >= 80 || draggingRef.current) stickRef.current = false
    } else if (!locatingRef.current) stickRef.current = distance < 80
    setAtBottom(distance < 200)
    let current: string | null = null
    for (const turn of task.turns) {
      const node = element.querySelector<HTMLElement>(`[data-turn-id="${turn.id}"]`)
      if (node && node.offsetTop <= element.scrollTop + 80) current = turn.id
    }
    setActiveTurn(current ?? task.turns[0]?.id ?? null)
  }

  // 往前取了一页：浏览器的滚动锚定在滚到顶时不起作用，自己按多出来的高度往下挪；每次画完记下位置
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const previous = scrolled.current
    const first = task.turns[0]?.id
    if (previous.first && first !== previous.first && task.turns.some((turn) => turn.id === previous.first)) element.scrollTop = previous.top + element.scrollHeight - previous.height
    scrolled.current = { first, height: element.scrollHeight, top: element.scrollTop }
  })

  // 用户往上翻（滚轮、键盘）：马上停掉贴底，不等滚动事件
  const leaveBottom = () => {
    stickRef.current = false
    locatingRef.current = false
  }
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') leaveBottom()
  }

  // 滚到顶以后还在往上滚：顶上那一行跟着拉高，拉够了取更早的一页；停下一会儿就弹回去
  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) leaveBottom()
    const element = scrollRef.current
    if (!element || !earlier || earlier.count === 0 || earlier.loading) return
    if (element.scrollTop > 0 || event.deltaY >= 0) {
      if (pull > 0) setPull(0)
      return
    }
    window.clearTimeout(pullTimer.current)
    const next = pull - event.deltaY * (event.deltaMode === 1 ? 16 : 1) * 0.5
    if (next >= PULL_THRESHOLD) {
      setPull(0)
      earlier.load()
      return
    }
    setPull(next)
    pullTimer.current = window.setTimeout(() => setPull(0), 400)
  }
  useEffect(() => () => window.clearTimeout(pullTimer.current), [])

  // 不跟随时内容在下面长高没有滚动事件，「回到底部」在这里也重算
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    if (stickRef.current) element.scrollTop = element.scrollHeight
    setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 200)
  }, [task.turns, task.permission])

  // 切到这个任务时滚到底
  useEffect(() => {
    stickRef.current = true
    const element = scrollRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [task.sessionId])

  // 下面的排队提示、输入框变高会把对话区压矮，贴底时跟着滚；不贴底时压矮也没有滚动事件，重算「回到底部」。
  // 内容列也观察：展开工具组、编辑详情时内容长高同样没有滚动事件，只重算「回到底部」，不滚，免得把刚展开的内容推出视口
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      if (stickRef.current && entries.some((entry) => entry.target === element)) element.scrollTop = element.scrollHeight
      setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 200)
    })
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    return () => observer.disconnect()
  }, [])

  // 任务监控点了失败的命令：滚到那一行，焦点跟过去。不用 scrollIntoView，它会连带滚动 overflow-hidden 的外壳
  useEffect(() => {
    const element = scrollRef.current
    if (!locate || !element) return
    const id = CSS.escape(locate.id)
    // 那一行在收起的过程组里时，组已经跟着 locate 展开了（见 ProcessGroup）；在收着的子智能体卡片里时这一行不在 DOM 里，退到卡片
    const target = element.querySelector<HTMLElement>(`[data-item-id="${id}"]`) ?? element.querySelector<HTMLElement>(`[data-item-ids~="${id}"]`)
    const row = target?.firstElementChild
    if (!target || !(row instanceof HTMLElement)) return
    stickRef.current = false
    const top = element.scrollTop + row.getBoundingClientRect().top - element.getBoundingClientRect().top - element.clientHeight / 3
    // 只拦从底部这一带滚出去的情况；终点也在这一带时不拦，否则停下后 onScroll 一直不改贴底，滚回底部也恢复不了跟随
    const bottom = element.scrollHeight - element.clientHeight
    locatingRef.current = bottom - element.scrollTop < 80 && bottom - Math.max(top, 0) >= 80
    element.scrollTo({ top, behavior: scrollBehavior() })
    const focusTarget = row instanceof HTMLButtonElement ? row : target
    focusTarget.focus({ preventScroll: true })
    row.animate([{ backgroundColor: 'var(--accent)' }, { backgroundColor: 'transparent' }], { duration: 1500, easing: 'ease-out' })
  }, [locate])

  const scrollToBottom = () => {
    const element = scrollRef.current
    if (!element) return
    // 先打开贴底：滚动事件到之前进来的新内容也要跟上，不等 onScroll 判断
    stickRef.current = true
    locatingRef.current = false
    element.scrollTo({ top: element.scrollHeight, behavior: scrollBehavior() })
  }

  const scrollToTurn = (turnId: string) => {
    const element = scrollRef.current
    const node = element?.querySelector<HTMLElement>(`[data-turn-id="${turnId}"]`)
    if (!element || !node) return
    const top = node.offsetTop - 16
    const bottom = element.scrollHeight - element.clientHeight
    // 要滚出底部这一带才停掉贴底；终点就在这一带（比如这一轮开头已在视口里、滚不动）时照常跟随，否则没有滚动事件，贴底一直关着，也不出「回到底部」
    if (bottom - Math.max(top, 0) >= 80) {
      stickRef.current = false
      locatingRef.current = bottom - element.scrollTop < 80
    } else {
      // 上一次跳转刚起步时又点了这里：清掉它留下的 locatingRef，不然回到底部这一带后贴底也打不开
      stickRef.current = true
      locatingRef.current = false
    }
    element.scrollTo({ top, behavior: scrollBehavior() })
  }

  return (
    <ReadOnlyContext.Provider value={readOnly}>
    <AnswerContext.Provider value={answerTarget}>
    <VisualHistoryContext.Provider value={visualHistory}>
    <PluginBlocksContext.Provider value={pluginBlocks}>
    <div className="relative min-h-0 flex-1">
      {/* 两侧都预留滚动条槽位，内容列无论是否滚动都居中，与下方输入框对齐；底部 24px 渐隐，pb-8 让贴底时最后一行落在渐隐区外 */}
      <div
        ref={scrollRef}
        data-conversation-scroll=""
        onScroll={onScroll}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        // 按在滚动容器本身上（滚动条、两侧留白）才算拖滚动条；在窗口里哪里松手都算
        onPointerDown={(event) => {
          if (event.target !== event.currentTarget) return
          draggingRef.current = true
          window.addEventListener('pointerup', () => (draggingRef.current = false), { once: true })
        }}
        className={cn(
          'h-full overflow-y-auto px-8 pt-6 pb-8 [scrollbar-gutter:stable_both-edges] [mask-image:linear-gradient(to_bottom,black_calc(100%_-_24px),transparent)]',
          // 往前插内容时自己挪位置（见上面），不让浏览器的滚动锚定再挪一次
          earlier && '[overflow-anchor:none]',
        )}
      >
        <div className="mx-auto flex min-h-full max-w-(--content-max) flex-col gap-7">
          {earlier && <EarlierRow earlier={earlier} pull={pull} />}
          {task.turns.length === 0 && (
            <EmptyState icon={MessageSquare} title="描述你要做的事" description="比如「修复登录页的报错」或「给 utils 加单元测试」。" variant="plain" className="my-auto" />
          )}
          {task.turns.map((turn, index) => {
            const last = index === task.turns.length - 1
            return (
              <TurnView
                key={turn.id}
                turn={turn}
                task={turnTask}
                active={task.running && last}
                last={last}
                // 远程会话往前翻页时自己挪滚动位置、关了滚动锚定，按需渲染的轮次一画出来高度就变，看着的位置会跳，不开
                deferred={!last && !earlier}
                latestWork={index === workIndex}
                // 只传给那一步所在的轮次，别的轮次 props 不变、不用重画
                locate={locate && turn.items.some((item) => item.id === locate.id) ? locate : null}
                onLocate={locateItem}
                onRestore={restoreTurn}
                onRegenerate={regenerateTurn}
              />
            )
          })}
          {!readOnly && <TodoAcceptanceCard task={task} />}
        </div>
      </div>
      <SelectionAsk root={scrollRef} />
      <ConversationSearch root={scrollRef} version={task.turns} />
      {task.turns.length > 1 && <Timeline turns={task.turns} activeTurn={activeTurn ?? task.turns.at(-1)?.id ?? null} onJump={scrollToTurn} />}
      {!atBottom && (
        <Button variant="outline" size="icon" aria-label="回到底部" className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full shadow-overlay" onClick={scrollToBottom}>
          <ArrowDown />
        </Button>
      )}
    </div>
    </PluginBlocksContext.Provider>
    </VisualHistoryContext.Provider>
    </AnswerContext.Provider>
    </ReadOnlyContext.Provider>
  )
}

// 并排对比：正在看的那一次（看的是现在这一次时，取它前面最近的一次）和现在这一次
function CompareVersions({ versions, current, viewing }: { versions: NonNullable<Turn['versions']>; current: Turn; viewing: number | null }) {
  const order = versionOrder(versions, current)
  const now = order.indexOf(null)
  const other = viewing ?? order[now - 1] ?? order[now + 1] ?? 0
  return <VersionCompare older={versions[other]!.turn} olderLabel={`第 ${order.indexOf(other) + 1} 次`} current={current} currentLabel={`第 ${now + 1} 次（现在）`} />
}

function visualHistoryOf(turns: Turn[]): Map<string, VisualVersion[]> {
  const history = new Map<string, VisualVersion[]>()
  for (const turn of turns) for (const item of turn.items) if (item.kind === 'tool' && item.visual) history.set(item.visual.title, [...(history.get(item.visual.title) ?? []), { id: item.id, code: item.visual.code, snapshot: item.visualSnapshot }])
  return history
}

const noop = () => undefined

// 静态渲染用（第 671 步）：这几轮按只读会话的样子、用同一套组件画；没有滚动、时间线和操作栏。
// projectImages：回答里项目的图片读进来（本机任务的导出）；分享版、远程任务不读
export function StaticTurns({ task, turns, projectImages }: { task: TurnTask; turns: Turn[]; projectImages: boolean }) {
  const visualHistory = useMemo(() => visualHistoryOf(turns), [turns])
  const turnTask = useMemo<TurnTask>(() => ({ ...task, running: false, permission: null }), [task])
  const pluginBlocks = useSessionPluginBlocks(task.sessionId, true)
  return (
    <ReadOnlyContext.Provider value={true}>
      <StaticProjectContext.Provider value={projectImages ? task.project : null}>
        <VisualHistoryContext.Provider value={visualHistory}>
          <PluginBlocksContext.Provider value={pluginBlocks}>
            {turns.map((turn, index) => (
              <TurnView key={turn.id} turn={turn} task={turnTask} active={false} last={index === turns.length - 1} latestWork={false} locate={null} onLocate={noop} onRestore={noop} onRegenerate={noop} />
            ))}
          </PluginBlocksContext.Provider>
        </VisualHistoryContext.Provider>
      </StaticProjectContext.Provider>
    </ReadOnlyContext.Provider>
  )
}

// 导出文件的标题：这一轮提问的第一行
export function turnTitle(turn: Turn): string {
  const line = turn.prompt.trim().split('\n')[0]?.trim() ?? ''
  return (line.length > 60 ? `${line.slice(0, 60)}…` : line) || 'Diffra 对话'
}

// 远程会话顶上那一行：还有更早的轮次时说上拉或点这里取，拉的时候跟着变高
function EarlierRow({ earlier, pull }: { earlier: NonNullable<ConversationProps['earlier']>; pull: number }) {
  if (earlier.count === 0) return <p className="text-center text-xs text-muted-foreground" data-testid="load-earlier">已经是最早的一轮</p>
  return (
    // 不加过渡：加载完那一刻要按此时的高度把正在看的位置留住，内边距还在动画里就会算偏
    <div className="flex justify-center" style={{ paddingTop: pull }}>
      <button type="button" className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:hover:text-muted-foreground" disabled={earlier.loading} onClick={earlier.load} data-testid="load-earlier">
        {earlier.loading && <LoaderCircle className="size-3 animate-spin" />}
        {earlier.loading ? '正在加载更早的…' : pull > 0 ? `继续上拉，加载更早的 ${earlier.count} 轮` : `上拉或点这里，加载更早的 ${earlier.count} 轮`}
      </button>
    </div>
  )
}

// 每一轮用到的任务字段。只传这些（不传整个任务），流式输出时已经结束的轮次 props 不变，不用重画：
// 长任务里每来一条更新就重画全部轮次，界面会卡住几十秒
type TurnTask = Pick<LiveTask, 'sessionId' | 'project' | 'running' | 'permission' | 'info' | 'progress' | 'modelLabel' | 'modelRef' | 'agent'>

interface TurnViewProps {
  turn: Turn
  task: TurnTask
  active: boolean
  last: boolean
  // 最后一个执行轮（后面只跟着定位轮时仍算）：停下说明的按钮、重新生成、子智能体卡片的「定位问题」都在它上面
  latestWork: boolean
  // 长会话按需渲染（第 672 步）：不在视口附近时跳过排版和绘制
  deferred?: boolean
  // 要滚到这一轮里的哪一步（任务监控、定位结果点的），不在这一轮时是 null
  locate: ConversationProps['locate']
  onLocate(id: string): void
  onRestore(turnId: string): void
  onRegenerate(turnId: string): void
}

// 最后一个执行轮的下标；后面跟着别的轮次（出计划、压缩、深度扫描）时没有
export function lastWorkIndex(turns: Turn[]): number {
  for (let index = turns.length - 1; index >= 0; index--) {
    const kind = turns[index]!.kind
    if (kind === 'prompt' || kind === 'goal') return index
    if (kind !== 'diagnose') return -1
  }
  return -1
}

const TurnView = memo(function TurnView({ turn, task, active, last, deferred = false, latestWork, locate, onLocate, onRestore: restoreTurn, onRegenerate: regenerateTurn }: TurnViewProps) {
  const onRestore = useCallback(() => restoreTurn(turn.id), [restoreTurn, turn.id])
  const onRegenerate = useCallback(() => regenerateTurn(turn.id), [regenerateTurn, turn.id])
  // 重新生成过的一轮（第 676 步）：正在看哪一次（versions 里的位置，null 是现在这一次）、是不是在并排对比
  const versions = turn.versions ?? []
  const [viewing, setViewing] = useState<number | null>(null)
  const [comparing, setComparing] = useState(false)
  const [confirmingUse, setConfirmingUse] = useState(false)
  const viewed = viewing !== null ? versions[viewing]?.turn : undefined
  // 时间轴回放（第 681 步）：显示到第几步，null 是没在回放
  const [replay, setReplay] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  // 对话地图（第 691 步）：这一轮的步骤、文件、图表和要你定的地方，点了滚过去
  const [showMap, setShowMap] = useState(false)
  const sectionRef = useRef<HTMLElement>(null)
  const shownItems = viewed?.items ?? turn.items
  const items = useMemo(() => (replay === null ? shownItems : shownItems.slice(0, replay)), [shownItems, replay])
  // 等待确认的那一步由输入框上方的确认卡片代表，这里不再画一条转圈的待执行行
  const pendingToolId = active && task.permission ? task.permission.toolCall.toolCallId : null
  const blocks = useMemo(() => toBlocks(pendingToolId ? items.filter((item) => item.id !== pendingToolId) : items), [items, pendingToolId])
  const [showEditDetails, setShowEditDetails] = useState(false)
  // 远程会话：对方正在跑的这一轮带的图片跑完才过来；超出额度、对方压不了的只有张数
  const imageNote = turn.pendingImages ? `（带了 ${turn.pendingImages} 张图片，这一轮跑完后显示）` : turn.omittedImages ? `（${turn.omittedImages} 张图片没有同步过来）` : null
  // 这一轮每次改动前后的全文（改动卡片只带变化的那段，按顺序重放还原），算改了哪些文件、净增删多少行
  const edits = useMemo(() => replayEdits(items), [items])
  // 每张子智能体卡片里的工具调用，按发生顺序
  const agentSteps = useMemo(() => {
    const steps = new Map<string, ToolItem[]>()
    for (const item of items) {
      if (item.kind !== 'tool' || !item.parentId) continue
      steps.set(item.parentId, [...(steps.get(item.parentId) ?? []), item])
    }
    return steps
  }, [items])
  // 整轮的「展开代码详情」只挂在第一个有改动的过程组上，一轮里不会出现两个同名按钮
  const editToggleId = blocks.flatMap((block) => (block.type === 'process' && block.items.some(isEdit) ? [block.id] : []))[0]
  // 这一轮改了哪些文件、净增删多少行：写在这一轮底部，点开审阅（第 526 步起不再有完成卡）
  // 改了哪些文件总是说现在这一次（看着重新生成之前的那一次时 edits 是那一次的）
  const currentEdits = useMemo(() => (viewed ? replayEdits(turn.items) : edits), [viewed, turn.items, edits])
  const turnFiles = useMemo(() => filesOf(turn.items, currentEdits), [turn.items, currentEdits])
  const showFiles = turnFiles.length > 0 && !turn.restoredAt
  const openReview = () => store.set((state) => ({ ...state, panel: 'review' }))
  // 本轮报告（第 661 步）：点了才拼，执行轮跑完才有
  const [showReport, setShowReport] = useState(false)
  const canReport = !active && (turn.kind === 'prompt' || turn.kind === 'goal')
  const report = useMemo(() => (showReport && canReport ? turnReport(turn, turnFiles, task.project) : null), [showReport, canReport, turn, turnFiles, task.project])
  const readOnly = useReadOnly()
  const isStatic = useStatic()
  // 远程任务页只读（作用于本机的按钮都不显示），但对方开放了「可查看和操作」时撤销、重新生成经对方做
  const remote = useRemoteTask()
  // 外接智能体的对话在它自己那边，撤不回去，不能重新生成
  const canRegenerate = latestWork && !task.agent && (!readOnly || Boolean(remote?.regenerate))
  // 定位轮不改文件、没有检查点
  const canRestore = (!readOnly || Boolean(remote?.restore)) && task.info.checkpoints && turn.kind !== 'compact' && turn.kind !== 'diagnose'

  const answerText = useMemo(() => turn.items.flatMap((item) => (item.kind === 'agent' ? [item.text] : [])).join('\n\n'), [turn.items])
  const copy = () => {
    navigator.clipboard.writeText(answerText).then(
      () => showToast('已复制回复'),
      (error: unknown) => console.error('复制失败', error),
    )
  }

  return (
    // 按需渲染用 content-visibility：内容还在 DOM 里，页面内搜索、定位、复制照常；auto 记住画过一次的高度，滚动条不来回跳
    <section ref={sectionRef} data-testid="turn" data-turn-id={turn.id} className={cn('group/turn flex flex-col gap-3.5', deferred && '[contain-intrinsic-size:auto_480px] [content-visibility:auto]')}>
      {turn.from && <TaskLink source={turn.from} label="来自任务" className="self-end" />}
      {turn.remote && <RemoteSourceTag source={turn.remote} />}
      {blocks.map((block, index) => {
        // 并排对比时只留提问，回答换成对比
        if (comparing && versions.length > 0 && !(block.type === 'item' && block.item.kind === 'user')) return null
        switch (block.type) {
          case 'item': {
            const view = <ItemView key={block.item.id} item={block.item} goal={turn.kind === 'goal'} skills={turn.skills} images={turn.images} imageNote={imageNote} streaming={active && index === blocks.length - 1} />
            const mapPanel = showMap && !isStatic && <TurnMap items={shownItems} files={turnFiles} root={sectionRef} cardOf={toolBlockType} onLocate={onLocate} onClose={() => setShowMap(false)} />
            if (block.item.kind !== 'user' || isStatic || active || (versions.length === 0 && replay === null && !mapPanel)) return view
            const replayBar = replay !== null && (
              <TurnReplay
                items={shownItems}
                step={replay}
                onStep={setReplay}
                playing={playing}
                onPlaying={setPlaying}
                onClose={() => {
                  setPlaying(false)
                  setReplay(null)
                }}
              />
            )
            if (versions.length === 0) return <Fragment key={block.item.id}>{view}{replayBar}{mapPanel}</Fragment>
            return (
              <Fragment key={block.item.id}>
                {view}
                {replayBar}
                {mapPanel}
                <TurnVersions
                  versions={versions}
                  current={turn}
                  viewing={viewing}
                  onView={(next) => {
                    setViewing(next)
                    setConfirmingUse(false)
                  }}
                  comparing={comparing}
                  onCompare={setComparing}
                  canUse={last && !task.running && !readOnly && !remote}
                  currentFiles={turnFiles.length}
                  onUse={(position) => void switchTurnVersion(task.sessionId, turn.id, position).then(() => (setViewing(null), setConfirmingUse(false)))}
                  confirming={confirmingUse}
                  onConfirm={setConfirmingUse}
                />
                {comparing && <CompareVersions versions={versions} current={turn} viewing={viewing} />}
              </Fragment>
            )
          }
          case 'process':
            return (
              <ProcessGroup
                key={block.id}
                items={block.items}
                edits={edits}
                projectPath={task.project}
                live={active && index === blocks.length - 1}
                locate={locate}
                showEditDetails={showEditDetails}
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
            return <PlanCard key={block.item.id} item={block.item} request={turn.prompt} task={task} planTurnId={turn.id} />
          case 'candidates':
            return block.item.candidates ? <CandidatesCard key={block.item.id} run={block.item.candidates} sessionId={task.sessionId} running={task.running} /> : null
          case 'verify':
            // 中途验证不改变本轮结论，通过也不画绿色；没配检查命令时提醒并默认展开，之后撤销过就不再提醒
            return <ToolStep key={block.item.id} item={block.item} unverified={!turn.restoredAt && finishVerdict(block.item).tone === 'unverified'} />
          case 'agent': {
            // 连着派出的几个子智能体：第一张卡片上面画一行组织图
            const team = blocks[index - 1]?.type === 'agent' ? [] : agentRun(blocks, index)
            return (
              <Fragment key={block.item.id}>
                {team.length > 1 && <AgentTeam items={team} onJump={onLocate} />}
              <AgentCard
                item={block.item}
                steps={agentSteps.get(block.item.id) ?? []}
                projectPath={task.project}
                onDiagnose={!readOnly && latestWork && !task.running && block.item.status === 'failed' ? () => void diagnose(task.sessionId, { turnId: turn.id, cardId: block.item.id, agent: block.item.agentCard!.name }) : undefined}
              />
              </Fragment>
            )
          }
          case 'diagnosis':
            return <DiagnosisCard key={block.item.id} item={block.item} task={task} onLocate={onLocate} />
          case 'wait':
            return <ToolStep key={block.item.id} item={block.item} defaultOpen />
          case 'task':
            return <ToolStep key={block.item.id} item={block.item} />
          case 'mcp-ui':
            return <McpAppCard key={block.item.id} ui={block.item.mcpUi!} sessionId={task.sessionId} />
          case 'visual':
            return <VisualCard key={block.item.id} id={block.item.id} title={block.item.visual!.title} code={block.item.visual!.code} sessionId={task.sessionId} snapshot={block.item.visualSnapshot} />
          case 'photos':
            return <PhotosCard key={block.item.id} title={block.item.title} photos={block.item.photos!} />
        }
      })}
      {active && task.permission && <PermissionPending toolCall={task.permission.toolCall} />}
      {active && !task.permission && !showsProgress(blocks.at(-1)) && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          进行中…
        </p>
      )}
      {active && <ModelSilenceHint turn={turn} sessionId={task.sessionId} agent={task.agent?.name} />}
      {!active && <StopSummary turn={turn} task={task} actionable={!readOnly && latestWork && !task.running} />}
      {turn.error && (
        <CardShell
          tone="danger"
          role="alert"
          data-testid="turn-error"
          icon={<CircleAlert className="size-4 shrink-0 text-destructive" />}
          title="这一轮出错了"
          titleClassName="text-destructive"
          copy={{ label: '复制错误', text: () => turn.error ?? '' }}
        >
          <p className="leading-relaxed break-words whitespace-pre-wrap">{turn.error}</p>
          {canRegenerate && (
            <Button variant="outline" size="sm" className="self-start" disabled={task.running} onClick={onRegenerate}>
              重试
            </Button>
          )}
        </CardShell>
      )}
      {/* 只有最后一轮的操作栏常驻，其余轮悬停或键盘聚焦时才出现；用透明度隐藏，不占用也不改变布局 */}
      {!active && !isStatic && viewing === null && !comparing && replay === null && (
        <div
          className={cn('flex items-center gap-1 text-muted-foreground transition-opacity', !last && 'opacity-0 group-hover/turn:opacity-100 focus-within:opacity-100')}
          data-testid="turn-actions"
        >
          <ActionButton label="复制回复" onClick={copy}>
            <Copy className="size-4" />
          </ActionButton>
          <SpeakButton id={turn.id} text={answerText} />
          {turn.items.length > 2 && (
            <ActionButton label="回放这一轮" onClick={() => setReplay(1)}>
              <History className="size-4" />
            </ActionButton>
          )}
          {turn.items.length > 1 && (
            <ActionButton label={showMap ? '收起这一轮的地图' : '这一轮的地图'} onClick={() => setShowMap(!showMap)}>
              <MapIcon className="size-4" />
            </ActionButton>
          )}
          {/* 出错卡片里已经有「重试」，同一个动作不再放第二个按钮 */}
          {canRegenerate && !turn.error && (
            <ActionButton label="重新生成" disabled={task.running} onClick={onRegenerate}>
              <RefreshCw className="size-4" />
            </ActionButton>
          )}
          {canReport && (
            <ActionButton label={showReport ? '收起本轮报告' : '本轮报告'} onClick={() => setShowReport(!showReport)}>
              <FileText className="size-4" />
            </ActionButton>
          )}
          {/* 导出这一轮（第 671、678 步）：Markdown、HTML、PDF、图片 */}
          <ExportMenu shareable={!remote} onExport={(format) => void exportTurns(format, turnTitle(turn), [turn], (turns, shared) => <StaticTurns task={task} turns={turns} projectImages={!shared && !remote} />, { sessionId: task.sessionId, turnIds: [turn.id] })}>
            <Button variant="ghost" size="icon-sm" aria-label="导出这一轮" title="导出这一轮">
              <Download className="size-4" />
            </Button>
          </ExportMenu>
          {canRestore && (
            <>
              <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
              <ActionButton label="撤销这一轮及之后的改动" disabled={task.running} onClick={onRestore}>
                <Undo2 className="size-4" />
              </ActionButton>
            </>
          )}
          {showFiles && (
            <button
              type="button"
              aria-label={`审阅这一轮改的 ${turnFiles.length} 个文件`}
              className="ml-auto flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs tabular-nums hover:bg-accent hover:text-foreground"
              data-testid="turn-files"
              onClick={openReview}
            >
              {turnFiles.length} 个文件{' '}
              <DiffCounts added={turnFiles.reduce((total, file) => total + file.added, 0)} removed={turnFiles.reduce((total, file) => total + file.removed, 0)} />
            </button>
          )}
          {turn.startedAt && turn.endedAt && <span className={cn('text-xs tabular-nums', !showFiles && 'ml-auto')}>用时 {formatDuration(turn.endedAt - turn.startedAt)}</span>}
        </div>
      )}
      {report && <TurnReport data={report} />}
    </section>
  )
})

function PermissionPending({ toolCall }: { toolCall: PermissionRequestEvent['toolCall'] }) {
  const input = toolCall.rawInput
  const command = typeof input === 'object' && input !== null && 'command' in input && typeof input.command === 'string' ? input.command : null
  const target = command ?? toolCall.title ?? ''
  return (
    <div data-testid="permission-pending">
      <DisclosureRow className="text-foreground">
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          <span className="size-2 rounded-full border-2 border-foreground" />
        </span>
        <span className="shrink-0 text-muted-foreground">等待确认</span>
        {target && <span className="min-w-0 truncate rounded-sm bg-muted px-1.5 py-px font-mono text-xs">{target}</span>}
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
// imageNote：远程会话里还没过来、没同步的图片说明；streaming：这段回复还在流式输出（富块没写完时先占位）
function ItemView({ item, goal, skills, images, imageNote, streaming }: { item: Exclude<TranscriptItem, ProcessItem>; goal: boolean; skills: string[]; images: PromptImage[]; imageNote: string | null; streaming: boolean }) {
  const promptImages = useMemo(() => ({ images, omitted: imageNote !== null }), [images, imageNote])
  switch (item.kind) {
    case 'user':
      if (!goal && skills.length === 0 && images.length === 0 && !imageNote) {
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
          {imageNote && <span className="text-xs text-muted-foreground">{imageNote}</span>}
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
          <PromptImagesContext.Provider value={promptImages}>
            <Markdown text={item.text} streaming={streaming} />
          </PromptImagesContext.Provider>
        </div>
      )
    case 'notice':
      return (
        <CardShell
          data-testid="notice"
          role={item.severity === 'error' ? 'alert' : undefined}
          density="compact"
          tone={item.severity === 'error' ? 'danger' : item.severity === 'warning' ? 'warning' : 'default'}
          title={item.title}
          titleClassName={item.severity === 'error' ? 'text-destructive' : undefined}
        >
          {item.description && <div className="whitespace-pre-wrap text-muted-foreground">{item.description}</div>}
        </CardShell>
      )
  }
}

// 一段思考：一行，和工具调用的行对齐，点开看全文。running 是模型还在想
function Thought({ text, running = false }: { text: string; running?: boolean }) {
  const [open, setOpen] = useState(false)
  const preview = text.trim().split(/\r?\n/)[0] ?? ''
  return (
    <div className="text-sm text-muted-foreground" data-testid="thought">
      <DisclosureRow open={open} onToggle={() => setOpen(!open)} className="hover:text-foreground">
        <StatusIcon status={running ? 'in_progress' : 'completed'} />
        <span className="shrink-0">{running ? '思考中' : '已思考'}</span>
        {preview && !open && <span className="min-w-0 truncate">· {preview}</span>}
      </DisclosureRow>
      {open && <div className="mt-1.5 ml-5 border-l-2 pl-3 leading-relaxed whitespace-pre-wrap">{text}</div>}
    </div>
  )
}

// success-color-allow: 跑完只是过程，默认画中性；只有检查命令通过这类验证结果才传 tone="success"
function StatusIcon({ status, tone = 'muted', className }: { status: string; tone?: 'muted' | 'success'; className?: string }) {
  // success-color-allow: 只有 CheckRow 传 tone="success"，检查命令通过才走到绿色
  if (status === 'completed') return <Check className={cn('size-3.5 shrink-0', tone === 'success' ? 'text-success' : 'text-muted-foreground', className)} strokeWidth={2.6} />
  if (status === 'failed') return <X className={cn('size-3.5 shrink-0 text-destructive', className)} strokeWidth={2.6} />
  return <LoaderCircle className={cn('size-3.5 shrink-0 animate-spin text-muted-foreground', className)} />
}

interface ProcessGroupProps {
  items: ProcessItem[]
  edits: Map<string, EditTexts>
  projectPath: string
  // 这一轮还在跑，而且这是最后一块：模型正在这一组里干活
  live: boolean
  locate: ConversationProps['locate']
  // 这一轮的改动要不要都展开代码
  showEditDetails: boolean
  toggle?: React.ReactNode
}

// 两段回复之间的过程：默认收起，运行中也不自动展开，标题行说做了几次、改了几个文件、正在做什么；有失败的命令也只在标题上标出来（第 455 步）。
// 任务监控、定位结果要滚到组里的某一步时跟着展开（第 457 步）。只有一项时不套这层。
// 收起时各项仍留在 DOM 里（hidden），按 data-kind 数卡片的地方不受影响
function ProcessGroup({ items, edits, projectPath, live, locate, showEditDetails, toggle }: ProcessGroupProps) {
  const [open, setOpen] = useState(false)
  // locate 变了就在这次渲染里展开，这样外层的定位 effect 量位置时那一行已经显示出来了
  const [seenLocate, setSeenLocate] = useState(locate)
  if (locate !== seenLocate) {
    setSeenLocate(locate)
    if (locate && items.some((item) => item.id === locate.id)) setOpen(true)
  }
  const files = useMemo(() => filesOf(items.filter(isEdit), edits), [items, edits])
  const last = items.at(-1)
  const step = (item: ProcessItem, single: boolean) => {
    if (item.kind === 'thought') return <Thought key={item.id} text={item.text} running={live && item === last} />
    if (!isEdit(item)) return <ToolStep key={item.id} item={item} />
    return <EditBlock key={item.id} item={item} projectPath={projectPath} expanded={showEditDetails} toggle={single ? toggle : undefined} />
  }
  // 只有一步时不套组；是浏览器操作就在下面带上截图和网址（第 662 步）
  if (items.length === 1 && last) {
    if (!isBrowserStep(last)) return step(last, true)
    return (
      <div className="flex flex-col gap-1.5">
        {step(last, true)}
        <BrowserSummary items={[last]} />
      </div>
    )
  }
  const tools = items.filter((item): item is ToolItem => item.kind === 'tool')
  const running = tools.find((item) => item.status !== 'completed' && item.status !== 'failed')
  const failed = tools.filter((item) => item.status === 'failed').length
  const commandsFailed = tools.filter((item) => item.succeeded === false).length
  const current = running ? splitTitle(running.title) : null
  const activity = current ? `${current.action}${current.target ? ` ${current.target}` : ''}` : live && last?.kind === 'thought' ? '思考中' : null
  return (
    <div className="flex flex-col gap-1.5" data-testid="tool-group" data-item-ids={items.map((item) => item.id).join(' ')}>
      <div className="flex items-center gap-2">
        <DisclosureRow open={open} onToggle={() => setOpen(!open)} className="text-muted-foreground hover:text-foreground">
          <StatusIcon status={running || live ? 'in_progress' : failed > 0 ? 'failed' : 'completed'} />
          <span className="shrink-0">
            {tools.length > 0 ? `执行工具 ${tools.length} 次` : '思考'}
            {failed > 0 ? ` · ${failed} 次失败` : ''}
            {commandsFailed > 0 ? ` · ${commandsFailed} 条命令失败` : ''}
          </span>
          {files.length > 0 && (
            <>
              <span className="shrink-0">· 修改 {files.length} 个文件</span>
              <DiffCounts added={files.reduce((total, file) => total + file.added, 0)} removed={files.reduce((total, file) => total + file.removed, 0)} />
            </>
          )}
          {activity && (
            <span className="min-w-0 truncate" data-testid="tool-group-activity">
              · {activity}
            </span>
          )}
        </DisclosureRow>
        {toggle && open && <span className="ml-auto flex pr-1">{toggle}</span>}
      </div>
      <BrowserSummary items={tools} />
      <div hidden={!open} className="flex flex-col gap-0.5 pl-5">
        {items.map((item) => step(item, false))}
      </div>
    </div>
  )
}

function ToolStep({ item, unverified = false, defaultOpen = false }: { item: ToolItem; unverified?: boolean; defaultOpen?: boolean }) {
  // 命令失败的结果是跑完之后才到的，所以默认展开要跟着 item 算，不能只在挂载时定
  const [open, setOpen] = useState<boolean | null>(null)
  const commandFailed = item.succeeded === false
  const expanded = open ?? (commandFailed || unverified || defaultOpen)
  const { action, target } = splitTitle(item.title)
  const output = textOf(item)
  const full = useFullOutput(item, expanded)
  const elapsed = useElapsed(item.startedAt, item.status !== 'completed' && item.status !== 'failed')
  return (
    <div className="text-sm" data-testid="tool-call" data-kind="tool" data-status={item.status} data-succeeded={item.succeeded === undefined ? undefined : String(item.succeeded)} data-item-id={item.id} tabIndex={commandFailed && !output ? -1 : undefined}>
      <DisclosureRow open={expanded} onToggle={output ? () => setOpen(!expanded) : undefined} className="text-foreground">
        {unverified ? <CircleAlert className="size-3.5 shrink-0 text-warning" /> : <StatusIcon status={item.status} />}
        <span className="shrink-0 text-muted-foreground">{action}</span>
        {target && <span className="min-w-0 truncate rounded-sm bg-muted px-1.5 py-px font-mono text-xs">{target}</span>}
        {elapsed !== null && <span className="shrink-0 text-xs text-muted-foreground tabular-nums" data-testid="tool-elapsed">{formatDuration(elapsed)}</span>}
      </DisclosureRow>
      {item.taskLink && (
        <div className="mt-1 ml-5">
          <TaskLink source={item.taskLink} label="打开任务" />
        </div>
      )}
      {expanded && output && <ToolOutputView command={item.toolKind === 'execute' && target ? target : null} output={output} durationMs={item.durationMs} />}
      {full.note && <OutputNote note={full.note} retry={full.retry} />}
    </div>
  )
}

// 远程会话里只同步了开头的输出：说明一句，取全文失败时可以重试
function OutputNote({ note, retry }: { note: string; retry: (() => void) | null }) {
  return (
    <p className="mt-1 ml-5 flex items-center gap-2 text-xs text-muted-foreground" data-testid="tool-output-note">
      {note}
      {retry && (
        <button type="button" className="underline-offset-2 hover:text-foreground hover:underline" onClick={retry}>
          重试
        </button>
      )}
    </p>
  )
}

// 配对的远程设备发来的一轮。连接端看对方的会话时，自己发的那几轮显示「本机发的」
function RemoteSourceTag({ source }: { source: RemoteSource }) {
  const self = useAppState((state) => state.remote?.self?.deviceId)
  const name = source.name.length > 20 ? `${source.name.slice(0, 20)}…` : source.name
  return (
    <span className="flex shrink-0 items-center gap-1 self-end rounded-full border px-2 py-0.5 text-xs text-muted-foreground" title={source.name} data-testid="turn-remote-source">
      <MonitorSmartphone className="size-3" />
      {source.deviceId === self ? '本机发的' : `来自设备「${name}」`}
    </span>
  )
}

// 指向另一个任务（任务互通）：点一下切过去
function TaskLink({ source, label, className }: { source: { sessionId: string; title: string }; label: string; className?: string }) {
  const summary = useAppState((state) => state.tasks.find((task) => task.sessionId === source.sessionId))
  const readOnly = useReadOnly()
  const text = `${label}「${source.title.length > 20 ? `${source.title.slice(0, 20)}…` : source.title}」`
  // 远程会话里的任务 id 是对方设备上的，本机打不开
  if (readOnly) return <span className={cn('shrink-0 rounded-full border px-2 py-0.5 text-xs text-muted-foreground', className)}>{text}</span>
  return (
    <button
      type="button"
      className={cn('flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground', className)}
      data-testid="task-link"
      title={source.title}
      onClick={(event) => {
        event.stopPropagation()
        const target = summary ?? store.get().tasks.find((task) => task.sessionId === source.sessionId)
        if (target) void openTask(target)
        else showToast('这个任务已经不在了')
      }}
    >
      <ArrowUpRight className="size-3" />
      {text}
    </button>
  )
}

// 子智能体卡片：名字、颜色、交代的事和认领的文件。运行中显示第几步、在做什么；结束后是它交回的结果。
// 展开看它的每一步，改动和主对话里一样能看代码
function AgentCard({ item, steps, projectPath, onDiagnose }: { item: ToolItem; steps: ToolItem[]; projectPath: string; onDiagnose?: () => void }) {
  const card = item.agentCard!
  const [open, setOpen] = useState(false)
  const running = item.status !== 'completed' && item.status !== 'failed'
  // 第 659 步起卡片带开始时刻（排队等别的工人时还没有）；旧记录退回收到卡片的时刻
  const elapsed = useElapsed(card.startedAt ?? item.startedAt, running)
  const current = steps.at(-1)
  const action = current ? splitTitle(current.title) : null
  const result = textOf(item)
  const [showResult, setShowResult] = useState(false)
  const longResult = result.split('\n').length > 6 || result.length > 600
  const duration = card.startedAt !== undefined && card.endedAt !== undefined ? card.endedAt - card.startedAt : null
  const queued = running && card.startedAt === undefined && card.tokens !== undefined
  // 多候选方案（v2）的每个候选也用这张卡片，叫法换成「候选方案」
  const role = item.title.startsWith('候选方案 ') ? '候选方案' : '子智能体'
  return (
    <div
      className={cn(CARD_COMPACT, 'text-sm')}
      data-testid="agent-card"
      data-agent={card.name}
      data-status={item.status}
      data-item-id={item.id}
      // 定位结果指到工人的某一步、卡片收着时，滚到这张卡片
      data-item-ids={steps.map((step) => step.id).join(' ')}
    >
      <button type="button" aria-expanded={open} aria-label={`${open ? '收起' : '展开'}${role} ${card.name} 的步骤`} className="-mx-1 flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-accent/60" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: card.color }} aria-hidden="true" />
        <span className="shrink-0 font-bold">{card.name}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={card.task}>
          {card.task}
        </span>
        <StatusIcon status={item.status} />
      </button>
      {running ? (
        <p className="flex min-w-0 items-center gap-1.5 pl-5.5 text-xs text-muted-foreground" data-testid="agent-progress">
          {queued ? (
            <span className="shrink-0">排队中，等前面的子智能体做完</span>
          ) : (
            <>
              <span className="shrink-0">第 {Math.max(steps.length, 1)} 步</span>
              {action && (
                <span className="min-w-0 truncate">
                  · {action.action}
                  {action.target ? ` ${action.target}` : ''}
                </span>
              )}
            </>
          )}
          {card.tokens !== undefined && card.tokens > 0 && <span className="shrink-0 tabular-nums">· {formatTokens(card.tokens)} token</span>}
          {elapsed !== null && !queued && <span className="ml-auto shrink-0 tabular-nums">{formatDuration(elapsed)}</span>}
        </p>
      ) : (
        <>
          {result && (
            <div className="pl-5.5">
              <p className={cn('leading-relaxed break-words whitespace-pre-wrap text-foreground', longResult && !showResult && 'line-clamp-6')} data-testid="agent-result">
                {result}
              </p>
              {longResult && (
                <button type="button" aria-expanded={showResult} className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowResult(!showResult)}>
                  {showResult ? '收起结果' : '展开全部结果'}
                </button>
              )}
            </div>
          )}
          {(duration !== null || card.tokens !== undefined) && (
            <p className="flex flex-wrap gap-x-1.5 pl-5.5 text-xs text-muted-foreground tabular-nums" data-testid="agent-stats">
              {duration !== null && <span>用时 {formatDuration(duration)}</span>}
              <span>· {steps.length} 步</span>
              {card.tokens !== undefined && card.tokens > 0 && <span>· {formatTokens(card.tokens)} token</span>}
            </p>
          )}
        </>
      )}
      {onDiagnose && (
        <Button variant="outline" size="sm" className="ml-5.5 h-7 gap-1 self-start" onClick={onDiagnose}>
          <SearchCheck className="size-3.5" />
          定位问题
        </Button>
      )}
      {card.files.length > 0 && (
        <p className="truncate pl-5.5 text-xs text-muted-foreground" title={card.files.join('\n')}>
          认领：{card.files.join('、')}
        </p>
      )}
      {card.edited && card.edited.length > 0 && (
        <p className="flex flex-wrap items-baseline gap-x-1.5 pl-5.5 text-xs text-muted-foreground" data-testid="agent-edited">
          改了：
          {card.edited.map((path) => (
            <LocationLink key={path} location={path} className="font-mono" />
          ))}
        </p>
      )}
      {open && (
        <div className="ml-5.5 flex flex-col gap-1 border-l pl-3" data-testid="agent-steps">
          {steps.length === 0 && <p className="text-xs text-muted-foreground">还没有动作</p>}
          {steps.map((step) => (toolBlockType(step) === 'edit' ? <EditBlock key={step.id} item={step} projectPath={projectPath} /> : <ToolStep key={step.id} item={step} />))}
        </div>
      )}
    </div>
  )
}

// 停下的原因和下一步。只有最后一个执行轮带按钮：继续、换个模型继续、压缩上下文、去设置、定位问题
function StopSummary({ turn, task, actionable }: { turn: Turn; task: TurnTask; actionable: boolean }) {
  const summary = stopSummary(turn)
  if (!summary) return null
  // 外接智能体用它自己的模型和上下文：没有换模型、压缩、定位问题
  const actions = task.agent ? summary.actions.filter((action) => action === 'continue' || action === 'settings') : summary.actions
  const resume = () => void sendMessage(task.sessionId, '继续')
  const switchAndResume = async (model: ModelRef) => {
    if (await setTaskModel(task.sessionId, model)) await sendMessage(task.sessionId, '继续')
  }
  const buttons: Record<StopAction, React.ReactNode> = {
    continue: (
      <Button key="continue" variant="outline" size="sm" className="h-7" onClick={resume}>
        继续
      </Button>
    ),
    'switch-model': (
      <ModelMenu
        key="switch-model"
        label={task.modelLabel}
        modelRef={task.modelRef}
        modelsOnly
        onChange={(model) => void switchAndResume(model)}
        trigger={
          <Button variant="outline" size="sm" className="h-7 gap-1">
            换模型继续
            <ChevronDown className="size-3" />
          </Button>
        }
      />
    ),
    compact: (
      <Button key="compact" variant="outline" size="sm" className="h-7" onClick={() => void compactTask(task.sessionId)}>
        压缩上下文
      </Button>
    ),
    settings: task.agent ? (
      <Button key="settings" variant="outline" size="sm" className="h-7" onClick={() => openSettings('agents')}>
        打开外接智能体设置
      </Button>
    ) : (
      <Button key="settings" variant="outline" size="sm" className="h-7" onClick={() => openSettings('models')}>
        打开模型设置
      </Button>
    ),
    diagnose: (
      <Button key="diagnose" variant="outline" size="sm" className="h-7 gap-1" onClick={() => void diagnose(task.sessionId, { turnId: turn.id })}>
        <SearchCheck className="size-3.5" />
        定位问题
      </Button>
    ),
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted-foreground" data-testid="stop-summary">
      <p className="flex items-center gap-2">
        <Square className="size-3.5 shrink-0" />
        {summary.text}
      </p>
      {actionable && <div className="flex flex-wrap items-center gap-1.5">{actions.map((action) => buttons[action])}</div>}
    </div>
  )
}

// 模型很久没有输出：可能卡住了，也可能还在想，不替用户停；可以让卡住的那一步重发。几个子智能体同时没输出时提示最久的那个
// 外接智能体（agent）的请求在它自己那边，重发不了：只提示，停不停由用户决定
function ModelSilenceHint({ turn, sessionId, agent }: { turn: Turn; sessionId: string; agent?: string }) {
  const [key, longest] = Object.entries(turn.silence).sort(([, a], [, b]) => a.since - b.since)[0] ?? []
  const elapsed = useElapsed(longest?.since, longest !== undefined)
  const [retrying, setRetrying] = useState(false)
  const readOnly = useReadOnly()
  if (!key || !longest || elapsed === null) return null
  const retry = () => {
    setRetrying(true)
    window.diffra
      .retryStep(sessionId, key)
      .then(({ retried }) => {
        if (!retried) showToast('那一步已经有输出了，不用重发')
      })
      .catch((error: unknown) => showToast(`重发失败：${errorMessage(error)}`))
      .finally(() => setRetrying(false))
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-warning" data-testid="model-silence">
      <p className="flex items-start gap-2">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        {agent ?? (longest.agent ? `子智能体「${longest.agent}」的模型` : '模型')}已 {formatDuration(elapsed)}没有输出，可能卡住了{agent ? '，可以停止后再发一次' : ''}
      </p>
      {!readOnly && !agent && (
        <Button variant="outline" size="sm" className="h-7" disabled={retrying} onClick={retry}>
          重试这一步
        </Button>
      )}
    </div>
  )
}

// 卡片上的「填入修复提示词」：只有本机任务有（远程、只读会话没有 AnswerContext），只填不发
function useFillPrompt(): ((text: string) => void) | null {
  const target = useContext(AnswerContext)
  return target ? (text: string) => fillComposer(target.sessionId, text) : null
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

// 定位结果：原因、证据（点一下滚到那一步）、做完和没做完的、可以改的修复提示词，以及只有用户能回答的问题。
// 修复提示词可以填进输入框再改、直接发送，或者重新定位一次
function DiagnosisCard({ item, task, onLocate }: { item: ToolItem; task: TurnTask; onLocate(id: string): void }) {
  const diagnosis = item.diagnosis!
  const [prompt, setPrompt] = useState(diagnosis.prompt)
  const { target } = diagnosis
  const readOnly = useReadOnly()
  return (
    <CardShell
      data-testid="diagnosis"
      icon={<SearchCheck className="size-4 shrink-0 text-muted-foreground" />}
      title="定位结果"
      subtitle={diagnosis.fallback ? '模型没有给出结论，这是按记录拼的通用版本' : undefined}
      copy={{ label: '复制定位结果', text: () => diagnosisMarkdown(diagnosis, prompt) }}
      exportMarkdown={{ name: '定位结果', text: () => diagnosisMarkdown(diagnosis, prompt) }}
    >
      <p className="leading-relaxed" data-testid="diagnosis-cause">
        {diagnosis.cause}
      </p>
      {diagnosis.evidence.length > 0 && (
        <ul className="flex flex-col gap-1">
          {diagnosis.evidence.map((evidence, index) => (
            <li key={index} className="flex min-w-0 items-baseline gap-1.5 text-foreground">
              <button type="button" className="shrink-0 rounded-sm bg-muted px-1.5 font-mono text-xs hover:bg-accent" title="滚到这一步" onClick={() => onLocate(evidence.itemId)}>
                {evidence.title.length > 40 ? `${evidence.title.slice(0, 40)}…` : evidence.title}
              </button>
              <span className="min-w-0">{evidence.note}</span>
            </li>
          ))}
        </ul>
      )}
      {(diagnosis.done.length > 0 || diagnosis.remaining.length > 0) && (
        <div className="grid gap-x-6 gap-y-1.5 text-foreground sm:grid-cols-2">
          {diagnosis.done.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground">已经完成</p>
              <ul className="list-disc pl-4">
                {diagnosis.done.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
            </div>
          )}
          {diagnosis.remaining.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground">还没完成</p>
              <ul className="list-disc pl-4">
                {diagnosis.remaining.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {!readOnly && <QuestionBar questions={diagnosis.questions} text={prompt} onChange={setPrompt} />}
      <textarea
        aria-label="修复提示词"
        readOnly={readOnly}
        value={prompt}
        rows={Math.min(12, prompt.split('\n').length + 1)}
        onChange={(event) => setPrompt(event.target.value)}
        className="w-full resize-y rounded-md border bg-background px-3 py-2 leading-relaxed outline-none focus:border-ring/60"
      />
      {!readOnly && (
      <div className="flex flex-wrap items-center gap-2">
        <Button className="px-3.5" disabled={prompt.trim() === ''} onClick={() => fillComposer(task.sessionId, prompt.trim())}>
          填入输入框
        </Button>
        <Button variant="outline" disabled={task.running || prompt.trim() === ''} onClick={() => void sendMessage(task.sessionId, prompt.trim())}>
          直接发送
        </Button>
        <Button
          variant="ghost"
          className="text-muted-foreground"
          disabled={task.running}
          onClick={() => void diagnose(task.sessionId, { turnId: target.turnId, cardId: target.cardId ?? undefined, agent: target.agent ?? undefined })}
        >
          <RefreshCw className="size-3.5" />
          重新定位
        </Button>
      </div>
      )}
    </CardShell>
  )
}

// 定位结果整理成 Markdown：复制、导出用
function diagnosisMarkdown(diagnosis: NonNullable<ToolItem['diagnosis']>, prompt: string): string {
  const list = (title: string, lines: string[]) => (lines.length > 0 ? [`## ${title}`, ...lines.map((line) => `- ${line}`), ''] : [])
  return [
    '# 定位结果',
    '',
    diagnosis.cause,
    '',
    ...list('证据', diagnosis.evidence.map((evidence) => `${evidence.title}：${evidence.note}`)),
    ...list('已经完成', diagnosis.done),
    ...list('还没完成', diagnosis.remaining),
    '## 修复提示词',
    '',
    prompt,
  ].join('\n')
}

// 计划：可以直接改文字；点「按计划执行」，把这一轮的需求和改过的计划作为新的一轮发给编码模型
function PlanCard({ item, request, task, planTurnId }: { item: ToolItem; request: string; task: TurnTask; planTurnId: string }) {
  const original = textOf(item)
  const [text, setText] = useState(original)
  const readOnly = useReadOnly()
  // 按计划执行时把计划的步骤带上（v2，计划逐步打勾）：core 先把它们列成步骤清单，这张卡片按清单给每一步打勾
  const steps = splitPlan(text).steps.map((step) => step.title.trim()).filter(Boolean)
  const fromPlan = steps.length > 0 ? { turnId: planTurnId, steps: steps.slice(0, 20) } : undefined
  const progressText = useAppState((state) => planProgressText(state.live[task.sessionId]?.turns ?? [], planTurnId))
  const progress = useMemo(() => stepStatuses(steps, progressText), [steps.join('\n'), progressText])
  const execute = () => void sendMessage(task.sessionId, `按下面的计划完成任务。\n\n需求：\n${request}\n\n计划：\n${text.trim()}`, fromPlan ? { fromPlan } : {})
  // 步骤视图里点「从第 N 步开始执行」（第 663 步）：勾掉的步骤写明已经做完
  const runFrom = (step: number, done: number[]) =>
    void sendMessage(task.sessionId, `按下面的计划完成任务，从第 ${step} 步开始${done.length > 0 ? `（第 ${done.join('、')} 步已经做完，不用再做）` : ''}。\n\n需求：\n${request}\n\n计划：\n${text.trim()}`, fromPlan ? { fromPlan } : {})
  const doneCount = progress?.filter((status) => status === 'completed').length ?? 0
  // 多候选方案（v2）：按这份计划让几个候选各在一个 worktree 里做，比较后选一个
  const [choosing, setChoosing] = useState(false)
  return (
    <CardShell
      data-testid="tool-call"
      data-kind="plan"
      data-status={item.status}
      icon={<ListChecks className="size-4 shrink-0 text-muted-foreground" />}
      title="计划"
      copy={{ label: '复制计划', text: () => text }}
      exportMarkdown={{ name: '计划', text: () => `# 计划\n\n${text}` }}
    >
      {progress && (
        <p className="text-xs text-muted-foreground" data-testid="plan-progress">
          {progressText?.startsWith('running') ? '正在按计划执行' : '按计划执行过'}：做完 {doneCount} / {progress.length} 步
        </p>
      )}
      <PlanSteps text={text} readOnly={readOnly} running={task.running} onChange={setText} onRunFrom={runFrom} progress={progress} />
      <textarea
        aria-label="计划内容"
        readOnly={readOnly}
        value={text}
        rows={Math.min(24, text.split('\n').length + 1)}
        onChange={(event) => setText(event.target.value)}
        className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm leading-relaxed outline-none focus:border-ring/60"
      />
      {!readOnly && (
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={task.running || text.trim() === ''} className="px-3.5" onClick={execute}>
          按计划执行
        </Button>
        {!task.agent && (
          <Button variant="outline" disabled={task.running || text.trim() === ''} onClick={() => setChoosing(true)}>
            生成候选方案…
          </Button>
        )}
        <CandidatesDialog
          open={choosing}
          onCancel={() => setChoosing(false)}
          onSubmit={(candidates) => {
            setChoosing(false)
            void generateCandidates(task.sessionId, { request, plan: text.trim(), candidates })
          }}
        />
        {text !== original && (
          <button type="button" className="text-sm text-muted-foreground hover:text-foreground" onClick={() => setText(original)}>
            恢复原计划
          </button>
        )}
        <span className="text-xs text-muted-foreground">可以先改计划再执行；不满意就在下面接着说。</span>
      </div>
      )}
    </CardShell>
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
      <button type="button" className="flex max-w-full items-start gap-2 text-left text-foreground" onClick={() => setOpen(!open)} disabled={!detail}>
        <StatusIcon status={item.status} className="mt-1" />
        <span className="shrink-0 text-muted-foreground">上下文压缩</span>
        <span className="min-w-0 text-muted-foreground">{item.status === 'completed' || item.status === 'failed' ? headline : '正在压缩…'}</span>
        {detail && (open ? <ChevronDown className="mt-1 size-3 shrink-0" /> : <ChevronRight className="mt-1 size-3 shrink-0" />)}
      </button>
      {item.status === 'completed' && item.compaction && <CompactionBar stats={item.compaction} />}
      {open && detail &&<div className="mt-1.5 ml-5.5 max-h-96 overflow-auto rounded-md bg-muted p-2.5 leading-relaxed whitespace-pre-wrap">{detail}</div>}
    </div>
  )
}

// 每个文件只有一行标题：收起时是普通行，展开后这一行就是改动卡片的顶栏，代码区直接接在下面。
// 收起时和 DisclosureRow 的行一样高、箭头对齐：边框占的 1px 用负边距抵掉（横向是 px-1.5 加边框，界面字号可调，所以按 rem 算）
function EditBlock({ item, projectPath, expanded = false, toggle }: { item: ToolItem; projectPath: string; expanded?: boolean; toggle?: React.ReactNode }) {
  const [open, setOpen] = useState(expanded)
  useEffect(() => setOpen(expanded), [expanded])
  const diffs = item.content.flatMap((content) => (content.type === 'diff' ? [content] : []))
  return (
    <div className="flex flex-col gap-2" data-testid="tool-call" data-kind="edit" data-status={item.status}>
      {diffs.map((content, index) => {
        const path = relativePath(content.path, projectPath)
        return (
          <div key={content.path} className={cn('mx-[calc(-0.375rem-1px)] overflow-hidden rounded-lg border', !open && '-my-px border-transparent')}>
            <div className={cn('flex items-center', open ? 'border-b bg-muted/50 hover:bg-accent dark:bg-muted dark:hover:bg-accent' : 'hover:bg-muted/60')}>
              <button type="button" aria-expanded={open} aria-label={`查看改动 ${path}`} className={cn('flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1.5 text-left text-sm focus-visible:-outline-offset-2', open ? 'py-1.5' : 'py-0.5')} onClick={() => setOpen(!open)}>
                {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
                <StatusIcon status={item.status} />
                <span className="shrink-0 text-muted-foreground">{content.oldText === null ? '新建' : editMeta(content)?.deleted ? '删除' : '编辑'}</span>
                <span title={path} className="min-w-0 flex-1 truncate font-mono text-xs">{path}</span>
                <DiffCounts {...editCounts(content)} />
              </button>
              {index === 0 && toggle && <span className="flex pr-1">{toggle}</span>}
            </div>
            {open && <DiffView oldText={content.oldText ?? null} newText={content.newText} startLine={editMeta(content)?.startLine} />}
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
      <DisclosureRow open={open} onToggle={() => setOpen(!open)} className="text-foreground">
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
  if (type === 'review') return <ReviewBlock item={item} label="规范审查" />
  if (type === 'architecture') return <ReviewBlock item={item} label="架构检查" />
  if (type === 'security') return <SecurityBlock item={item} />
  return <CheckRow item={item} />
}

function checkName(item: ToolItem): string {
  const type = toolBlockType(item)
  if (type === 'review') return '规范审查'
  if (type === 'architecture') return '架构检查'
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
  const full = useFullOutput(item, open)
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
      {open && output && <ToolOutputView command={command} output={output} durationMs={item.durationMs} />}
      {full.note && <OutputNote note={full.note} retry={full.retry} />}
    </div>
  )
}

// 规范审查和架构检查：每行一处问题「规则或导入  路径:行号  说明」（FINDING_PATTERN 在 cards/FindingLists）
function ReviewBlock({ item, label }: { item: ToolItem; label: string }) {
  const text = textOf(item)
  const common = { 'data-testid': 'tool-call', 'data-kind': toolBlockType(item), 'data-status': item.status }
  if (item.status !== 'completed' && item.status !== 'failed') {
    return (
      <div {...common}>
        <DisclosureRow className="text-muted-foreground">
          <StatusIcon status={item.status} />
          {label}中…
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
          <span className="shrink-0">{label}没有完成，这次不拦截</span>
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
          <span className="shrink-0 text-muted-foreground">{label}</span>
          <span className="whitespace-pre-wrap">{text}</span>
        </DisclosureRow>
      </div>
    )
  }
  const lines = text.split('\n').filter(Boolean)
  const findings = lines.map((line) => FINDING_PATTERN.exec(line))
  const count = findings.filter(Boolean).length
  return (
    <CardShell
      {...common}
      density="compact"
      tone="danger"
      icon={<X className="size-3.5 shrink-0 text-destructive" strokeWidth={2.6} />}
      title={count > 0 ? `${label} · ${count} 处问题，已打回` : label}
      titleClassName="text-destructive"
      copy={{ label: '复制问题', text: () => text }}
    >
      <ReviewFindings lines={lines} />
    </CardShell>
  )
}

// 安全检查卡片的一行：级别  规则号  路径:行号  说明
const SECURITY_LINE = /^(高危|提醒|已放行) {2}(\S+) {2}(\S+:\d+) {2}(.+)$/

function SecurityBlock({ item }: { item: ToolItem }) {
  const fillPrompt = useFillPrompt()
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
  const fill = fillPrompt
  return (
    <CardShell
      {...common}
      density="compact"
      tone={high > 0 ? 'danger' : 'warning'}
      icon={high > 0 ? <X className="size-3.5 shrink-0 text-destructive" strokeWidth={2.6} /> : <CircleAlert className="size-3.5 shrink-0 text-warning" />}
      title={high > 0 ? `${title} · ${high} 处高危问题，已打回` : `${title} · 没有高危问题，${findings.length} 条需要留意`}
      titleClassName={high > 0 ? 'text-destructive' : undefined}
      copy={{ label: '复制发现', text: () => text }}
      actions={
        fill && (
          <ShellAction label="填入修复提示词" onClick={() => fill(`修复${title}发现的这些问题：\n${findings.filter((row) => row.match?.[1] !== '已放行').map((row) => `- ${row.line}`).join('\n')}`)}>
            <Wrench />
          </ShellAction>
        )
      }
    >
      <SecurityFindings rows={rows} />
    </CardShell>
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

function DeepScanReport({ item, task }: { item: ToolItem; task: TurnTask }) {
  const { summary, findings } = useMemo(() => parseReport(textOf(item)), [item])
  const readOnly = useReadOnly()
  // 默认勾上高危的
  const [selected, setSelected] = useState<Set<number>>(() => new Set(findings.flatMap((finding, index) => (finding.level === '高危' ? [index] : []))))
  const toggle = (index: number) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  const fixPrompt = () => {
    const lines = findings
      .filter((_, index) => selected.has(index))
      .map(
        (finding, index) =>
          `${index + 1}. [${finding.ruleId}] ${finding.location} ${finding.problem}` +
          (finding.flow ? `\n   链路：${finding.flow}` : '') +
          (finding.fix ? `\n   修复建议：${finding.fix}` : ''),
      )
    return `修复深度安全扫描发现的这些问题：\n${lines.join('\n')}`
  }
  const fix = () => void sendMessage(task.sessionId, fixPrompt())

  return (
    <CardShell
      data-testid="tool-call"
      data-kind="deep-scan"
      data-status={item.status}
      title="深度扫描报告"
      copy={{ label: '复制报告', text: () => textOf(item) }}
      exportMarkdown={{ name: '深度扫描报告', text: () => `# 深度扫描报告\n\n${textOf(item)}` }}
    >
      <p className="text-muted-foreground">{summary}</p>
      {findings.length === 0 && <p>没有发现可以确认的安全问题。</p>}
      {findings.map((finding, index) => (
        <label key={index} className="flex cursor-pointer gap-2.5 rounded-lg border px-3 py-2" data-testid="deep-scan-finding">
          {!readOnly && <Checkbox className="mt-0.5" checked={selected.has(index)} onCheckedChange={() => toggle(index)} />}
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className={cn('rounded-sm px-1.5 text-xs', levelStyle(finding.level))}>{finding.level}</span>
              <span className="font-mono text-xs">{finding.ruleId}</span>
              <LocationLink location={finding.location} className="font-mono text-xs" />
            </div>
            <div>{finding.problem}</div>
            {finding.flow && <div className="text-xs text-muted-foreground">链路：{finding.flow}</div>}
            {finding.fix && <div className="text-xs text-muted-foreground">修复：{finding.fix}</div>}
          </div>
        </label>
      ))}
      {!readOnly && findings.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={selected.size === 0} onClick={fix}>
            {task.running ? `排队修复选中的 ${selected.size} 个问题` : `修复选中的 ${selected.size} 个问题`}
          </Button>
          <Button variant="outline" disabled={selected.size === 0} onClick={() => fillComposer(task.sessionId, fixPrompt())}>
            填入输入框
          </Button>
        </div>
      )}
    </CardShell>
  )
}

interface ChangedFile {
  path: string
  added: number
  removed: number
}

// 一张改动卡片的增删行数：卡片内容不变就不重算（流式输出时运行中那一轮每来一条更新都会重画）
const editCountsCache = new WeakMap<object, { added: number; removed: number }>()
function editCounts(content: { oldText?: string | null; newText: string }): { added: number; removed: number } {
  let counts = editCountsCache.get(content)
  if (!counts) {
    const { added, removed } = diffStats(content.oldText ?? null, content.newText)
    counts = { added, removed }
    editCountsCache.set(content, counts)
  }
  return counts
}

// 本轮报告的数据（第 661 步）：只看主智能体自己的步骤，子智能体的收在它的卡片里
function turnReport(turn: Turn, files: ChangedFile[], project: string): TurnReportData {
  const tools = turn.items.filter((item): item is ToolItem => item.kind === 'tool' && !item.parentId)
  const checks = tools
    .filter((item) => ['check', 'review', 'architecture', 'security'].includes(toolBlockType(item) ?? '') && (item.status === 'completed' || item.status === 'failed'))
    .map((item) => ({ name: checkName(item), state: checkPassed(item) ? ('passed' as const) : item.status === 'failed' || item.result === 'failed' ? ('failed' as const) : ('attention' as const) }))
  const commands = tools.filter((item) => item.toolKind === 'execute' && toolBlockType(item) === null)
  const failed = commands.filter((item) => item.succeeded === false).map((item) => splitTitle(item.title).target || item.title)
  const tests = commands.flatMap((item) => {
    const summary = parseTestSummary(splitCommandOutput(textOf(item)).body)
    return summary ? [{ command: splitTitle(item.title).target, passed: summary.passed, failed: summary.failed, skipped: summary.skipped }] : []
  })
  const verification = turn.outcome?.finish ?? null
  const risks: string[] = []
  const stop = stopSummary(turn)
  if (stop) risks.push(stop.text)
  if (verification === 'unverified' && files.length > 0) risks.push('改动没有经过自动验证')
  for (const check of checks) if (check.state !== 'passed') risks.push(`${check.name}${check.state === 'failed' ? '没通过' : '有需要留意的地方'}`)
  for (const test of tests) if (test.failed > 0) risks.push(`测试 ${test.command} 有 ${test.failed} 个失败`)
  if (failed.length > 0) risks.push(`${failed.length} 条命令失败：${failed.slice(0, 3).join('；')}${failed.length > 3 ? ' …' : ''}`)
  const next: string[] = []
  if (checks.some((check) => check.state === 'failed') || tests.some((test) => test.failed > 0)) next.push('修好没通过的检查和测试')
  if (verification === 'unverified' && files.length > 0) next.push('运行项目的测试或检查命令，确认改动没问题')
  if (checks.some((check) => check.state === 'attention')) next.push('看一下检查里需要留意的地方')
  if (files.length > 0) next.push('在审阅面板里看一遍改动')
  return {
    request: turn.prompt,
    files: files.map((file) => ({ path: relativePath(file.path, project), added: file.added, removed: file.removed })),
    checks,
    tests,
    commands: { total: commands.length, failed },
    verification,
    risks,
    next,
    durationMs: turn.startedAt && turn.endedAt ? turn.endedAt - turn.startedAt : null,
  }
}

// 每个文件按第一次改之前和最后一次改之后的全文算净改动（edits 是 replayEdits 还原的全文）
function filesOf(items: TranscriptItem[], edits: Map<string, EditTexts>): ChangedFile[] {
  const files = new Map<string, { oldText: string | null; newText: string }>()
  for (const item of items) {
    if (item.kind !== 'tool' || item.status !== 'completed') continue
    for (const content of item.content) {
      if (content.type !== 'diff') continue
      const texts = edits.get(editKey(item.id, content.path))
      if (!texts) continue
      const existing = files.get(content.path)
      files.set(content.path, { oldText: existing ? existing.oldText : texts.before, newText: texts.after })
    }
  }
  return [...files].map(([path, content]) => ({ path, ...diffStats(content.oldText, content.newText) }))
}

// 时间线悬停时的一句话：改了几个文件、净增删、结论。已经结束的轮次不变，按轮次对象缓存，流式输出时不重算
const turnSummaries = new WeakMap<Turn, string>()
function turnSummary(turn: Turn): string {
  const cached = turnSummaries.get(turn)
  if (cached) return cached
  const files = filesOf(turn.items, replayEdits(turn.items))
  const added = files.reduce((total, file) => total + file.added, 0)
  const removed = files.reduce((total, file) => total + file.removed, 0)
  const parts = [files.length > 0 ? `${files.length} 个文件 +${added} −${removed}` : '没有改文件']
  if (turn.restoredAt) parts.push('已撤销')
  else if (turn.outcome?.finish === 'verified') parts.push('已验证')
  else if (turn.outcome?.finish === 'unverified' && files.length > 0) parts.push('未验证')
  if (turn.error) parts.push('出错')
  const summary = parts.join(' · ')
  turnSummaries.set(turn, summary)
  return summary
}

function Timeline({ turns, activeTurn, onJump }: { turns: Turn[]; activeTurn: string | null; onJump(turnId: string): void }) {
  return (
    <nav aria-label="对话时间线" className="absolute top-7 right-5 flex max-h-[70%] flex-col gap-1 overflow-hidden">
      {turns.map((turn) => (
        <Tooltip key={turn.id}>
          <TooltipTrigger asChild>
            <button type="button" aria-label={`跳到：${turn.prompt.slice(0, 30)}`} className="flex h-2.5 w-4 items-center justify-end" onClick={() => onJump(turn.id)}>
              <span className={cn('h-0.5 rounded-full', turn.id === activeTurn ? 'w-3 bg-foreground' : 'w-2 bg-muted-foreground/50')} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" className="flex max-w-64 flex-col items-start gap-0.5" data-testid="timeline-tooltip">
            <span className="max-w-full truncate">{turn.prompt.split(/\r?\n/)[0]}</span>
            {/* 检查点时间线（第 661 步）：这一轮改了什么、结论是什么 */}
            <span className="tabular-nums">{turnSummary(turn)}</span>
          </TooltipContent>
        </Tooltip>
      ))}
    </nav>
  )
}
