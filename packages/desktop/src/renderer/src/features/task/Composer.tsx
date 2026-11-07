import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CommandInfo, PermissionMode, SkillInfo, SkillSource } from '@diffra/core/types'
import { ArrowUp, Check, ChevronDown, Cpu, ListChecks, type LucideIcon, Plug, Shield, Sparkles, Square, SquareSlash, Target, X } from 'lucide-react'
import type { McpStatusTarget } from '../../../../shared/ipc'
import type { ModelRef } from '../../../../shared/settings'
import { cn } from 'cn'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useMcpStatus } from '@/features/mcp/useMcpStatus'
import { errorMessage } from '@/lib/errors'
import { formatTokens } from '@/lib/format'
import { PERMISSION_MODES, permissionModeLabel } from '@/lib/permission-modes'
import { openSettings, refreshSettings } from '@/state/actions'
import { ArgumentsDialog, type ArgumentsRequest } from './ArgumentsDialog'
import { showToast, useAppState } from '@/state/store'

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
  placeholder: string
  // 没准备好（没选项目、会话没建好）时不能发送
  disabled?: boolean
  running?: boolean
  // 斜杠菜单从这个项目读 Skill
  projectPath: string | null
  // 斜杠菜单从这里读 MCP prompt
  mcpTarget: McpStatusTarget | null
  commands?: ComposerCommand[]
  permissionMode: PermissionMode
  onPermissionModeChange(mode: PermissionMode): void
  modelLabel: string | null
  modelLocked?: boolean
  onModelChange(ref: ModelRef): void
  // 开着时发的消息先由规划模型出计划，不改代码
  planMode: boolean
  onPlanModeChange(planMode: boolean): void
  // 返回 false 表示没发出去，输入框里的内容和选的目标、Skill 保留
  onSend(text: string, extras: { goal: boolean; skills: string[] }): boolean | Promise<boolean>
  onStop?(): void
}

const SOURCE_LABELS: Record<SkillSource, string> = { project: '项目', user: '用户', plugin: '插件', claude: 'Claude', codex: 'Codex' }

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

