import { type DragEvent, type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { type CommandInfo, type PermissionMode, type PromptImage, type PromptQuestion, type ReasoningEffort, type SkillInfo, type SkillSource } from '@diffra/core/types'
import { ArrowUp, Check, ChevronDown, ChevronUp, File as FileIcon, FileText, Folder, ListChecks, LoaderCircle, type LucideIcon, Plug, Settings2, Shield, ShieldAlert, ShieldCheck, Sparkles, Square, SquareSlash, Target, Undo2, WandSparkles, X } from 'lucide-react'
import type { McpStatusTarget } from '../../../../shared/ipc'
import { COMPOSER_PLACEHOLDER, IMAGE_ONLY_PROMPT, MAX_PROMPT_FILE_REFERENCES, promptWithFileReferences } from '../../../../shared/attachments'
import { modelDisplayName, type ModelRef } from '../../../../shared/settings'
import { reasoningEffortsFor, withRememberedEffort } from '../../../../shared/reasoning'
import { cn } from 'cn'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useMcpStatus } from '@/features/mcp/useMcpStatus'
import { BrandIcon } from '@/features/models/BrandIcon'
import { errorMessage } from '@/lib/errors'
import { formatTokens } from '@/lib/format'
import { imageUrl, MAX_PROMPT_IMAGES, prepareImage } from '@/lib/images'
import { useLobeIcons } from '@/lib/model-icons'
import { PERMISSION_MODES, permissionModeLabel } from '@/lib/permission-modes'
import { openSettings, refreshSettings, rememberReasoning } from '@/state/actions'
import { ArgumentsDialog, type ArgumentsRequest } from './ArgumentsDialog'
import { QuestionBar } from './QuestionBar'
import { clearComposerDraft, type ComposerDraft, type ComposerFile, type ComposerImage, readComposerDraft, writeComposerDraft } from './composer-drafts'
import { useRemoteTask } from './remote-task'
import { showToast, store, useAppState } from '@/state/store'

// 斜杠菜单里由页面提供的命令，比如任务页的深度扫描
export interface ComposerCommand {
  id: string
  label: string
  description: string
  // 用英文也能搜到
  keywords: string[]
  icon: LucideIcon
  run(): void
}

interface ComposerProps {
  size: 'large' | 'normal'
  // 草稿按它存：首页按项目、任务按会话，切走再回来接着写
  draftKey: string
  // 会话没建好时不能发送
  disabled?: boolean
  // 底栏最左边的控件，首页没选项目时放项目选择
  leading?: ReactNode
  running?: boolean
  // 选好项目后把焦点放回输入框
  projectPath: string | null
  // 斜杠菜单从这里读 Skill、自定义命令和 MCP 提示词模板
  mcpTarget: McpStatusTarget | null
  commands?: ComposerCommand[]
  permissionMode: PermissionMode
  onPermissionModeChange(mode: PermissionMode): void
  modelLabel: string | null
  modelRef?: ModelRef
  modelLocked?: boolean
  onModelChange(ref: ModelRef): void
  // 开着时发的消息先由规划模型出计划，不改代码
  planMode: boolean
  onPlanModeChange(planMode: boolean): void
  // 返回 false 表示没发出去，输入框里的内容和选的目标、Skill 保留
  onSend(text: string, extras: { goal: boolean; skills: string[]; images: PromptImage[] }): boolean | Promise<boolean>
  onStop?(): void
}

const SOURCE_LABELS: Record<SkillSource, string> = { project: '项目', user: '用户', plugin: '插件', claude: 'Claude', codex: 'Codex', builtin: '内置' }

interface MenuItem {
  key: string
  group: '命令' | '自定义命令' | 'Skill' | 'MCP'
  label: string
  description: string
  badge: string | null
  icon: LucideIcon
  matches(query: string): boolean
  // at：输入的「/xxx」原来的位置，展开 MCP prompt 时插在这里
  select(at: number): void
}

// 光标前在开头或空白后面的「/xxx」
function slashToken(text: string, caret: number): { start: number; query: string } | null {
  const match = /(?:^|\s)\/([^\s/]*)$/.exec(text.slice(0, caret))
  return match ? { start: caret - match[1]!.length - 1, query: match[1]! } : null
}

const includes = (texts: string[], query: string) => texts.some((text) => text.toLowerCase().includes(query.toLowerCase()))

// 自定义命令的参数：$ARGUMENTS 是整段，$1 到 $9 按空白分开取
const usesArguments = (body: string) => /\$ARGUMENTS|\$[1-9]/.test(body)

function expandCommand(body: string, input: string): string {
  const positional = input.trim().split(/\s+/).filter(Boolean)
  // 先换位置参数再换整段，用函数替换：用户填的内容里有 $1、$& 也原样保留
  return body.replace(/\$([1-9])/g, (_match, index: string) => positional[Number(index) - 1] ?? '').replace(/\$ARGUMENTS/g, () => input.trim())
}

const MAX_COMPOSER_LINES = 10

// 任务监控「来源」的「+」打开这个任务输入框的选文件，按任务 id 找。选文件框要在用户点击的那次事件里打开，所以直接调，不经过 store
const attachPickers = new Map<string, () => void>()
export function pickAttachments(sessionId: string): void {
  attachPickers.get(sessionId)?.()
}

type PreviewTarget =
  | { kind: 'image'; image: ComposerImage }
  | { kind: 'file'; file: ComposerFile }

interface MentionTarget {
  token: string
  image?: ComposerImage
  file?: ComposerFile
}

// 把草稿拆成普通文字和 @附件：附件只上色，不加边距，着色层和 textarea 的换行才一致。
// 输入法组字时文字由 textarea 自己显示，这里只留附件的底色
function highlightDraft(text: string, mentions: MentionTarget[], composing: boolean): ReactNode[] {
  const nodes: ReactNode[] = []
  let index = 0
  let key = 0
  while (index < text.length) {
    const target = mentions.find(({ token }) => text.startsWith(token, index))
    if (target) {
      nodes.push(
        // primary-color-allow: @附件点击后打开预览，是可点的动作
        <span key={`mention-${key++}`} className={cn('rounded-sm bg-primary/10', composing ? 'text-transparent' : 'text-primary')}>
          {target.token}
        </span>,
      )
      index += target.token.length
      continue
    }
    let next = text.length
    for (const { token } of mentions) {
      const at = text.indexOf(token, index)
      if (at > index && at < next) next = at
    }
    nodes.push(text.slice(index, next))
    index = next
  }
  return nodes
}

