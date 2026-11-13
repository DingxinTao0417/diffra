import type { ComponentProps, ReactNode } from 'react'
import type { PluginHookInfo, PluginInfo } from '@diffra/core/types'
import { cn } from 'cn'
import { Badge } from '@/components/ui/badge'

// 目录和已安装列表的一行：字母头像、名字和来源、一行说明，右边放操作；展开的内容占满整行
export function ExtensionRow({
  initial,
  dark = false,
  name,
  badge,
  detail,
  actions,
  children,
  wide = false,
  testId,
}: {
  initial: string
  dark?: boolean
  name: ReactNode
  badge?: string | null
  detail: ReactNode
  actions?: ReactNode
  children?: ReactNode
  wide?: boolean
  testId?: string
}) {
  return (
    <div className={cn('border-t py-3', wide && 'col-span-full')} data-testid={testId}>
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg font-bold', dark ? 'bg-foreground text-background' : 'bg-muted text-foreground')}
        >
          {initial}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-bold">{name}</span>
            {badge && (
              <Badge variant="outline" className="shrink-0 font-normal text-muted-foreground">
                {badge}
              </Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground">{detail}</div>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  )
}

// 行下面展开的面板：和头像右边的文字对齐
export function RowPanel({ children, className, ...props }: ComponentProps<'div'>) {
  return (
    <div className={cn('mt-3 ml-13 space-y-4 rounded-xl bg-muted/60 p-4', className)} {...props}>
      {children}
    </div>
  )
}

export function SectionTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-1 flex min-h-8 items-center justify-between gap-3">
      <h2 className="text-sm font-bold">{children}</h2>
      {actions && <div className="flex items-center gap-1">{actions}</div>}
    </div>
  )
}

const EVENT_LABELS: Record<PluginHookInfo['event'], string> = {
  SessionStart: '会话开始时',
  UserPromptSubmit: '你发消息时',
  PreToolUse: '调用工具前',
  PostToolUse: '调用工具后',
  Stop: '智能体停下前',
}

const TOOL_LABELS: Record<string, string> = { Bash: '执行命令', Edit: '改文件', Write: '新建文件', MultiEdit: '改文件' }

// 钩子在什么时候跑：工具类时机带上匹配的工具（Bash 是执行命令，Edit、Write 是改文件）
export function hookWhen(hook: PluginHookInfo): string {
  const tool = hook.event === 'PreToolUse' || hook.event === 'PostToolUse'
  if (!tool || hook.matcher === '' || hook.matcher === '*') return EVENT_LABELS[hook.event]
  const tools = [...new Set(hook.matcher.split('|').map((name) => TOOL_LABELS[name] ?? name))].join('、')
  return `${EVENT_LABELS[hook.event]}（${tools}）`
}

export function HookList({ hooks }: { hooks: PluginHookInfo[] }) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5" data-testid="plugin-hooks">
      {hooks.map((hook, index) => (
        <div key={index} className="contents">
          <span className="text-xs text-muted-foreground">{hookWhen(hook)}</span>
          <span className="font-mono text-xs break-all">{hook.command}</span>
        </div>
      ))}
    </div>
  )
}

// 插件里有什么：空的类别不写
export function contentsSummary(info: PluginInfo): string {
  const parts: Array<[number, string]> = [
    [info.commands.length, '个命令'],
    [info.skills.length, '个 Skill'],
    [info.agents.length, '个子智能体'],
    [info.mcpServers.length, '个 MCP 服务器'],
    [info.hooks.length, '个钩子'],
  ]
  const shown = parts.filter(([count]) => count > 0).map(([count, unit]) => `${count} ${unit}`)
  return shown.length > 0 ? shown.join(' · ') : '没有可用的命令、Skill、子智能体、钩子或 MCP 服务器'
}

export const initialOf = (name: string) => (name.trim()[0] ?? '?').toUpperCase()
