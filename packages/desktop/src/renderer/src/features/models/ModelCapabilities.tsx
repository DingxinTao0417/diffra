import { useState } from 'react'
import type { Protocol, ReasoningEffort } from '@diffra/core/types'
import { MAX_MODEL_ID_LENGTH, MAX_MODEL_DISPLAY_NAME_LENGTH, CONTEXT_WINDOW_OPTIONS, MAX_OUTPUT_OPTIONS, type ModelConfig } from '../../../../shared/settings'
import { REASONING_CHOICES, reasoningEffortsFor, supportsReasoningEffort } from '../../../../shared/reasoning'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Segmented } from '@/components/ui/segmented'
import { formatTokens } from '@/lib/format'
import { Field, ReadonlyField } from '@/components/ui/field'

const DEFAULT_ENABLED_REASONING_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high']
const AUTO_CONTEXT = 'auto'
const CUSTOM_CONTEXT = 'custom'
const CONTEXT_CHOICES = [
  { value: AUTO_CONTEXT, label: '自动' },
  ...CONTEXT_WINDOW_OPTIONS.map((size) => ({ value: String(size), label: formatTokens(size).replace(/m$/, 'M') })),
  { value: CUSTOM_CONTEXT, label: '自定义' },
]

const OUTPUT_CHOICES = [
  { value: AUTO_CONTEXT, label: '自动' },
  ...MAX_OUTPUT_OPTIONS.map((size) => ({ value: String(size), label: formatTokens(size) })),
  { value: CUSTOM_CONTEXT, label: '自定义' },
]

const isPresetContext = (size: number) => CONTEXT_WINDOW_OPTIONS.some((option) => option === size)
const isPresetOutput = (size: number) => MAX_OUTPUT_OPTIONS.some((option) => option === size)
const isPositiveInteger = (value: number | null | undefined) => value === null || value === undefined || (Number.isSafeInteger(value) && value > 0)

