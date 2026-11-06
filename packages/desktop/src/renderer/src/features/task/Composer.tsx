import { type KeyboardEvent, useState } from 'react'
import type { PermissionMode } from '@diffra/core/types'
import { ArrowUp, Check, ChevronDown, Cpu, Shield, Square } from 'lucide-react'
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
import { formatTokens } from '@/lib/format'
import { PERMISSION_MODES, permissionModeLabel } from '@/lib/permission-modes'
import { openSettings, refreshSettings } from '@/state/actions'
import { useAppState } from '@/state/store'

interface ComposerProps {
  size: 'large' | 'normal'
  placeholder: string
  // 没准备好（没选项目、会话没建好）时不能发送
  disabled?: boolean
  running?: boolean
  permissionMode: PermissionMode
  onPermissionModeChange(mode: PermissionMode): void
  modelLabel: string | null
  modelLocked?: boolean
  onModelChange(ref: ModelRef): void
  // 返回 false 表示没发出去，输入框里的内容保留
  onSend(text: string): boolean | Promise<boolean>
  onStop?(): void
}

export function Composer(props: ComposerProps) {
  const { size, placeholder, disabled, running, onSend, onStop } = props
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const canSend = !disabled && !sending && draft.trim() !== ''

  const send = async () => {
    if (!canSend) return
    setSending(true)
    try {
      if (await onSend(draft.trim())) setDraft('')
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      void send()
    }
  }

  const large = size === 'large'
  return (
    <div
      className={cn(
        'flex flex-col border border-input bg-background focus-within:border-ring/60',
        large ? 'rounded-2xl shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.04)]' : 'rounded-[14px]',
      )}
    >
      <textarea
        aria-label="任务"
        rows={large ? 4 : 2}
        autoFocus
        value={draft}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        className={cn(
          'max-h-[40vh] resize-none bg-transparent outline-none placeholder:text-muted-foreground',
          large ? 'px-4.5 pt-4 pb-2 text-[1.07rem]' : 'px-3.5 pt-3 pb-1',
        )}
      />
      <div className="flex flex-wrap items-center gap-2 px-2.5 pt-1.5 pb-2.5">
        <PermissionModeMenu mode={props.permissionMode} onChange={props.onPermissionModeChange} />
        <div className="flex-1" />
        <ModelMenu label={props.modelLabel} locked={props.modelLocked} onChange={props.onModelChange} />
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
