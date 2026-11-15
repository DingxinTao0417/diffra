import { useEffect, useRef, type KeyboardEvent } from 'react'
import { ShieldAlert, TriangleAlert } from 'lucide-react'
import { cn } from 'cn'
import { ASK_USER_SCOPE, type AskAnswer, type AskUserInput, COMMAND_RISK_META_KEY, type CommandRisk, DEEP_SCAN_ASK_SCOPE, EXTERNAL_ACCESS_SCOPE } from '@diffra/core/types'
import type { DiffLine } from '@/lib/unified-diff'
import { DiffLines } from './DiffLines'
import type { PermissionRequestEvent } from '../../../../shared/ipc'
import { Button } from '@/components/ui/button'
import { agentOfMeta } from './transcript'
import { AskCard } from './AskCard'

interface PermissionCardProps {
  request: PermissionRequestEvent
  // 提问里选文件用：本机任务的项目目录，远程任务不给
  project?: string | null
  onRespond(optionId: string | null, answers?: AskAnswer[]): void
}

const EXTERNAL_ACCESS_NOTE = '授权仅适用于上方确切路径和读/写操作；目录读取会包含子目录。本会话授权不会保留到重启后。项目外的修改不包含在项目检查点撤销中。'

export function PermissionCard({ request, project = null, onRespond }: PermissionCardProps) {
  const question = questionOf(request.toolCall.rawInput)
  if (question) return <AskCard request={request} input={question} project={project} onRespond={onRespond} />
  return <ConfirmCard request={request} onRespond={onRespond} />
}

function ConfirmCard({ request, onRespond }: PermissionCardProps) {
  const command = commandOf(request.toolCall.rawInput)
  // 智能体写的「为什么要跑这条命令」
  const justification = justificationOf(request.toolCall.rawInput)
  const external = isExternalAccess(request.toolCall.rawInput)
  const deepScanAsk = scopeOf(request.toolCall.rawInput) === DEEP_SCAN_ASK_SCOPE
  // 子智能体发起的请求写明是哪一个
  const agent = agentOfMeta(request.toolCall._meta)
  // 命令的风险等级和原因（第 659 步）；写项目外的文件时这个文件的那段补丁
  const risk = riskOf(request.toolCall._meta)
  const patch = external ? patchOf(request.toolCall.rawInput) : null
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
      className="space-y-3 rounded-xl border bg-card p-4 text-sm outline-none"
      data-testid="permission-card"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center gap-2 font-bold">
        <ShieldAlert className="size-4 text-muted-foreground" />
        {deepScanAsk ? request.toolCall.title : titleOf(request.toolCall.kind, external, request.toolCall.title ?? '')}
        {agent && (
          <span className="ml-auto flex min-w-0 items-center gap-1.5 text-xs font-normal text-muted-foreground" data-testid="permission-agent">
            <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: agent.color }} aria-hidden="true" />
            <span className="truncate">来自子智能体 {agent.name}</span>
          </span>
        )}
      </div>
      <pre className="overflow-auto rounded-md border bg-background/60 px-3 py-2 font-mono text-sm whitespace-pre-wrap break-words">
        {command !== null && <span className="text-muted-foreground select-none">{'$ '}</span>}
        {command ?? request.toolCall.title}
      </pre>
      {risk && risk.level !== 'low' && (
        <div className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-xs', risk.level === 'high' ? 'border-destructive/30 bg-destructive-soft' : 'border-warning/30 bg-warning-soft')} data-testid="permission-risk" data-level={risk.level}>
          <TriangleAlert className={cn('mt-0.5 size-3.5 shrink-0', risk.level === 'high' ? 'text-destructive' : 'text-warning')} aria-hidden="true" />
          <div className="min-w-0">
            <p className={cn('font-bold', risk.level === 'high' && 'text-destructive')}>{risk.level === 'high' ? '高风险，难以撤销' : '需要留意'}</p>
            <ul className="list-disc pl-4">
              {risk.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {patch && (
        <div className="overflow-hidden rounded-md border" data-testid="permission-patch">
          <p className="border-b bg-muted/50 px-3 py-1 text-xs text-muted-foreground">{patch.deleted ? '会删除这个文件' : patch.added ? '会新建这个文件' : '会这样改'}</p>
          {patch.hunks.length > 0 && <DiffLines hunks={patch.hunks} className="max-h-64 overflow-y-auto bg-background" />}
        </div>
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

// ask_user 的问题；core 已经按格式校验过，这里只确认是这类请求、每个问题的形状对
function questionOf(rawInput: unknown): AskUserInput | null {
  if (scopeOf(rawInput) !== ASK_USER_SCOPE) return null
  const questions = (rawInput as Partial<AskUserInput>).questions
  if (!Array.isArray(questions) || questions.length === 0) return null
  const valid = questions.every(
    (question) =>
      typeof question?.question === 'string' &&
      ((question.type === 'choice' && Array.isArray(question.options)) || (question.type === 'slider' && typeof question.min === 'number' && typeof question.max === 'number' && typeof question.step === 'number') || question.type === 'file'),
  )
  return valid ? { questions } : null
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

function riskOf(meta: unknown): CommandRisk | null {
  const diffra = typeof meta === 'object' && meta !== null && 'diffra' in meta ? (meta as { diffra?: Record<string, unknown> }).diffra : undefined
  const risk = diffra?.[COMMAND_RISK_META_KEY] as Partial<CommandRisk> | undefined
  if (!risk || (risk.level !== 'high' && risk.level !== 'medium' && risk.level !== 'low') || !Array.isArray(risk.reasons)) return null
  return { level: risk.level, reasons: risk.reasons.filter((reason): reason is string => typeof reason === 'string') }
}

// core 给的 apply_patch 分段：「*** Update File: 路径」后面是 @@ 分隔的几段 +/-/空格 开头的行（没有行号）
function patchOf(rawInput: unknown): { added: boolean; deleted: boolean; hunks: DiffLine[][] } | null {
  const patch = typeof rawInput === 'object' && rawInput !== null && 'patch' in rawInput && typeof rawInput.patch === 'string' ? rawInput.patch : null
  if (!patch) return null
  const [header = '', ...lines] = patch.split(/\r?\n/)
  const hunks: DiffLine[][] = []
  let hunk: DiffLine[] | null = null
  for (const line of lines) {
    if (line.startsWith('@@') || line.startsWith('*** Move to:') || line.startsWith('*** End of File')) {
      hunk = null
      continue
    }
    const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : 'context'
    if (!hunk) {
      hunk = []
      hunks.push(hunk)
    }
    hunk.push({ kind, text: kind === 'context' ? line.replace(/^ /, '') : line.slice(1), oldLine: null, newLine: null })
  }
  return { added: header.startsWith('*** Add File'), deleted: header.startsWith('*** Delete File'), hunks: hunks.filter((lines) => lines.length > 0) }
}