export function Composer(props: ComposerProps) {
  const { size, disabled, running, onSend, onStop } = props
  // 远程任务（借用本机任务页）：Skill 和自定义命令向对方要；MCP 提示词、附文档、优化提示词要用本机的项目和模型，远程不做
  const remote = useRemoteTask()
  const large = size === 'large'
  // 右侧给滚动条留固定宽度：textarea 是 pr-2.5 加 10px 的滚动条位置，着色层直接留 0.625rem + 10px。
  // 不能写成 pr-5：rem 跟着字号设置变，只有根字号 16px 时 1.25rem 才等于 0.625rem + 10px，差一点换行位置就错开
  const textLayout = large ? 'pl-4.5 pt-4 pb-2 text-base' : 'pl-3.5 pt-3 pb-1'
  const placeholder = COMPOSER_PLACEHOLDER
  const goalRounds = useAppState((state) => state.settings?.execution.goalMaxRounds ?? null)
  // 切页面前存在这里，回来接着写；只在这个组件第一次挂载时读一次
  const initialDraft = useRef<ComposerDraft | null>(readComposerDraft(props.draftKey)).current
  const [draft, setDraft] = useState(initialDraft?.text ?? '')
  const [caret, setCaret] = useState(0)
  const [sending, setSending] = useState(false)
  const [goal, setGoal] = useState(initialDraft?.goal ?? false)
  const [skills, setSkills] = useState<SkillInfo[]>(initialDraft?.skills ?? [])
  // 粘贴或拖入的图片，已经缩小、转成 WebP；普通文件只保留路径引用。
  const [images, setImages] = useState<ComposerImage[]>(initialDraft?.images ?? [])
  const [fileReferences, setFileReferences] = useState<ComposerFile[]>(initialDraft?.files ?? [])
  const [dragging, setDragging] = useState(false)
  const [addingAttachments, setAddingAttachments] = useState(false)
  const [preview, setPreview] = useState<PreviewTarget | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  // 输入法组字时把文字显示在 textarea 本身，着色层的字先变透明（附件底色留着），避免两份文字叠着
  const [composing, setComposing] = useState(false)
  const mentionCounter = useRef(initialDraft?.images.reduce((max, image) => Math.max(max, Number(/(\d+)$/.exec(image.mention)?.[1] ?? 0)), 0) ?? 0)
  const attachmentBusy = useRef(false)
  const dragDepth = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pickerTarget = props.mcpTarget && 'sessionId' in props.mcpTarget ? props.mcpTarget.sessionId : null
  useEffect(() => {
    if (!pickerTarget) return
    const pick = () => fileInputRef.current?.click()
    attachPickers.set(pickerTarget, pick)
    return () => {
      if (attachPickers.get(pickerTarget) === pick) attachPickers.delete(pickerTarget)
    }
  }, [pickerTarget])
  // 当前模型打开了「视觉」没有；对不上设置里的模型时为 null，交给 core 判断
  const imagesSupported = useAppState((state) => {
    const ref = props.modelRef
    if (!ref) return null
    const model = state.settings?.providers.find((provider) => provider.id === ref.providerId)?.models.find((item) => item.id === ref.modelId)
    return model ? model.images : null
  })
  // 按了 Esc 的那个「/」，换一个再打开
  const [dismissed, setDismissed] = useState<number | null>(null)
  const [active, setActive] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // 填入、优化提示词之后可以撤销：after 是那时的草稿，用户再改字就不能撤销了
  const [undo, setUndo] = useState<{ label: string; before: string; after: string } | null>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft
  useEffect(() => {
    if (undo && draft !== undo.after) setUndo(null)
  }, [draft, undo])
  const replaceDraft = (text: string, label: string) => {
    setUndo({ label, before: draftRef.current, after: text })
    setDraft(text)
    textareaRef.current?.focus()
  }
  const insert = useAppState((state) => state.composerInsert)
  useEffect(() => {
    if (!insert) return
    const target = props.mcpTarget && 'sessionId' in props.mcpTarget ? props.mcpTarget.sessionId : 'home'
    if (insert.target !== target) return
    store.set((state) => ({ ...state, composerInsert: undefined }))
    if (insert.mode === 'append') {
      setDraft((current) => current + insert.text)
      textareaRef.current?.focus()
      return
    }
    // 派待办时带的附件：加进输入框的附件，提到它们的 @ 接在填入的文字后面；超出一条消息的上限就不加
    const addedImages: ComposerImage[] = (insert.images ?? [])
      .slice(0, Math.max(0, MAX_PROMPT_IMAGES - images.length))
      .map((image) => ({ ...image, id: crypto.randomUUID(), mention: `@图片${++mentionCounter.current}` }))
    let limited = addedImages.length < (insert.images?.length ?? 0)
    const taken = new Set([...fileReferences.map((file) => file.mention), ...images.map((image) => image.mention)])
    const addedFiles: ComposerFile[] = []
    for (const file of insert.files ?? []) {
      if (fileReferences.some((entry) => entry.path === file.path) || addedFiles.some((entry) => entry.path === file.path)) continue
      if (fileReferences.length + addedFiles.length >= MAX_PROMPT_FILE_REFERENCES) {
        limited = true
        break
      }
      let mention = `@${file.name}`
      for (let suffix = 2; taken.has(mention); suffix++) mention = `@${file.name}(${suffix})`
      taken.add(mention)
      addedFiles.push({ ...file, mention })
    }
    if (limited) showToast('输入框里的附件到上限了，有的没有加')
    const mentions = [...addedImages, ...addedFiles].map((item) => item.mention).join(' ')
    const text = mentions ? `${insert.text}\n\n${mentions} ` : insert.text
    if (addedImages.length > 0) setImages((current) => [...current, ...addedImages])
    if (addedFiles.length > 0) setFileReferences((current) => [...current, ...addedFiles])
    const current = draftRef.current
    replaceDraft(current.trim() === '' ? text : `${current.trimEnd()}\n\n${text}`, '撤销填入')
  }, [insert, props.mcpTarget])
  // 优化提示词：一次调用拿到改写稿和问题，改写稿直接替换草稿（可撤销），问题放在输入框上方的问题条里
  const [enhancing, setEnhancing] = useState(false)
  const [questions, setQuestions] = useState<{ key: number; items: PromptQuestion[] }>({ key: 0, items: [] })
  // 首页没选项目时项目菜单在底栏里，选好后菜单挪走，焦点会掉到 body；放回输入框，草稿还在这里
  const previousProject = useRef(props.projectPath)
  useEffect(() => {
    if (previousProject.current === null && props.projectPath) textareaRef.current?.focus()
    previousProject.current = props.projectPath
  }, [props.projectPath])
  const listRef = useRef<HTMLDivElement>(null)
  // 选完菜单项后光标要放回的位置；输入框内容更新后立刻放，晚了会和接着输入的字抢
  const pendingCaret = useRef<number | null>(null)
  const hasMessage = draft.trim() !== '' || images.length > 0 || fileReferences.length > 0
  // 离开页面时草稿还在；写进模块里的表，不触发全局重渲染
  useEffect(() => {
    writeComposerDraft(props.draftKey, { text: draft, images, files: fileReferences, goal, skills })
  }, [props.draftKey, draft, images, fileReferences, goal, skills])
  const mentions = useMemo<MentionTarget[]>(
    () =>
      [
        ...images.map((image) => ({ token: image.mention, image })),
        ...fileReferences.map((file) => ({ token: file.mention, file })),
      ].sort((a, b) => b.token.length - a.token.length),
    [images, fileReferences],
  )
  // 光标落在哪个 @ 附件上；点击 token 时打开预览
  const previewAt = (text: string, position: number): PreviewTarget | null => {
    const target = mentions.find(({ token }) => {
      let from = 0
      while (from <= text.length) {
        const index = text.indexOf(token, from)
        if (index < 0) return false
        if (position >= index && position <= index + token.length) return true
        from = index + token.length
      }
      return false
    })
    return target?.image ? { kind: 'image', image: target.image } : target?.file ? { kind: 'file', file: target.file } : null
  }

  const token = disabled ? null : slashToken(draft, caret)
  const menuOpen = token !== null && token.start !== dismissed
  const ready = !disabled && !sending && !addingAttachments && hasMessage
  // 斜杠菜单开着时 Enter 用来选菜单项，按钮也不可发；Ctrl/Meta+Enter 仍原样发送，避免「清理 /tmp」这类文本无路可发
  const canSend = ready && !menuOpen
  const tokenStart = token?.start ?? null
  useEffect(() => {
    if (tokenStart === null) setDismissed(null)
  }, [tokenStart])
  const available = useProjectList(menuOpen ? props.mcpTarget : null, (target) => (remote?.listSkills ? remote.listSkills() : window.diffra.listSkills(target)), '读取 Skill 失败')
  const commandList = useProjectList(menuOpen ? props.mcpTarget : null, (target) => (remote?.listCommands ? remote.listCommands() : window.diffra.listCommands(target)), '读取自定义命令失败')
  const mcp = useMcpStatus(menuOpen && !remote ? props.mcpTarget : null)
  // 第一次打开时 Skill、自定义命令和 MCP prompt 还在读：先占一行，免得读完菜单突然变高、高亮项跟着跳
  const listLoading = menuOpen && props.mcpTarget !== null && (available === null || commandList === null || (!remote && mcp.statuses === null && mcp.error === null))
  // 有参数的 MCP prompt 和自定义命令先弹框填参数
  const [argumentsRequest, setArgumentsRequest] = useState<{ request: ArgumentsRequest; submit(args: Record<string, string>): void } | null>(null)

  // 把文字插到输入的「/xxx」原来的位置；MCP prompt 要先去服务器取
  const insertAt = async (at: number, text: () => string | Promise<string>, failure: string) => {
    try {
      const value = await text()
      setDraft((current) => {
        const position = Math.min(at, current.length)
        pendingCaret.current = position + value.length
        return current.slice(0, position) + value + current.slice(position)
      })
      textareaRef.current?.focus()
    } catch (error) {
      showToast(`${failure}：${errorMessage(error)}`)
    }
  }

  const mcpPrompt = (server: string, prompt: string, args: Record<string, string>) => () => {
    if (!props.mcpTarget) throw new Error('还没有选项目')
    return window.diffra.mcpPrompt(props.mcpTarget, server, prompt, args)
  }

  const chooseCommand = (command: CommandInfo, at: number) => {
    if (!usesArguments(command.body)) return void insertAt(at, () => command.body, '插入命令失败')
    setArgumentsRequest({
      request: {
        title: `/${command.name}`,
        description: command.description,
        arguments: [{ name: 'arguments', label: '参数', hint: command.argumentHint, required: false }],
      },
      submit: (args) => void insertAt(at, () => expandCommand(command.body, args.arguments ?? ''), '插入命令失败'),
    })
  }

  const changePlanMode = (planMode: boolean) => {
    // 出计划和目标模式二选一
    if (planMode) setGoal(false)
    props.onPlanModeChange(planMode)
  }

  const items: MenuItem[] = [
    {
      key: 'goal',
      group: '命令' as const,
      label: '目标',
      description: `自动多轮推进，直到目标达成${goalRounds ? `，最多 ${goalRounds} 轮` : ''}`,
      badge: null,
      icon: Target,
      matches: (query: string) => includes(['目标', 'goal'], query),
      select: () => {
        setGoal(true)
        if (props.planMode) props.onPlanModeChange(false)
      },
    },
    {
      key: 'plan',
      group: '命令' as const,
      label: '计划',
      description: '先由规划模型只读地出一份计划，确认后再改代码',
      badge: null,
      icon: ListChecks,
      matches: (query: string) => includes(['计划', 'plan'], query),
      select: () => changePlanMode(true),
    },
    ...(props.commands ?? []).map((command) => ({
      key: command.id,
      group: '命令' as const,
      label: command.label,
      description: command.description,
      badge: null,
      icon: command.icon,
      matches: (query: string) => includes([command.label, ...command.keywords], query),
      select: command.run,
    })),
    ...(commandList ?? []).map((command) => ({
      key: `command:${command.name}`,
      group: '自定义命令' as const,
      label: command.name,
      description: command.description,
      badge: SOURCE_LABELS[command.source],
      icon: SquareSlash,
      matches: (query: string) => includes([command.name, command.description], query),
      select: (at: number) => chooseCommand(command, at),
    })),
    ...(available ?? [])
      .filter((skill) => !skills.some((item) => item.name === skill.name))
      .map((skill) => ({
        key: `skill:${skill.name}`,
        group: 'Skill' as const,
        label: skill.name,
        description: skill.description,
        badge: SOURCE_LABELS[skill.source],
        icon: Sparkles,
        matches: (query: string) => includes([skill.name, skill.description], query),
        select: () => setSkills((current) => [...current, skill]),
      })),
    ...(mcp.statuses ?? []).flatMap((server) =>
      server.prompts.map((prompt) => ({
        key: `mcp:${server.name}:${prompt.name}`,
        group: 'MCP' as const,
        label: `${server.name}:${prompt.name}`,
        description: prompt.description,
        badge: 'MCP',
        icon: Plug,
        matches: (query: string) => includes([`${server.name}:${prompt.name}`, prompt.description], query),
        select: (at: number) => {
          if (prompt.arguments.length === 0) return void insertAt(at, mcpPrompt(server.name, prompt.name, {}), '展开提示词模板失败')
          setArgumentsRequest({
            request: {
              title: `${server.name}:${prompt.name}`,
              description: prompt.description,
              arguments: prompt.arguments.map((arg) => ({ name: arg.name, label: arg.name, hint: arg.description, required: arg.required })),
            },
            submit: (args) => void insertAt(at, mcpPrompt(server.name, prompt.name, args), '展开提示词模板失败'),
          })
        },
      })),
    ),
  ].filter((item) => token === null || item.matches(token.query))

  const query = token?.query ?? null
  useEffect(() => setActive(0), [query])
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, menuOpen])

  // 选中后把「/xxx」从输入框里去掉
  const choose = (item: MenuItem) => {
    if (!token) return
    const next = draft.slice(0, token.start) + draft.slice(caret)
    setDraft(next)
    setCaret(token.start)
    pendingCaret.current = token.start
    item.select(token.start)
  }

  useLayoutEffect(() => {
    if (pendingCaret.current === null) return
    textareaRef.current?.setSelectionRange(pendingCaret.current, pendingCaret.current)
    pendingCaret.current = null
  }, [draft])

  // 输入框最多长到 10 行，再长就在框里滚动；高度跟着内容走，不能只留固定三行
  useLayoutEffect(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    const styles = getComputedStyle(element)
    const lineHeight = Number.parseFloat(styles.lineHeight)
    const padding = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom)
    const maxHeight = Number.isFinite(lineHeight) ? lineHeight * MAX_COMPOSER_LINES + padding : element.scrollHeight
    const height = Math.min(element.scrollHeight, maxHeight)
    element.style.height = `${height}px`
    element.style.overflowY = element.scrollHeight > height ? 'auto' : 'hidden'
    setScrollTop(element.scrollTop)
  }, [draft, large])

  // 把 @图片1、@文件名 插到光标处；返回的位置给 setSelectionRange 用
  const insertMentions = (tokens: string[]) => {
    if (tokens.length === 0) return
    const at = textareaRef.current?.selectionStart ?? draft.length
    const inserted = tokens.map((token) => `${token} `).join('')
    setDraft((current) => {
      const position = Math.min(at, current.length)
      const space = position > 0 && !/\s/.test(current[position - 1] ?? '') ? ' ' : ''
      pendingCaret.current = position + space.length + inserted.length
      return current.slice(0, position) + space + inserted + current.slice(position)
    })
    textareaRef.current?.focus()
  }

  const removeMentionText = (mention: string) => {
    setDraft((current) => {
      const index = current.indexOf(mention)
      if (index < 0) return current
      let end = index + mention.length
      if (current[end] === ' ') end++
      return current.slice(0, index) + current.slice(end)
    })
  }

  const removeImage = (image: ComposerImage) => {
    setImages((current) => current.filter((item) => item.id !== image.id))
    removeMentionText(image.mention)
  }

  const removeFile = (file: ComposerFile) => {
    setFileReferences((current) => current.filter((item) => item.path !== file.path))
    removeMentionText(file.mention)
  }

  const addImages = async (files: File[]) => {
    const room = MAX_PROMPT_IMAGES - images.length
    if (room <= 0) return showToast(`一条消息最多带 ${MAX_PROMPT_IMAGES} 张图片`)
    if (files.length > room) showToast(`一条消息最多带 ${MAX_PROMPT_IMAGES} 张图片，多出来的没有加`)
    const added: ComposerImage[] = []
    for (const file of files.slice(0, room)) {
      try {
        const image = await prepareImage(file)
        added.push({ ...image, id: crypto.randomUUID(), mention: `@图片${++mentionCounter.current}` })
      } catch (error) {
        showToast(`${file.name || '图片'}：${errorMessage(error)}`)
      }
    }
    if (added.length === 0) return
    setImages((current) => [...current, ...added].slice(0, MAX_PROMPT_IMAGES))
    insertMentions(added.map((image) => image.mention))
  }

  const addAttachments = async (files: File[], includeReferences: boolean) => {
    if (disabled || sending) return
    if (attachmentBusy.current) { showToast('正在处理上一批附件，请稍后再添加'); return }
    attachmentBusy.current = true
    setAddingAttachments(true)
    try {
      const pictures = files.filter((file) => file.type.startsWith('image/'))
      // 引用的是本机文件，对方电脑上没有
      if (remote && includeReferences && pictures.length < files.length) showToast('远程任务只能附图片')
      const documents = includeReferences && !remote ? files.filter((file) => !file.type.startsWith('image/')) : []
      const room = MAX_PROMPT_FILE_REFERENCES - fileReferences.length
      if (documents.length > room) showToast(`一条消息最多引用 ${MAX_PROMPT_FILE_REFERENCES} 个文件或文件夹`)
      const paths = documents.slice(0, Math.max(0, room)).map((file) => window.diffra.getPathForFile(file)).filter((path) => path !== '')
      if (paths.length !== Math.min(documents.length, Math.max(0, room))) showToast('无法获取部分附件的本地路径，请从文件管理器拖入')
      if (paths.length > 0) {
        const references = await window.diffra.describeAttachments(paths)
        const taken = new Set([...fileReferences.map((file) => file.mention), ...images.map((image) => image.mention)])
        const added: ComposerFile[] = []
        for (const file of references) {
          if (fileReferences.some((entry) => entry.path === file.path) || added.some((entry) => entry.path === file.path)) continue
          const base = `@${file.name}`
          let mention = base
          for (let suffix = 2; taken.has(mention); suffix++) mention = `${base}(${suffix})`
          taken.add(mention)
          added.push({ ...file, mention })
        }
        setFileReferences((current) => [...current, ...added].slice(0, MAX_PROMPT_FILE_REFERENCES))
        insertMentions(added.map((file) => file.mention))
      }
      if (pictures.length > 0) await addImages(pictures)
    } catch (error) {
      showToast(`添加附件失败：${errorMessage(error)}`)
    } finally {
      attachmentBusy.current = false
      setAddingAttachments(false)
    }
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.stopPropagation()
    dragDepth.current = 0
    setDragging(false)
    if (disabled || sending) return
    void addAttachments([...event.dataTransfer.files], true)
  }

  const canEnhance = !remote && !disabled && !enhancing && draft.trim() !== '' && !draft.trimStart().startsWith('/')
  const enhance = async () => {
    if (!canEnhance) return
    const original = draft
    const tokens = mentions.map(({ token }) => token)
    setEnhancing(true)
    try {
      const result = await window.diffra.enhancePrompt({
        text: original,
        project: props.projectPath,
        sessionId: props.mcpTarget && 'sessionId' in props.mcpTarget ? props.mcpTarget.sessionId : null,
        model: props.modelRef,
        mentions: tokens,
        design: props.draftKey.startsWith('design:'),
      })
      // 等结果的时候又改了草稿：不覆盖用户刚写的
      if (draftRef.current !== original) return showToast('优化期间草稿改过了，没有替换')
      const lost = tokens.filter((token) => !result.prompt.includes(token))
      if (lost.length > 0) return showToast(`优化结果里少了附件 ${lost.join('、')}，没有替换`)
      replaceDraft(result.prompt, '撤销优化')
      setQuestions((current) => ({ key: current.key + 1, items: result.questions }))
    } catch (error) {
      showToast(`优化失败：${errorMessage(error)}`)
    } finally {
      setEnhancing(false)
    }
  }

  const send = async (raw = false) => {
    if (!(raw ? ready : canSend) || attachmentBusy.current) return
    if (props.planMode && images.length > 0) return showToast('出计划暂时不能带图片，请移除图片或计划标签后再发送')
    if (images.length > 0 && imagesSupported === false) return showToast('当前模型没有打开「视觉」，发不了图片。确认模型支持视觉后，到「设置 → 模型与角色」里，在这个模型的「配置能力」中打开「视觉」')
    setSending(true)
    try {
      const text = promptWithFileReferences(draft.trim(), fileReferences.map(({ mention: _mention, ...file }) => file))
      const sentImages = images.map(({ id: _id, mention: _mention, ...image }) => image)
      if (await onSend(text === '' ? IMAGE_ONLY_PROMPT : text, { goal, skills: skills.map((skill) => skill.name), images: sentImages })) {
        setDraft('')
        setCaret(0)
        setGoal(false)
        setSkills([])
        setImages([])
        setFileReferences([])
        setQuestions((current) => ({ ...current, items: [] }))
        clearComposerDraft(props.draftKey)
      }
    } catch (error) {
      showToast(`发送失败：${errorMessage(error)}`)
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    if (menuOpen && event.key === 'Escape') {
      event.preventDefault()
      setDismissed(token.start)
      return
    }
    if (menuOpen && items.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        setActive((current) => (current + step + items.length) % items.length)
        return
      }
      if ((event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault()
        const item = items[Math.min(active, items.length - 1)]
        if (item) choose(item)
        return
      }
    }
    // 光标在最前面时退格删掉最后一个标签
    const target = event.currentTarget
    if (event.key === 'Backspace' && target.selectionStart === 0 && target.selectionEnd === 0 && (skills.length > 0 || goal || props.planMode)) {
      event.preventDefault()
      if (skills.length > 0) setSkills((current) => current.slice(0, -1))
      else if (goal) setGoal(false)
      else changePlanMode(false)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send(event.ctrlKey || event.metaKey)
    }
  }

  return (
    <div
      className={cn(
        'relative flex flex-col border border-input bg-card focus-within:border-ring/60 dark:border-input/50 dark:focus-within:border-ring',
        large ? 'rounded-2xl shadow-composer' : 'rounded-2xl',
        // primary-color-allow: 用户正在拖放文件
        dragging && 'border-primary/60 bg-primary/5 dark:border-primary/60',
      )}
      data-testid="composer"
      aria-busy={addingAttachments}
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        dragDepth.current++
        if (!disabled && !sending) setDragging(true)
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        event.dataTransfer.dropEffect = disabled || sending ? 'none' : 'copy'
      }}
      onDragLeave={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current <= 0) setDragging(false)
      }}
      onDrop={onDrop}
    >
      {/* primary-color-allow: 用户正在拖放文件 */}
      {dragging && <div className="pointer-events-none absolute inset-1 z-40 flex items-center justify-center rounded-xl border border-dashed border-primary/40 bg-card/95 text-sm text-primary" data-testid="composer-drop-zone">松开以添加文件或文件夹</div>}
      {/* 处理附件的提示只给读屏，界面上由发送按钮转圈表示，不插新行，免得输入框跳高 */}
      {addingAttachments && <p role="status" className="sr-only">正在添加附件…</p>}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        data-testid="composer-file-input"
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])]
          event.currentTarget.value = ''
          if (files.length > 0) void addAttachments(files, true)
        }}
      />
      {menuOpen && (
        <div
          ref={listRef}
          id="composer-slash-menu"
          role="listbox"
          aria-label="命令和 Skill"
          className={cn(
            'absolute left-0 z-30 max-h-80 w-full overflow-y-auto rounded-xl border bg-popover p-1 text-popover-foreground shadow-overlay',
            // 首页输入框上面是标题，向下展开不盖住它；任务页输入框贴底，只能向上
            large ? 'top-full mt-2' : 'bottom-full mb-2 max-w-[480px]',
          )}
        >
          {items.map((item, index) => (
            <div key={item.key}>
              {(index === 0 || items[index - 1]?.group !== item.group) && (
                <div className="px-2.5 pt-2 pb-1 text-xs text-muted-foreground">{item.group}</div>
              )}
              <div
                id={`composer-option-${index}`}
                role="option"
                aria-selected={index === active}
                className={cn('flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-1.5', index === active && 'bg-accent')}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(item)}
              >
                <item.icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="shrink-0">{item.label}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{item.description}</span>
                {item.badge && <span className="shrink-0 text-xs text-muted-foreground">{item.badge}</span>}
              </div>
            </div>
          ))}
          {listLoading ? (
            <div className="flex min-h-8 items-center gap-2.5 px-2.5 text-xs text-muted-foreground">
              <LoaderCircle className="size-4 shrink-0 animate-spin" />
              正在读取 Skill 和命令…
            </div>
          ) : (
            items.length === 0 && <div className="flex min-h-8 items-center px-2.5 text-xs text-muted-foreground">没有匹配的命令或 Skill</div>
          )}
        </div>
      )}
      {images.length > 0 && (
        <div className={cn('flex flex-wrap gap-2', large ? 'px-4.5 pt-3.5' : 'px-3.5 pt-2.5')}>
          {images.map((image, index) => (
            <div key={image.id} className="relative" data-testid="composer-image">
              <button type="button" aria-label={`预览图片 ${index + 1}`} className="block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setPreview({ kind: 'image', image })}>
                <img src={imageUrl(image)} alt={`图片 ${index + 1}`} className="size-14 rounded-lg border object-cover" />
              </button>
              <button
                type="button"
                aria-label={`移除图片 ${index + 1}`}
                className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-overlay hover:text-foreground"
                onClick={() => removeImage(image)}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {fileReferences.length > 0 && <div className={cn('flex flex-wrap gap-2', large ? 'px-4.5 pt-3.5' : 'px-3.5 pt-2.5')}>
        {fileReferences.map((file) => <div key={file.path} title={file.path} className="flex max-w-full items-center gap-2 rounded-lg border bg-muted/40 py-1.5 pr-1 pl-2.5 text-xs" data-testid="composer-file">
          <button type="button" aria-label={`预览附件 ${file.name}`} className="flex min-w-0 items-center gap-2 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setPreview({ kind: 'file', file })}>
            {file.kind === 'directory' ? <Folder className="size-4 shrink-0 text-muted-foreground" /> : <FileIcon className="size-4 shrink-0 text-muted-foreground" />}
            <span className="max-w-52 truncate">{file.name}</span><span className="text-muted-foreground">{file.kind === 'directory' ? '文件夹' : '文件'}</span>
          </button>
          <button type="button" aria-label={`移除附件 ${file.name}`} className="rounded-sm p-1 hover:bg-muted" onClick={() => removeFile(file)}><X className="size-3" /></button>
        </div>)}
      </div>}
      {(props.planMode || goal || skills.length > 0) && (
        <div className={cn('flex flex-wrap gap-1.5', large ? 'px-4.5 pt-3.5' : 'px-3.5 pt-2.5')} data-testid="composer-chips">
          {props.planMode && <Chip icon={ListChecks} label="计划" removeLabel="移除计划" onRemove={() => changePlanMode(false)} />}
          {goal && <Chip icon={Target} label={`目标${goalRounds ? ` · 最多 ${goalRounds} 轮` : ''}`} removeLabel="移除目标" onRemove={() => setGoal(false)} />}
          {skills.map((skill) => (
            <Chip
              key={skill.name}
              icon={Sparkles}
              label={skill.name}
              removeLabel={`移除 Skill ${skill.name}`}
              onRemove={() => setSkills((current) => current.filter((item) => item.name !== skill.name))}
            />
          ))}
        </div>
      )}
      {questions.items.length > 0 && (
        <div className={cn('flex flex-col gap-1.5 border-b pb-2.5', large ? 'px-4.5 pt-3.5' : 'px-3.5 pt-2.5')} data-testid="composer-questions">
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>优化时按选中的答案写的；选别的只改提示词里对应的那一行</span>
            <button type="button" aria-label="收起问题" className="rounded-sm p-0.5 hover:bg-accent hover:text-foreground" onClick={() => setQuestions((current) => ({ ...current, items: [] }))}>
              <X className="size-3.5" />
            </button>
          </div>
          <QuestionBar
            key={questions.key}
            questions={questions.items}
            text={draft}
            onChange={(text) => {
              setDraft(text)
              // 换答案不算手动改：「撤销优化」还能回到优化前
              setUndo((current) => current && { ...current, after: text })
            }}
          />
        </div>
      )}
      <div className="relative">
        {/* 着色层只画文字颜色和背景，不加内外边距，换行位置才和下面的 textarea 一致 */}
        <div aria-hidden className={cn('pointer-events-none absolute inset-0 overflow-hidden', composing && 'text-transparent')}>
          <div className={cn('composer-highlight w-full pr-[calc(0.625rem+10px)] whitespace-pre-wrap break-words', textLayout)} style={{ transform: `translateY(-${scrollTop}px)` }}>
            {draft === '' ? !composing && <span className="text-muted-foreground">{placeholder}</span> : highlightDraft(draft, mentions, composing)}
          </div>
        </div>
        <textarea
          ref={textareaRef}
          aria-label="任务"
          aria-controls={menuOpen ? 'composer-slash-menu' : undefined}
          aria-activedescendant={menuOpen && items.length > 0 ? `composer-option-${active}` : undefined}
          rows={large ? 4 : 2}
          autoFocus
          spellCheck={false}
          value={draft}
          placeholder={placeholder}
          onChange={(event) => {
            setDraft(event.target.value)
            setCaret(event.target.selectionStart)
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onClick={(event) => setPreview(previewAt(event.currentTarget.value, event.currentTarget.selectionStart))}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            // 图片直接缩小；从文件管理器复制来的文件如果拿得到本地路径，也当作附件
            const files = [...event.clipboardData.files]
            if (files.length === 0) return
            event.preventDefault()
            void addAttachments(files, true)
          }}
          className={cn(
            'relative block w-full resize-none bg-transparent pr-2.5 outline-none [scrollbar-gutter:stable] placeholder:text-transparent',
            textLayout,
            composing ? 'text-foreground' : 'text-transparent caret-foreground',
          )}
        />
      </div>
      {/* 底栏内边距加触发器的 px-2 等于输入框的 px，图标和占位符左缘对齐。
          不换行：输入框窄时（如设计任务的对话栏）模型名截断，发送/停止按钮始终在同一行 */}
      <div className={cn('flex items-center gap-2 pt-1.5 pb-2.5', large ? 'px-2.5' : 'pr-2.5 pl-1.5')}>
        {props.leading}
        <PermissionModeMenu mode={props.permissionMode} onChange={props.onPermissionModeChange} />
        {undo && (
          <button
            type="button"
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            data-testid="composer-undo"
            onClick={() => {
              setDraft(undo.before)
              setUndo(null)
              setQuestions((current) => ({ ...current, items: [] }))
              textareaRef.current?.focus()
            }}
          >
            <Undo2 className="size-3.5" />
            {undo.label}
          </button>
        )}

        <div className="flex-1" />
        {!remote && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="优化提示词"
                disabled={!canEnhance}
                className={cn(MENU_TRIGGER, 'shrink-0 px-1.5 text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent')}
                onClick={() => void enhance()}
              >
                {enhancing ? <LoaderCircle className="size-4 animate-spin" /> : <WandSparkles className="size-4" />}
              </button>
            </TooltipTrigger>
            <TooltipContent>优化提示词：写得更具体，并列出需要你定的地方</TooltipContent>
          </Tooltip>
        )}
        <ModelMenu label={props.modelLabel} modelRef={props.modelRef} locked={props.modelLocked} onChange={props.onModelChange} />
        <ArgumentsDialog
          request={argumentsRequest?.request ?? null}
          onCancel={() => setArgumentsRequest(null)}
          onSubmit={(args) => {
            argumentsRequest?.submit(args)
            setArgumentsRequest(null)
          }}
        />
        {running && !hasMessage ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="停止"
                className={cn(SEND_BUTTON, 'bg-secondary text-secondary-foreground inset-ring inset-ring-input hover:bg-accent')}
                onClick={onStop}
              >
                <Square className="size-3 fill-current" />
              </button>
            </TooltipTrigger>
            <TooltipContent>停止</TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={running ? '排队发送' : '发送'}
                disabled={!canSend}
                // primary-color-allow: 下一步动作：发送
                className={cn(SEND_BUTTON, 'bg-primary text-primary-foreground enabled:hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground/50 disabled:inset-ring disabled:inset-ring-input')}
                onClick={() => void send()}
              >
                {addingAttachments ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" strokeWidth={2.4} />}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {running ? '排队发送' : '发送'} <Kbd>Enter</Kbd> · 换行 <Kbd>Shift+Enter</Kbd>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      <AttachmentPreview preview={preview} onClose={() => setPreview(null)} />
    </div>
  )
}

// 输入框里的附件缩略图、文件标签和 @token 点开后看大图或路径
function AttachmentPreview({ preview, onClose }: { preview: PreviewTarget | null; onClose(): void }) {
  return (
    <Dialog open={preview !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={cn(preview?.kind === 'image' && 'max-w-[90vw] sm:max-w-[90vw]')}>
        {preview?.kind === 'image' && (
          <>
            <DialogTitle>图片预览</DialogTitle>
            <img src={imageUrl(preview.image)} alt="附件图片" className="max-h-[75vh] w-auto max-w-full self-center rounded-lg object-contain" data-testid="composer-image-preview" />
            <DialogDescription className="text-center">{preview.image.mention}</DialogDescription>
          </>
        )}
        {preview?.kind === 'file' && (
          <>
            <DialogTitle className="flex items-center gap-2 break-all">
              {preview.file.kind === 'directory' ? <Folder className="size-5 shrink-0" /> : <FileText className="size-5 shrink-0" />}
              {preview.file.name}
            </DialogTitle>
            <DialogDescription className="break-all">{preview.file.path}</DialogDescription>
            <p className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              {preview.file.kind === 'directory' ? '文件夹' : '文件'}只以路径引用发送，模型需要时用文件工具读取；项目外路径需要授权。
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

const FOCUS_RING = 'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card'
const SEND_BUTTON = cn('flex size-8 shrink-0 items-center justify-center rounded-full transition-colors', FOCUS_RING)
// 底栏的权限和模型触发器：无边框 ghost，菜单打开时保持高亮
const MENU_TRIGGER = cn('flex h-7 items-center gap-1.5 rounded-md px-2 text-sm hover:bg-accent aria-expanded:bg-accent', FOCUS_RING)

function Chip({ icon: Icon, label, removeLabel, onRemove }: { icon: LucideIcon; label: string; removeLabel: string; onRemove(): void }) {
  return (
    <span className="flex h-6.5 items-center gap-1 rounded-md border bg-muted/40 pr-0.5 pl-1.5 text-xs text-foreground" data-testid="composer-chip">
      <Icon className="size-3.5" />
      {label}
      <button type="button" aria-label={removeLabel} className="flex size-5 items-center justify-center rounded-sm hover:bg-muted" onClick={onRemove}>
        <X className="size-3" />
      </button>
    </span>
  )
}

// 菜单打开时读一次任务或项目的 Skill 和自定义命令，文件改过下次打开就是新的
function useProjectList<T>(target: McpStatusTarget | null, load: (target: McpStatusTarget) => Promise<T[]>, failure: string): T[] | null {
  const [items, setItems] = useState<T[] | null>(null)
  const loadRef = useRef(load)
  loadRef.current = load
  const key = target ? JSON.stringify(target) : null
  useEffect(() => {
    if (key === null) return
    let stale = false
    loadRef.current(JSON.parse(key) as McpStatusTarget).then(
      (list) => !stale && setItems(list),
      (error: unknown) => {
        console.error(failure, error)
        // 读失败也要结束斜杠菜单的「正在读取」，之前读到的列表保留
        if (!stale) setItems((current) => current ?? [])
      },
    )
    return () => {
      stale = true
    }
  }, [key, failure])
  return items
}

const PERMISSION_ICONS: Record<PermissionMode, LucideIcon> = { ask: Shield, auto: ShieldCheck, full: ShieldAlert }

function PermissionModeMenu({ mode, onChange }: { mode: PermissionMode; onChange(mode: PermissionMode): void }) {
  const TriggerIcon = PERMISSION_ICONS[mode]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="命令权限模式"
          data-testid="permission-mode"
          // 底栏不换行，窄的时候只让模型名截断，权限这里保持完整
          className={cn(MENU_TRIGGER, 'shrink-0 whitespace-nowrap', mode === 'full' ? 'text-destructive' : 'text-muted-foreground hover:text-foreground aria-expanded:text-foreground')}
        >
          <TriggerIcon className="size-3.5" />
          {permissionModeLabel(mode)}
          <ChevronDown className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[22rem]">
        <DropdownMenuRadioGroup value={mode}>
          {PERMISSION_MODES.map((item) => {
            const Icon = PERMISSION_ICONS[item.mode]
            return (
              <DropdownMenuRadioItem key={item.mode} value={item.mode} className="items-start gap-2.5 py-2 data-[state=checked]:not-focus:bg-soft *:data-[slot=dropdown-menu-radio-item-indicator]:mt-0.5" onSelect={() => onChange(item.mode)}>
                <Icon className={cn('mt-0.5', item.mode === 'full' && 'text-destructive')} />
                <div className="min-w-0 flex-1">
                  <div className={cn(item.mode === 'full' && 'text-destructive')}>{item.label}</div>
                  <div className="truncate text-xs text-muted-foreground">{item.summary}</div>
                </div>
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// 模型多于这么多个时，列表上方出搜索框
const SEARCH_THRESHOLD = 8

// trigger：换掉默认的按钮（停下说明里的「换模型继续」）；modelsOnly：只列模型，不出思考程度。
// 参照 Qoder（第 532 步）：按钮写模型和思考程度；点开两行「模型」「推理等级」，各自展开子菜单。
// 换模型时用这个模型上次选的思考程度，选了思考程度就记下来（第 531 步）
export function ModelMenu({
  label,
  modelRef,
  locked,
  onChange,
  trigger,
  modelsOnly,
}: {
  label: string | null
  modelRef?: ModelRef
  locked?: boolean
  onChange(ref: ModelRef): void
  trigger?: ReactNode
  modelsOnly?: boolean
}) {
  // 远程任务换成对方的模型服务；对方的模型不记思考程度
  const remote = useRemoteTask()
  const settings = useAppState((state) => state.settings)
  const providers = remote ? (remote.providers ?? null) : (settings?.providers ?? null)
  const selectedProvider = providers?.find((provider) => provider.id === modelRef?.providerId)
  const selectedModel = selectedProvider?.models.find((model) => model.id === modelRef?.modelId)
  const efforts = selectedProvider && selectedModel ? reasoningEffortsFor(selectedProvider, selectedModel) : ['default' as const]
  const supportsReasoning = efforts.length > 1
  const requestedEffort = modelRef?.reasoningEffort ?? 'default'
  const effort = efforts.includes(requestedEffort) ? requestedEffort : 'default'
  const icons = useLobeIcons()
  const selectedModelId = modelRef?.modelId
  const [query, setQuery] = useState('')
  // 输入框每次按键都会重渲染，按名称匹配服务图标要扫一遍图标清单，触发按钮上的结果缓存起来
  const selectedIcon = useMemo(
    () => (icons && selectedProvider && selectedModelId ? (icons.matchModelIcon(selectedModelId) ?? icons.matchProviderIcon(selectedProvider)) : null),
    [icons, selectedProvider, selectedModelId],
  )
  const modelName = label ? (selectedModel ? modelDisplayName(selectedModel) : label) : '未配置'
  const enabled = (providers ?? []).flatMap((provider) => provider.models.filter((model) => model.enabled !== false).map((model) => ({ provider, model })))
  const words = query.trim().toLowerCase()
  const matches = (provider: { name: string }, model: { id: string }) =>
    !words || model.id.toLowerCase().includes(words) || modelDisplayName(model as Parameters<typeof modelDisplayName>[0]).toLowerCase().includes(words) || provider.name.toLowerCase().includes(words)
  const noMatch = words !== '' && enabled.length > 0 && !enabled.some(({ provider, model }) => matches(provider, model))
  const chooseModel = (ref: ModelRef) => onChange(remote || !settings ? ref : withRememberedEffort(ref, settings.providers, settings.reasoningChoices))
  const chooseEffort = (next: ReasoningEffort) => {
    if (locked || !modelRef) return
    const ref = { ...modelRef, reasoningEffort: next }
    onChange(ref)
    if (!remote) void rememberReasoning(ref)
  }

  const modelList = (
    <>
      {enabled.length > SEARCH_THRESHOLD && (
        <div className="px-1 pb-1" onKeyDown={(event) => event.key !== 'Escape' && event.stopPropagation()}>
          <input
            aria-label="搜索模型"
            value={query}
            placeholder="搜索模型"
            className="h-8 w-full rounded-md border bg-background px-2 text-sm outline-none focus:border-ring/60"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      )}
      <div className="max-h-80 overflow-y-auto">
        {providers?.map((provider) => {
          const models = provider.models.filter((model) => model.enabled !== false && matches(provider, model))
          if (models.length === 0) return null
          const providerIcon = icons && icons.matchProviderIcon(provider)
          return (
            <div key={provider.id}>
              {/* 分组标题只写供应商名，不带图标；模型自己的图标在每一行 */}
              <DropdownMenuLabel className="truncate pt-2 pb-1 text-xs font-normal text-muted-foreground">{provider.name}</DropdownMenuLabel>
              {models.map((model) => {
                const selected = modelRef?.providerId === provider.id && modelRef.modelId === model.id
                // 上下文、视觉放在右边，一眼能比
                const detail = [model.contextWindow ? formatTokens(model.contextWindow) : null, model.images ? '视觉' : null].filter((part): part is string => part !== null).join(' · ')
                return (
                  <DropdownMenuItem
                    key={model.id}
                    title={model.id}
                    // primary-color-allow: 选中模型的底色，表示当前选择
                    className={cn('items-center gap-2.5', selected && 'bg-soft focus:bg-soft')}
                    onSelect={() => chooseModel({ providerId: provider.id, modelId: model.id })}
                  >
                    <BrandIcon id={(icons && icons.matchModelIcon(model.id)) ?? providerIcon} fallbackText={provider.name} size={16} className="size-4" />
                    <span className="min-w-0 flex-1 truncate">{modelDisplayName(model)}</span>
                    {detail && <span className="shrink-0 text-xs text-muted-foreground">{detail}</span>}
                    {/* primary-color-allow: 选中标记 */}
                    <Check className={cn('size-4 shrink-0 text-primary', selected ? 'visible' : 'invisible')} />
                  </DropdownMenuItem>
                )
              })}
            </div>
          )
        })}
        {providers?.length === 0 && <p className="px-2 py-1.5 text-sm text-muted-foreground">还没有配置模型</p>}
        {noMatch && <p className="px-2 py-1.5 text-sm text-muted-foreground">没有匹配的模型</p>}
      </div>
      {/* 分隔线带负的左右外边距，放在滚动区外面：放在里面会比滚动区宽，出横向滚动条（第 532 步） */}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => openSettings('models')}>
        <Settings2 />
        模型与角色…
      </DropdownMenuItem>
    </>
  )

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) return
        setQuery('')
        if (remote) remote.loadProviders?.()
        else void refreshSettings()
      }}
    >
      <DropdownMenuTrigger asChild>
        {trigger ?? (
          <button
            type="button"
            aria-label={supportsReasoning ? `模型 ${modelName}，思考程度 ${effort}` : `模型 ${modelName}`}
            data-testid="model-menu"
            disabled={locked}
            title={locked ? '运行中不能切换模型' : undefined}
            className={cn(MENU_TRIGGER, 'max-w-72 min-w-0 text-muted-foreground hover:text-foreground disabled:opacity-80 aria-expanded:text-foreground')}
          >
            {label && <BrandIcon id={selectedIcon} fallbackText={selectedProvider?.name ?? label} size={16} className="size-4" />}
            <span className="truncate text-foreground">{modelName}</span>
            {label && supportsReasoning && (
              <span className="shrink-0" data-testid="reasoning-label">
                {effort}
              </span>
            )}
            <ChevronUp className="size-3 shrink-0" />
          </button>
        )}
      </DropdownMenuTrigger>
      {modelsOnly || !modelRef ? (
        <DropdownMenuContent align="end" className="w-72" data-testid="model-panel">
          {modelList}
        </DropdownMenuContent>
      ) : (
        <DropdownMenuContent align="end" side="top" className="w-64" data-testid="model-panel">
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-3">
              <span className="shrink-0">模型</span>
              <span className="ml-auto flex min-w-0 items-center gap-1.5 text-muted-foreground">
                <BrandIcon id={selectedIcon} fallbackText={selectedProvider?.name ?? label ?? ''} size={14} className="size-3.5" />
                <span className="truncate">{modelName}</span>
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-72" data-testid="model-list">
              {modelList}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-3" disabled={!supportsReasoning}>
              <span className="shrink-0">推理等级</span>
              <span className="ml-auto truncate text-muted-foreground">{supportsReasoning ? effort : '不支持'}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-40" data-testid="reasoning-list">
              {efforts.map((item) => (
                <DropdownMenuItem key={item} className="items-center" onSelect={() => chooseEffort(item)}>
                  <span className="flex-1">{item}</span>
                  {/* primary-color-allow: 选中标记 */}
                  <Check className={cn('size-4 shrink-0 text-primary', item === effort ? 'visible' : 'invisible')} />
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  )
}
