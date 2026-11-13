import { useEffect, useRef, type KeyboardEvent } from 'react'
import { CircleHelp, ShieldAlert } from 'lucide-react'
import { ASK_USER_SCOPE, type AskUserInput, DEEP_SCAN_ASK_SCOPE, EXTERNAL_ACCESS_SCOPE } from '@diffra/core/types'
import type { PermissionRequestEvent } from '../../../../shared/ipc'
import { Button } from '@/components/ui/button'
import { agentOfMeta } from './transcript'

interface PermissionCardProps {
  request: PermissionRequestEvent
  onRespond(optionId: string | null): void
}

const EXTERNAL_ACCESS_NOTE = '授权仅适用于上方确切路径和读/写操作；目录读取会包含子目录。本会话授权不会保留到重启后。项目外的修改不包含在项目检查点撤销中。'

export function PermissionCard({ request, onRespond }: PermissionCardProps) {
  const command = commandOf(request.toolCall.rawInput)
  // 智能体写的「为什么要跑这条命令」
  const justification = justificationOf(request.toolCall.rawInput)
  const external = isExternalAccess(request.toolCall.rawInput)
  const deepScanAsk = scopeOf(request.toolCall.rawInput) === DEEP_SCAN_ASK_SCOPE
  const question = questionOf(request.toolCall.rawInput)
  // 子智能体发起的请求写明是哪一个
  const agent = agentOfMeta(request.toolCall._meta)
  const allowOnce = request.options.find((option) => option.kind === 'allow_once')
  const reject = request.options.find((option) => option.kind.startsWith('reject'))
  const allowOnceRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    // 用户正在输入框里打字时不抢焦点，否则本想发送消息的 Enter 会直接变成「允许」
    if (isEditable(document.activeElement)) return
    allowOnceRef.current?.focus()
  }, [request.requestId])

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && reject) {
      event.preventDefault()
      event.stopPropagation()
      onRespond(reject.optionId)
      return
    }
    // 焦点在某个按钮上时交给按钮自己处理 Enter，不能把聚焦的「拒绝」变成「允许」
    if (event.key === 'Enter' && allowOnce && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault()
      event.stopPropagation()
      onRespond(allowOnce.optionId)
    }
  }

  return (
    <div
      className="space-y-3 rounded-xl border border-warning/40 bg-warning-soft p-4 text-sm outline-none dark:border-warning/30"
      data-testid="permission-card"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center gap-2 font-bold">
        {question ? <CircleHelp className="size-4 text-warning" /> : <ShieldAlert className="size-4 text-warning" />}
        {question ? '智能体想先问你一下' : deepScanAsk ? request.toolCall.title : titleOf(request.toolCall.kind, external, request.toolCall.title ?? '')}
        {agent && (
          <span className="ml-auto flex min-w-0 items-center gap-1.5 text-xs font-normal text-muted-foreground" data-testid="permission-agent">
            <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: agent.color }} aria-hidden="true" />
            <span className="truncate">来自子智能体 {agent.name}</span>
          </span>
        )}
      </div>
      {question ? (
        // 智能体中途的提问（ask_user）：问题和每个选项的说明，按钮就是选项
        <div className="space-y-2" data-testid="ask-user">
          <p className="break-words whitespace-pre-wrap">{question.question}</p>
          {question.options.some((option) => option.description) && (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {question.options.map((option) => (
                <li key={option.label} className="break-words">
                  <span className="font-bold text-foreground/90">{option.label}</span>
                  {option.description ? `：${option.description}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <pre className="overflow-auto rounded-md border bg-background/60 px-3 py-2 font-mono text-sm whitespace-pre-wrap break-words">
          {command !== null && <span className="text-muted-foreground select-none">{'$ '}</span>}
          {command ?? request.toolCall.title}
        </pre>
      )}
      {justification && <p className="break-words text-xs text-muted-foreground" data-testid="permission-justification">{justification}</p>}
      {external && (
        <p className="truncate text-xs text-muted-foreground" title={EXTERNAL_ACCESS_NOTE}>
          仅限上方路径和这类操作；项目外的修改无法用检查点撤销
        </p>
      )}
      {deepScanAsk && (
        <p className="text-xs text-muted-foreground">
          只读地跨文件追踪这个任务改过的代码，会多次调用模型。扫完出报告，你勾选要修的再交给智能体；这一轮先停下，命令不执行。
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {request.options.map((option) => (
          <Button
            key={option.optionId}
            ref={option === allowOnce ? allowOnceRef : undefined}
            variant={variantOf(option)}
            className={option === reject ? 'ml-auto' : undefined}
            onClick={() => onRespond(option.optionId)}
          >
            {option.name}
          </Button>
        ))}
      </div>
    </div>
  )
}

function titleOf(kind: PermissionRequestEvent['toolCall']['kind'], external: boolean, title: string): string {
  if (kind === 'execute') return '运行命令？'
  if (external) return '访问项目外的文件？'
  if (kind === 'fetch' && title.startsWith('下载图片')) return '下载图片？'
  if (kind === 'fetch') return '打开网页？'
  return '需要你确认才能执行'
}

function variantOf(option: PermissionRequestEvent['options'][number]): 'default' | 'outline' | 'ghost' {
  if (option.kind === 'allow_once') return 'default'
  if (option.kind === 'allow_always') return 'outline'
  return 'ghost'
}

function isEditable(element: Element | null): boolean {
  return element instanceof HTMLElement && (element.isContentEditable || element.tagName === 'TEXTAREA' || element.tagName === 'INPUT')
}

function isExternalAccess(rawInput: unknown): boolean {
  return scopeOf(rawInput) === EXTERNAL_ACCESS_SCOPE
}

// ask_user 的问题和选项；core 已经按格式校验过，这里只确认是这类请求
function questionOf(rawInput: unknown): AskUserInput | null {
  if (scopeOf(rawInput) !== ASK_USER_SCOPE) return null
  const input = rawInput as Partial<AskUserInput>
  return typeof input.question === 'string' && Array.isArray(input.options) ? { question: input.question, options: input.options } : null
}

function scopeOf(rawInput: unknown): unknown {
  return typeof rawInput === 'object' && rawInput !== null && 'scope' in rawInput ? rawInput.scope : null
}

function justificationOf(rawInput: unknown): string | null {
  return typeof rawInput === 'object' && rawInput !== null && 'justification' in rawInput && typeof rawInput.justification === 'string' && rawInput.justification.trim()
    ? rawInput.justification.trim()
    : null
}

function commandOf(rawInput: unknown): string | null {
  return typeof rawInput === 'object' && rawInput !== null && 'command' in rawInput && typeof rawInput.command === 'string'
    ? rawInput.command
    : null
}