export function Composer(props: ComposerProps) {
  const { size, placeholder, disabled, running, onSend, onStop } = props
  const goalRounds = useAppState((state) => state.settings?.execution.goalMaxRounds ?? null)
  const [draft, setDraft] = useState('')
  const [caret, setCaret] = useState(0)
  const [sending, setSending] = useState(false)
  const [goal, setGoal] = useState(false)
  const [skills, setSkills] = useState<SkillInfo[]>([])
  // 按了 Esc 的那个「/」，换一个再打开
  const [dismissed, setDismissed] = useState<number | null>(null)
  const [active, setActive] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // 选完菜单项后光标要放回的位置；输入框内容更新后立刻放，晚了会和接着输入的字抢
  const pendingCaret = useRef<number | null>(null)
  const canSend = !disabled && !sending && draft.trim() !== ''

  const token = disabled ? null : slashToken(draft, caret)
  const menuOpen = token !== null && token.start !== dismissed
  const tokenStart = token?.start ?? null
  useEffect(() => {
    if (tokenStart === null) setDismissed(null)
  }, [tokenStart])
  const available = useProjectList(menuOpen ? props.projectPath : null, (path) => window.diffra.listSkills(path), '读取 Skill 失败')
  const commandList = useProjectList(menuOpen ? props.projectPath : null, (path) => window.diffra.listCommands(path), '读取自定义命令失败')
  const mcp = useMcpStatus(menuOpen ? props.mcpTarget : null)
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
          if (prompt.arguments.length === 0) return void insertAt(at, mcpPrompt(server.name, prompt.name, {}), '展开 MCP prompt 失败')
          setArgumentsRequest({
            request: {
              title: `${server.name}:${prompt.name}`,
              description: prompt.description,
              arguments: prompt.arguments.map((arg) => ({ name: arg.name, label: arg.name, hint: arg.description, required: arg.required })),
            },
            submit: (args) => void insertAt(at, mcpPrompt(server.name, prompt.name, args), '展开 MCP prompt 失败'),
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

  const send = async () => {
    if (!canSend) return
    setSending(true)
    try {
      if (await onSend(draft.trim(), { goal, skills: skills.map((skill) => skill.name) })) {
        setDraft('')
        setCaret(0)
        setGoal(false)
        setSkills([])
      }
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
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
      if (event.key === 'Escape') {
        event.preventDefault()
        setDismissed(token.start)
        return
      }
    }
    // 光标在最前面时退格删掉最后一个标签
    const target = event.currentTarget
    if (event.key === 'Backspace' && target.selectionStart === 0 && target.selectionEnd === 0 && (skills.length > 0 || goal)) {
      event.preventDefault()
      if (skills.length > 0) setSkills((current) => current.slice(0, -1))
      else setGoal(false)
      return
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      void send()
    }
  }

  const large = size === 'large'
  return (
    <div
      className={cn(
        'relative flex flex-col border border-input bg-background focus-within:border-ring/60',
        large ? 'rounded-2xl shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.04)]' : 'rounded-[14px]',
      )}
    >
      {menuOpen && items.length > 0 && (
        <div
          ref={listRef}
          id="composer-slash-menu"
          role="listbox"
          aria-label="命令和 Skill"
          className="absolute bottom-full left-0 z-30 mb-2 max-h-80 w-full max-w-[480px] overflow-y-auto rounded-xl bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10"
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
                <span className="shrink-0 font-medium">{item.label}</span>
                <span className="min-w-0 flex-1 truncate text-[0.86rem] text-muted-foreground">{item.description}</span>
                {item.badge && <span className="shrink-0 rounded border px-1 text-[0.72rem] text-muted-foreground">{item.badge}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
      {(goal || skills.length > 0) && (
        <div className={cn('flex flex-wrap gap-1.5', large ? 'px-4 pt-3.5' : 'px-3 pt-2.5')} data-testid="composer-chips">
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
      <textarea
        ref={textareaRef}
        aria-label="任务"
        aria-controls={menuOpen ? 'composer-slash-menu' : undefined}
        aria-activedescendant={menuOpen && items.length > 0 ? `composer-option-${active}` : undefined}
        rows={large ? 4 : 2}
        autoFocus
        value={draft}
        placeholder={placeholder}
        onChange={(event) => {
          setDraft(event.target.value)
          setCaret(event.target.selectionStart)
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        className={cn(
          'max-h-[40vh] resize-none bg-transparent outline-none placeholder:text-muted-foreground',
          large ? 'px-4.5 pt-4 pb-2 text-[1.07rem]' : 'px-3.5 pt-3 pb-1',
        )}
      />
      <div className="flex flex-wrap items-center gap-2 px-2.5 pt-1.5 pb-2.5">
        <PermissionModeMenu mode={props.permissionMode} onChange={props.onPermissionModeChange} />
        <button
          type="button"
          aria-pressed={props.planMode}
          title="开着时，发的消息先由规划模型只读地看代码、出一份计划，你确认后再改代码"
          className={cn(
            'flex h-7.5 items-center gap-1.5 rounded-full border px-2.5 text-[0.93rem] hover:bg-muted',
            props.planMode ? 'border-primary/50 bg-primary/10 text-primary hover:bg-primary/15' : 'text-foreground/80',
          )}
          onClick={() => changePlanMode(!props.planMode)}
        >
          <ListChecks className="size-3.5" />
          先出计划
        </button>
        <div className="flex-1" />
        <ModelMenu label={props.modelLabel} locked={props.modelLocked} onChange={props.onModelChange} />
        <ArgumentsDialog
          request={argumentsRequest?.request ?? null}
          onCancel={() => setArgumentsRequest(null)}
          onSubmit={(args) => {
            argumentsRequest?.submit(args)
            setArgumentsRequest(null)
          }}
        />
        {running && draft.trim() === '' ? (
          <button
            type="button"
            aria-label="停止"
            title="停止"
            className="flex size-8 items-center justify-center rounded-full bg-foreground text-background"
            onClick={onStop}
          >
            <Square className="size-3.5 fill-current" />
          </button>
        ) : (
          <button
            type="button"
            aria-label={running ? '排队发送' : '发送'}
            title={running ? '这一轮结束后发送' : '发送 Ctrl+Enter'}
            disabled={!canSend}
            className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"
            onClick={() => void send()}
          >
            <ArrowUp className="size-4" strokeWidth={2.4} />
          </button>
        )}
      </div>
    </div>
  )
}

function Chip({ icon: Icon, label, removeLabel, onRemove }: { icon: LucideIcon; label: string; removeLabel: string; onRemove(): void }) {
  return (
    <span className="flex h-6.5 items-center gap-1 rounded-md border border-primary/30 bg-primary/10 pr-0.5 pl-1.5 text-[0.86rem] text-primary" data-testid="composer-chip">
      <Icon className="size-3.5" />
      {label}
      <button type="button" aria-label={removeLabel} className="flex size-5 items-center justify-center rounded hover:bg-primary/15" onClick={onRemove}>
        <X className="size-3" />
      </button>
    </span>
  )
}

// 菜单打开时读一次项目的 Skill 和自定义命令，文件改过下次打开就是新的
function useProjectList<T>(projectPath: string | null, load: (path: string) => Promise<T[]>, failure: string): T[] | null {
  const [items, setItems] = useState<T[] | null>(null)
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    if (!projectPath) return
    let stale = false
    loadRef.current(projectPath).then(
      (list) => !stale && setItems(list),
      (error: unknown) => console.error(failure, error),
    )
    return () => {
      stale = true
    }
  }, [projectPath, failure])
  return items
}

function PermissionModeMenu({ mode, onChange }: { mode: PermissionMode; onChange(mode: PermissionMode): void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="命令权限模式"
          data-testid="permission-mode"
          className={cn(
            'flex h-7.5 items-center gap-1.5 rounded-full border px-2.5 text-[0.93rem] hover:bg-muted',
            mode === 'full' ? 'border-destructive/40 text-destructive' : 'text-foreground/80',
          )}
        >
          <Shield className="size-3.5" />
          {permissionModeLabel(mode)}
          <ChevronDown className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        {PERMISSION_MODES.map((item) => (
          <DropdownMenuItem key={item.mode} className="items-start gap-2 py-2" onSelect={() => onChange(item.mode)}>
            <div className="min-w-0 flex-1">
              <div className={cn('font-medium', item.mode === 'full' && 'text-destructive')}>{item.label}</div>
              <div className="text-xs leading-relaxed whitespace-normal text-muted-foreground">{item.description}</div>
            </div>
            {item.mode === mode && <Check className="mt-0.5 size-4 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ModelMenu({ label, locked, onChange }: { label: string | null; locked?: boolean; onChange(ref: ModelRef): void }) {
  const providers = useAppState((state) => state.settings?.providers ?? null)
  return (
    <DropdownMenu onOpenChange={(open) => open && void refreshSettings()}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="模型"
          data-testid="model-menu"
          disabled={locked}
          title={locked ? '运行中不能切换模型' : '切换模型'}
          className="flex h-7.5 max-w-72 items-center gap-1.5 rounded-full px-2.5 text-[0.93rem] text-foreground/80 hover:bg-muted disabled:opacity-60"
        >
          <Cpu className="size-3.5 shrink-0" />
          <span className="truncate">{label ?? '未选择模型'}</span>
          <ChevronDown className="size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-96 w-72 overflow-y-auto">
        {providers?.map((provider) => (
          <div key={provider.id}>
            <DropdownMenuLabel className="text-xs text-muted-foreground">{provider.name}</DropdownMenuLabel>
            {provider.models.map((model) => (
              <DropdownMenuItem key={model.id} onSelect={() => onChange({ providerId: provider.id, modelId: model.id })}>
                <span className="min-w-0 flex-1 truncate">{model.id}</span>
                {model.contextWindow && <span className="text-xs text-muted-foreground">{formatTokens(model.contextWindow)}</span>}
                <Check className={cn('size-4 text-primary', label === `${provider.name} / ${model.id}` ? 'visible' : 'invisible')} />
              </DropdownMenuItem>
            ))}
          </div>
        ))}
        {providers?.length === 0 && <p className="px-2 py-1.5 text-sm text-muted-foreground">还没有配置模型</p>}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openSettings('models')}>模型管理…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