export function validateModelCapabilities(models: ModelConfig[]): string | null {
  if (models.length === 0) return '请至少填写一个模型 ID'
  if (models.some((model) => !model.id.trim())) return '模型 ID 不能为空'
  if (new Set(models.map((model) => model.id.trim())).size !== models.length) return '模型 ID 重复'
  if (models.some((model) => model.contextWindow !== null && (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0))) return '上下文长度要填正整数（单位：token）'
  if (models.some((model) => !isPositiveInteger(model.maxOutputTokens))) return '最大输出要填正整数（单位：token）'
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

// idField：readonly 用于编辑已保存的模型；hidden 用于添加面板，模型 ID 已经在那一行上填
export function ModelCapabilities({ model, protocol, onChange, index = 0, idField = 'editable' }: { model: ModelConfig; protocol: Protocol; onChange(model: ModelConfig): void; index?: number; idField?: 'editable' | 'readonly' | 'hidden' }) {
  const [customContext, setCustomContext] = useState(() => model.contextWindow !== null && !isPresetContext(model.contextWindow))
  const supportsEffort = supportsReasoningEffort(protocol)
  const efforts = reasoningEffortsFor({ protocol }, model).filter((value) => value !== 'default')
  const reasoningEnabled = efforts.length > 0
  const contextChoice = customContext ? CUSTOM_CONTEXT : model.contextWindow === null ? AUTO_CONTEXT : String(model.contextWindow)
  const maxOutput = model.maxOutputTokens ?? null
  const [customOutput, setCustomOutput] = useState(() => maxOutput !== null && !isPresetOutput(maxOutput))
  const outputChoice = customOutput ? CUSTOM_CONTEXT : maxOutput === null ? AUTO_CONTEXT : String(maxOutput)
  const anthropicProtocol = protocol === 'anthropic' || protocol === 'anthropic-compatible'
  const prefix = `capability-${index}`
  return (
    <div className="space-y-5" data-testid={`capabilities-${index}`}>
      {idField === 'readonly' && <ReadonlyField label="模型 ID" value={model.id} mono />}
      <Field id={`${prefix}-name`} label="显示名称"><Input id={`${prefix}-name`} value={model.displayName ?? model.id} maxLength={MAX_MODEL_DISPLAY_NAME_LENGTH} onChange={(event) => onChange({ ...model, displayName: event.target.value })} /></Field>
      {idField === 'editable' && <Field id={`${prefix}-id`} label="模型 ID"><Input id={`${prefix}-id`} value={model.id} maxLength={MAX_MODEL_ID_LENGTH} required onChange={(event) => onChange({ ...model, id: event.target.value })} /></Field>}
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
      <div className="space-y-1.5">
        <p aria-hidden="true" className="text-sm leading-none">最大输出</p>
        <Segmented size="sm" label="最大输出" value={outputChoice} options={OUTPUT_CHOICES} onChange={(value) => {
          setCustomOutput(value === CUSTOM_CONTEXT)
          if (value === CUSTOM_CONTEXT) return
          onChange({ ...model, maxOutputTokens: value === AUTO_CONTEXT ? null : Number(value) })
        }} />
        {customOutput && <div className="flex items-center gap-2">
          <Input aria-label="自定义最大输出" type="number" min={1} step={1} placeholder="按服务商文档填写" value={maxOutput ?? ''} onChange={(event) => {
            if (event.target.value === '') { onChange({ ...model, maxOutputTokens: null }); return }
            const value = event.target.valueAsNumber
            if (!Number.isSafeInteger(value)) return
            onChange({ ...model, maxOutputTokens: value })
          }} />
          <span className="shrink-0 text-sm text-muted-foreground">tokens</span>
        </div>}
        <p className="text-xs text-muted-foreground">
          {anthropicProtocol
            ? '一次回复最多输出多少，含思考。选「自动」时 Claude 用官方上限，其他模型按 32k，服务商说超出范围时自动调低；自己填的值超出范围会直接报错。'
            : '一次回复最多输出多少，含思考。选「自动」时不指定，用服务商的默认值。'}
        </p>
      </div>
      {/* 勾选框在 form 里会多渲染一个绝对定位的隐藏 input，所在行要 relative，否则内容区滚动时它会撑出弹窗外层的滚动条 */}
      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm leading-none">能力</legend>
        <div className="relative grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5">
          <Checkbox id={`${prefix}-images`} aria-describedby={`${prefix}-images-hint`} checked={model.images} onCheckedChange={() => onChange({ ...model, images: !model.images })} />
          <Label htmlFor={`${prefix}-images`}>视觉</Label>
          <p id={`${prefix}-images-hint`} className="col-start-2 text-xs text-muted-foreground">勾选后，输入框里的图片和浏览器截图会发给这个模型。</p>
        </div>
        <div className="relative grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5">
          <Checkbox id={`${prefix}-reasoning`} aria-describedby={`${prefix}-reasoning-hint`} checked={reasoningEnabled} disabled={!supportsEffort} onCheckedChange={() => onChange({ ...model, reasoningEfforts: reasoningEnabled ? [] : [...DEFAULT_ENABLED_REASONING_EFFORTS] })} />
          <Label htmlFor={`${prefix}-reasoning`}>思考模式</Label>
          <p id={`${prefix}-reasoning-hint`} className="col-start-2 text-xs text-muted-foreground">{!supportsEffort ? '此协议暂不支持发送思考强度参数。' : anthropicProtocol ? '勾选后，输入框里可以调思考强度；不勾时不指定，按服务商的默认强度思考。' : '勾选后，输入框里可以调思考强度。'}</p>
        </div>
      </fieldset>
      {supportsEffort && reasoningEnabled && <div role="group" aria-labelledby={`${prefix}-efforts`} className="space-y-2">
        <div className="flex h-6 items-center justify-between">
          <span id={`${prefix}-efforts`} className="text-sm leading-none">思考强度</span>
          {!anthropicProtocol && model.reasoningEfforts !== undefined && <Button type="button" size="xs" variant="link" className="h-auto px-0" onClick={() => onChange({ ...model, reasoningEfforts: undefined })}>恢复自动识别</Button>}
        </div>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {REASONING_CHOICES.map((effort) => {
            const checked = efforts.includes(effort)
            const id = `${prefix}-effort-${effort}`
            return <div key={effort} className="relative flex h-7 items-center gap-2">
              <Checkbox id={id} checked={checked} onCheckedChange={() => onChange({ ...model, reasoningEfforts: checked ? efforts.filter((value) => value !== effort) : [...efforts, effort] })} />
              <Label htmlFor={id}>{effort}</Label>
            </div>
          })}
        </div>
        <p className="text-xs text-muted-foreground">只勾选服务商文档里列出的档位，输入框的思考滑条只显示这里勾选的档位。</p>
      </div>}
    </div>
  )
}
