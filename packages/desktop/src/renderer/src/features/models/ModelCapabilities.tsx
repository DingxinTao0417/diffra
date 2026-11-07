import { REASONING_EFFORTS, type Protocol, type ReasoningEffort } from '@diffra/core/types'
import { Eye, Sparkles } from 'lucide-react'
import { cn } from 'cn'
import { MAX_MODEL_ID_LENGTH, MAX_MODEL_DISPLAY_NAME_LENGTH, CONTEXT_WINDOW_OPTIONS, type ModelConfig } from '../../../../shared/settings'
import { reasoningEffortsFor } from '../../../../shared/reasoning'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Field } from './ProviderDialog'

const DEFAULT_ENABLED_REASONING_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high']
const AUTO_CONTEXT = 'auto'
const EFFORT_LABELS: Record<ReasoningEffort, string> = { default: '默认', none: '关闭', minimal: '最小', low: '低', medium: '中', high: '高', xhigh: '极高' }

export function validateModelCapabilities(models: ModelConfig[]): string | null {
  if (models.length === 0) return '请至少填写一个 Model ID'
  if (models.some((model) => !model.id.trim())) return '模型 ID 不能为空'
  if (new Set(models.map((model) => model.id.trim())).size !== models.length) return '模型 ID 重复'
  if (models.some((model) => model.contextWindow !== null && (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0))) return '上下文长度要填正整数（单位：token）'
  return null
}

export function ModelCapabilities({ model, protocol, onChange, index = 0 }: { model: ModelConfig; protocol: Protocol; onChange(model: ModelConfig): void; index?: number }) {
  const supportsEffort = protocol === 'openai-compatible' || protocol === 'openai-responses'
  const efforts = reasoningEffortsFor({ protocol }, model).filter((value) => value !== 'default')
  const reasoningEnabled = efforts.length > 0
  const windows = [...new Set([...(model.contextWindows ?? []), ...(model.contextWindow ? [model.contextWindow] : [])])].sort((a, b) => a - b)
  const windowOptions = [...new Set([...CONTEXT_WINDOW_OPTIONS, ...windows])].sort((a, b) => a - b)
  const prefix = `capability-${index}`
  return (
    <div className="space-y-5 rounded-lg border bg-background p-4" data-testid={`capabilities-${index}`}>
      <Field id={`${prefix}-name`} label="显示名称"><Input id={`${prefix}-name`} value={model.displayName ?? model.id} maxLength={MAX_MODEL_DISPLAY_NAME_LENGTH} onChange={(event) => onChange({ ...model, displayName: event.target.value })} /></Field>
      <Field id={`${prefix}-id`} label="Model ID"><Input id={`${prefix}-id`} value={model.id} maxLength={MAX_MODEL_ID_LENGTH} required onChange={(event) => onChange({ ...model, id: event.target.value })} /></Field>
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium">支持的上下文窗口</legend>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {windowOptions.map((size) => <label key={size} className={cn('cursor-pointer rounded-md border px-1 py-1.5 text-center text-xs', windows.includes(size) ? 'border-primary/50 bg-soft text-primary' : 'text-muted-foreground')}>
            <input type="checkbox" className="mr-1 size-3 accent-primary" aria-label={`支持上下文 ${size}`} checked={windows.includes(size)} onChange={(event) => {
              const contextWindows = event.target.checked ? [...windows, size] : windows.filter((value) => value !== size)
              onChange({ ...model, contextWindows, contextWindow: contextWindows.includes(model.contextWindow ?? 0) ? model.contextWindow : contextWindows[0] ?? null })
            }} />
            {size >= 1_000_000 ? `${size / 1_000_000}M` : `${size / 1000}k`}
          </label>)}
        </div>
      </fieldset>
      <Field id={`${prefix}-context`} label="默认上下文窗口" hint="未指定时使用应用默认值；自定义长度可在下方填写。">
        <Select value={model.contextWindow === null ? AUTO_CONTEXT : String(model.contextWindow)} onValueChange={(value) => {
          const contextWindow = value === AUTO_CONTEXT ? null : Number(value)
          if (contextWindow !== null && (!Number.isSafeInteger(contextWindow) || contextWindow <= 0)) return
          onChange({ ...model, contextWindow })
        }}>
          <SelectTrigger id={`${prefix}-context`} className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value={AUTO_CONTEXT}>自动（未指定）</SelectItem>{windows.map((size) => <SelectItem key={size} value={String(size)}>{size.toLocaleString()} tokens</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      <Field id={`${prefix}-custom-context`} label="上下文长度" hint="单位 token，可直接填写服务商文档中的长度。">
        <Input id={`${prefix}-custom-context`} type="number" min={1} step={1} value={model.contextWindow ?? ''} onChange={(event) => {
          if (event.target.value === '') { onChange({ ...model, contextWindow: null }); return }
          const value = event.target.valueAsNumber
          if (!Number.isSafeInteger(value)) return
          onChange({ ...model, contextWindow: value, contextWindows: value > 0 ? [...new Set([...windows, value])] : windows })
        }} />
      </Field>
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium">能力</legend>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" aria-pressed={model.images} className={cn('flex items-center justify-center gap-2 rounded-md border py-2 text-xs', model.images && 'border-primary/50 bg-soft text-primary')} onClick={() => onChange({ ...model, images: !model.images })}><Eye className="size-3.5" />视觉</button>
          <button type="button" aria-pressed={reasoningEnabled} disabled={!supportsEffort} className={cn('flex items-center justify-center gap-2 rounded-md border py-2 text-xs disabled:opacity-40', reasoningEnabled && 'border-primary/50 bg-soft text-primary')} onClick={() => onChange({ ...model, reasoningEfforts: reasoningEnabled ? [] : [...DEFAULT_ENABLED_REASONING_EFFORTS] })}><Sparkles className="size-3.5" />思考模式</button>
        </div>
        {!supportsEffort && <p className="text-xs text-muted-foreground">此协议暂不支持发送思考强度参数。</p>}
      </fieldset>
      {supportsEffort && <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium">思考强度</legend>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {REASONING_EFFORTS.filter((value) => value !== 'default').map((effort) => <label key={effort} className={cn('cursor-pointer rounded-md border px-1 py-1.5 text-center text-xs focus-within:ring-2 focus-within:ring-ring', efforts.includes(effort) ? 'border-primary/50 bg-soft text-primary' : 'text-muted-foreground')} title={effort}>
            <input type="checkbox" className="mr-1 size-3 accent-primary" aria-label={`${model.id} 思考 ${effort}`} checked={efforts.includes(effort)} onChange={(event) => onChange({ ...model, reasoningEfforts: event.target.checked ? [...efforts, effort] : efforts.filter((value) => value !== effort) })} />{EFFORT_LABELS[effort]}
          </label>)}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">仅勾选服务商支持的值；输入框的思考滑条会随模型变化。「默认」始终不发送参数。</p>
        <Button type="button" size="sm" variant="ghost" onClick={() => onChange({ ...model, reasoningEfforts: undefined })}>恢复自动识别</Button>
      </fieldset>}
    </div>
  )
}
