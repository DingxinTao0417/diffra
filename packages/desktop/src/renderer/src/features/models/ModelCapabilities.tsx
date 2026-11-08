import { useState } from 'react'
import { REASONING_EFFORTS, type Protocol, type ReasoningEffort } from '@diffra/core/types'
import { Check, Eye, Sparkles } from 'lucide-react'
import { cn } from 'cn'
import { MAX_MODEL_ID_LENGTH, MAX_MODEL_DISPLAY_NAME_LENGTH, CONTEXT_WINDOW_OPTIONS, type ModelConfig } from '../../../../shared/settings'
import { reasoningEffortsFor } from '../../../../shared/reasoning'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import { formatTokens } from '@/lib/format'
import { Field, ReadonlyField } from './ProviderDialog'

const DEFAULT_ENABLED_REASONING_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high']
const AUTO_CONTEXT = 'auto'
const CUSTOM_CONTEXT = 'custom'
const EFFORT_LABELS: Record<ReasoningEffort, string> = { default: '默认', none: '关闭', minimal: '最小', low: '低', medium: '中', high: '高', xhigh: '极高' }
const CONTEXT_CHOICES = [
  { value: AUTO_CONTEXT, label: '自动' },
  ...CONTEXT_WINDOW_OPTIONS.map((size) => ({ value: String(size), label: formatTokens(size).replace(/m$/, 'M') })),
  { value: CUSTOM_CONTEXT, label: '自定义' },
]

const isPresetContext = (size: number) => CONTEXT_WINDOW_OPTIONS.some((option) => option === size)

export function validateModelCapabilities(models: ModelConfig[]): string | null {
  if (models.length === 0) return '请至少填写一个模型 ID'
  if (models.some((model) => !model.id.trim())) return '模型 ID 不能为空'
  if (new Set(models.map((model) => model.id.trim())).size !== models.length) return '模型 ID 重复'
  if (models.some((model) => model.contextWindow !== null && (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0))) return '上下文长度要填正整数（单位：token）'
  return null
}

// 折叠行右侧的一句话摘要，例如「128k · 视觉 · 思考」
export function capabilitySummary(model: ModelConfig, protocol: Protocol): string {
  const parts = [
    model.contextWindow ? formatTokens(model.contextWindow) : null,
    model.images ? '视觉' : null,
    reasoningEffortsFor({ protocol }, model).some((value) => value !== 'default') ? '思考' : null,
  ]
  return parts.filter(Boolean).join(' · ')
}

// idField：hidden 用于向导第二步（第一步已填过）；readonly 用于编辑已保存的模型
export function ModelCapabilities({ model, protocol, onChange, index = 0, idField = 'editable' }: { model: ModelConfig; protocol: Protocol; onChange(model: ModelConfig): void; index?: number; idField?: 'editable' | 'readonly' | 'hidden' }) {
  const [customContext, setCustomContext] = useState(() => model.contextWindow !== null && !isPresetContext(model.contextWindow))
  const supportsEffort = protocol === 'openai-compatible' || protocol === 'openai-responses'
  const efforts = reasoningEffortsFor({ protocol }, model).filter((value) => value !== 'default')
  const reasoningEnabled = efforts.length > 0
  const contextChoice = customContext ? CUSTOM_CONTEXT : model.contextWindow === null ? AUTO_CONTEXT : String(model.contextWindow)
  const prefix = `capability-${index}`
  return (
    <div className="space-y-5" data-testid={`capabilities-${index}`}>
      <Field id={`${prefix}-name`} label="显示名称"><Input id={`${prefix}-name`} value={model.displayName ?? model.id} maxLength={MAX_MODEL_DISPLAY_NAME_LENGTH} onChange={(event) => onChange({ ...model, displayName: event.target.value })} /></Field>
      {idField === 'editable' && <Field id={`${prefix}-id`} label="模型 ID"><Input id={`${prefix}-id`} value={model.id} maxLength={MAX_MODEL_ID_LENGTH} required onChange={(event) => onChange({ ...model, id: event.target.value })} /></Field>}
      {idField === 'readonly' && <ReadonlyField label="模型 ID" value={model.id} mono />}
      <div className="space-y-1.5">
        <p aria-hidden="true" className="text-sm leading-none">上下文长度</p>
        <Segmented size="sm" label="上下文长度" value={contextChoice} options={CONTEXT_CHOICES} onChange={(value) => {
          setCustomContext(value === CUSTOM_CONTEXT)
          if (value === CUSTOM_CONTEXT) return
          onChange({ ...model, contextWindow: value === AUTO_CONTEXT ? null : Number(value) })
        }} />
        {customContext && <div className="flex items-center gap-2">
          <Input aria-label="自定义上下文长度" type="number" min={1} step={1} placeholder="按服务商文档填写" value={model.contextWindow ?? ''} onChange={(event) => {
            if (event.target.value === '') { onChange({ ...model, contextWindow: null }); return }
            const value = event.target.valueAsNumber
            if (!Number.isSafeInteger(value)) return
            onChange({ ...model, contextWindow: value })
          }} />
          <span className="shrink-0 text-sm text-muted-foreground">tokens</span>
        </div>}
        <p className="text-xs text-muted-foreground">选「自动」时使用应用默认值。</p>
      </div>
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm leading-none">能力</legend>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" aria-pressed={model.images} className={cn('flex h-8 items-center justify-center gap-2 rounded-md border text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50', model.images && 'border-primary/40 bg-soft text-primary hover:bg-soft')} onClick={() => onChange({ ...model, images: !model.images })}><Eye className="size-3.5" />视觉</button>
          <button type="button" aria-pressed={reasoningEnabled} disabled={!supportsEffort} className={cn('flex h-8 items-center justify-center gap-2 rounded-md border text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50', reasoningEnabled && 'border-primary/40 bg-soft text-primary hover:bg-soft')} onClick={() => onChange({ ...model, reasoningEfforts: reasoningEnabled ? [] : [...DEFAULT_ENABLED_REASONING_EFFORTS] })}><Sparkles className="size-3.5" />思考模式</button>
        </div>
        {!supportsEffort && <p className="text-xs text-muted-foreground">此协议暂不支持发送思考强度参数。</p>}
      </fieldset>
      {supportsEffort && reasoningEnabled && <div role="group" aria-labelledby={`${prefix}-efforts`} className="space-y-2">
        <div className="flex h-6 items-center justify-between">
          <span id={`${prefix}-efforts`} className="text-sm leading-none">思考强度</span>
          {model.reasoningEfforts !== undefined && <Button type="button" size="xs" variant="link" className="h-auto px-0" onClick={() => onChange({ ...model, reasoningEfforts: undefined })}>恢复自动识别</Button>}
        </div>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {REASONING_EFFORTS.filter((value) => value !== 'default').map((effort) => {
            const checked = efforts.includes(effort)
            return <button key={effort} type="button" role="checkbox" aria-checked={checked} aria-label={`${model.id} 思考 ${effort}`} title={effort} className={cn('flex h-7 items-center justify-center gap-1 rounded-md border text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring', checked ? 'border-primary/40 bg-soft text-primary hover:bg-soft' : 'text-muted-foreground')} onClick={() => onChange({ ...model, reasoningEfforts: checked ? efforts.filter((value) => value !== effort) : [...efforts, effort] })}>
              {checked && <Check className="size-3" />}{EFFORT_LABELS[effort]}
            </button>
          })}
        </div>
        <p className="text-xs text-muted-foreground">只勾选服务商文档里列出的档位，输入框的思考滑条只显示这里勾选的档位。</p>
      </div>}
    </div>
  )
}
