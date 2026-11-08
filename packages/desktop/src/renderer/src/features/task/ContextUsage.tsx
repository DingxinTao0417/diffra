import { useState } from 'react'
import { Archive, Info } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Usage } from '@/features/session/transcript'
import { errorMessage } from '@/lib/errors'
import { formatTokens } from '@/lib/format'
import { compactTask } from '@/state/actions'
import { showToast } from '@/state/store'

const USAGE_PARTS = [
  { key: 'messages', label: '对话和工具结果', className: 'bg-chart-1' },
  { key: 'system', label: '系统提示词', className: 'bg-chart-2' },
  { key: 'tools', label: '工具定义', className: 'bg-chart-3' },
  { key: 'rules', label: '编码规范和项目规则', className: 'bg-chart-4' },
] as const

const RING_RADIUS = 6
const RING_LENGTH = 2 * Math.PI * RING_RADIUS

export function ContextUsage({ sessionId, usage, running }: { sessionId: string; usage: Usage; running: boolean }) {
  const [open, setOpen] = useState(false)
  const percent = usage.size > 0 ? Math.min(100, Math.round((usage.used / usage.size) * 100)) : 0
  const high = percent >= 80
  const breakdown = usage.breakdown
  // 分项是按字数分摊的估算，加起来不一定正好等于 used，按分项之和归一化才能让四段占满整条
  const breakdownTotal = breakdown ? USAGE_PARTS.reduce((sum, part) => sum + breakdown[part.key], 0) : 0
  const share = (value: number) => {
    if (breakdownTotal <= 0) return '0%'
    const ratio = (value / breakdownTotal) * 100
    return value > 0 && ratio < 1 ? '<1%' : `${Math.round(ratio)}%`
  }

  const compact = () => {
    setOpen(false)
    compactTask(sessionId).catch((error: unknown) => showToast(`压缩失败：${errorMessage(error)}`))
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" className="-my-1 -mr-1.5 gap-1.5 px-1.5 font-normal text-muted-foreground tabular-nums" data-testid="context-usage">
          <svg viewBox="0 0 14 14" className="size-3.5 -rotate-90" aria-hidden>
            <circle cx="7" cy="7" r={RING_RADIUS} fill="none" strokeWidth="2" className="stroke-muted-foreground/30" />
            {percent > 0 && (
              <circle
                cx="7"
                cy="7"
                r={RING_RADIUS}
                fill="none"
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray={RING_LENGTH}
                strokeDashoffset={RING_LENGTH * (1 - percent / 100)}
                className={high ? 'stroke-warning' : 'stroke-muted-foreground'}
              />
            )}
          </svg>
          上下文 {percent}%
        </Button>
      </PopoverTrigger>
      {/* 打开时把焦点放在弹层本身而不是第一个按钮，否则说明图标拿到焦点会直接弹出 tooltip */}
      <PopoverContent
        align="end"
        className="w-72 gap-3 p-3"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          const content = event.currentTarget as HTMLElement | null
          content?.focus()
        }}
      >
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1">
            <span className="font-bold">上下文</span>
            {breakdown && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="上下文用量说明"
                    className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Info className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-60">分项按字数估算，总数以模型返回的用量为准。</TooltipContent>
              </Tooltip>
            )}
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {formatTokens(usage.used)} / {formatTokens(usage.size)} · {percent}%
            </span>
          </div>
          <span className="flex h-1.5 overflow-hidden rounded-full bg-border">
            <span className={cn('rounded-full', high ? 'bg-warning' : 'bg-muted-foreground')} style={{ width: `${percent}%` }} />
          </span>
        </div>
        {breakdown && breakdownTotal > 0 && (
          <div className="flex flex-col gap-2">
            {/* 分项按已用量铺满整条，和上面的总量条区分开：加标题、条细一点 */}
            <span className="text-xs text-muted-foreground">构成</span>
            <span className="flex h-1 gap-px overflow-hidden rounded-full">
              {USAGE_PARTS.filter((part) => breakdown[part.key] > 0).map((part) => (
                <span key={part.key} className={cn('basis-0', part.className)} style={{ flexGrow: breakdown[part.key] }} />
              ))}
            </span>
            <div className="flex flex-col gap-1.5 text-xs">
              {USAGE_PARTS.map((part) => (
                <div key={part.key} className="flex items-center gap-2">
                  <span className={cn('size-2 shrink-0 rounded-[2px]', part.className)} />
                  <span className="min-w-0 flex-1 truncate">{part.label}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {formatTokens(breakdown[part.key])} · {share(breakdown[part.key])}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="-mx-3 flex justify-end border-t px-3 pt-3">
          <Button variant="outline" size="sm" disabled={running} onClick={compact}>
            <Archive />
            压缩上下文
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
