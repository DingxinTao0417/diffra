import { type FormEvent, type ReactNode, useState } from 'react'
import type { Protocol } from '@diffra/core/types'
import { baseUrlHint, CUSTOM_PROTOCOLS, PROTOCOL_LABELS, PROVIDER_PRESETS } from '../../../../shared/presets'
import { modelDisplayName, MAX_MODEL_ID_LENGTH, MAX_PROVIDER_MODELS, type ModelConfig, type ProviderInput, type ProviderView, type SettingsView } from '../../../../shared/settings'
import { Check, ChevronRight, Eye, EyeOff, Plus, Trash2 } from 'lucide-react'
import { cn } from 'cn'
import { capabilitySummary, ModelCapabilities, validateModelCapabilities } from './ModelCapabilities'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { errorMessage } from '@/lib/errors'

const CUSTOM = 'custom'

interface ProviderDialogProps {
  open: boolean
  // null 表示新建
  provider: ProviderView | null
  onOpenChange(open: boolean): void
  onSaved(view: SettingsView): void
}

export function ProviderDialog({ open, provider, onOpenChange, onSaved }: ProviderDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader className="pr-8">
          <DialogTitle>{provider ? '编辑模型服务' : '添加模型服务'}</DialogTitle>
          <DialogDescription>使用自己的 API Key，密钥加密保存在本机。</DialogDescription>
        </DialogHeader>
        {/* 表单放在 DialogContent 里，每次打开都会重新挂载，状态从 provider 重新初始化 */}
        <ProviderForm
          provider={provider}
          onSaved={(view) => {
            onSaved(view)
            onOpenChange(false)
          }}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

interface ProviderFormProps {
  provider: ProviderView | null
  onSaved(view: SettingsView): void
  onCancel(): void
}

function ProviderForm({ provider, onSaved, onCancel }: ProviderFormProps) {
  const editing = provider !== null
  // 新建时不预选，先让用户在预设里挑
  const [presetId, setPresetId] = useState(provider ? provider.presetId ?? CUSTOM : '')
  const [step, setStep] = useState<'connection' | 'capabilities'>('connection')
  const [expandedModel, setExpandedModel] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [models, setModels] = useState<Array<{ key: string; config: ModelConfig }>>(() =>
    (provider?.models.length ? provider.models : [{ id: '', contextWindow: null, images: false }]).map((config) => ({ key: crypto.randomUUID(), config })),
  )
  const [name, setName] = useState(provider?.name ?? '')
  const [protocol, setProtocol] = useState<Protocol>(provider?.protocol ?? 'openai-compatible')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const preset = PROVIDER_PRESETS.find((item) => item.id === presetId)

  const choosePreset = (id: string) => {
    setPresetId(id)
    const chosen = PROVIDER_PRESETS.find((item) => item.id === id)
    setName(chosen?.name ?? '')
    setProtocol(chosen?.protocol ?? 'openai-compatible')
    setBaseUrl(chosen?.baseUrl ?? '')
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (presetId === '') {
      setError('请选择供应商')
      return
    }
    if (!editing && !apiKey.trim()) {
      setError('请填写 API Key')
      return
    }
    const configured = models.map(({ config }) => ({ ...config, id: config.id.trim() }))
    const problem = validateModelCapabilities(configured)
    if (problem) { setError(problem); return }
    if (step === 'connection') { setError(null); setStep('capabilities'); return }
    setSaving(true)
    setError(null)
    const input: ProviderInput = { id: provider?.id, presetId: presetId === CUSTOM ? null : presetId, name: name.trim(), protocol, baseUrl: baseUrl.trim(), models: configured, apiKey: apiKey.trim() || undefined }
    try {
      for (const model of configured.filter((item) => item.enabled !== false)) {
        const result = await window.diffra.validateProviderModel(input, model.id)
        if (!result.ok) { setError(`${model.id}：${result.error.message}`); return }
        if (!result.tools.supported) { setError(`${model.id} 不支持工具调用，暂时无法用于编程任务`); return }
      }
      onSaved(await window.diffra.saveProvider(input))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  const updateModel = (key: string, config: ModelConfig) => setModels((current) => current.map((entry) => entry.key === key ? { ...entry, config } : entry))

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4">
      <StepIndicator current={step === 'connection' ? 0 : 1} />
      <DialogBody>
      <fieldset disabled={saving} hidden={step !== 'connection'} className="space-y-4">
      <Field id="provider-preset" label="供应商">
          <Select value={presetId} onValueChange={choosePreset}>
            <SelectTrigger id="provider-preset" className="w-full">
              <SelectValue placeholder="选择供应商" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>按量计费</SelectLabel>
                {PROVIDER_PRESETS.filter((item) => item.group === 'payg').map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectGroup>
              <SelectGroup>
                <SelectLabel>编程套餐</SelectLabel>
                {PROVIDER_PRESETS.filter((item) => item.group === 'plan').map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectGroup>
              <SelectGroup>
                {/* 自定义还能选 Anthropic 兼容和 Gemini，名字里不写「OpenAI 兼容」 */}
                <SelectItem value={CUSTOM}>自定义</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

      {presetId !== '' && (
        <>
          {preset?.note && (
            <Alert>
              <AlertDescription>{preset.note}</AlertDescription>
            </Alert>
          )}
          <Field id="provider-name" label="名称">
            <Input id="provider-name" placeholder="例如 DeepSeek" value={name} onChange={(event) => setName(event.target.value)} required />
          </Field>
          {presetId === CUSTOM ? (
            <Field id="provider-protocol" label="API 类型">
              <Select
                value={protocol}
                onValueChange={(value) => {
                  const next = CUSTOM_PROTOCOLS.find((item) => item === value)
                  if (next) setProtocol(next)
                }}
              >
                <SelectTrigger id="provider-protocol" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CUSTOM_PROTOCOLS.map((item) => (
                    <SelectItem key={item} value={item}>
                      {item === 'openai-compatible' ? 'OpenAI 兼容（Chat Completions）' : item === 'openai-responses' ? 'OpenAI 兼容（Responses）' : PROTOCOL_LABELS[item]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : (
            <ReadonlyField label="API 类型" value={PROTOCOL_LABELS[protocol]} />
          )}
          <Field id="provider-base-url" label="地址" hint={baseUrlHint(protocol)}>
            <Input id="provider-base-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required />
          </Field>
          <Field
            id="provider-api-key"
            label="API Key"
            hint={editing ? `留空则不修改（当前：${provider.keyHint ?? '未设置'}）` : undefined}
          >
            <div className="relative">
              <Input id="provider-api-key" type={showKey ? 'text' : 'password'} autoComplete="off" value={apiKey} className="pr-9" onChange={(event) => setApiKey(event.target.value)} />
              <button type="button" aria-label={showKey ? '隐藏 API Key' : '显示 API Key'} className="absolute inset-y-0 right-2 flex items-center text-muted-foreground" onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button>
            </div>
          </Field>
          <div role="group" aria-labelledby="provider-models" className="space-y-1.5">
            <div className="flex h-4 items-center justify-between">
              <span id="provider-models" className="text-sm leading-none">模型 ID</span>
              <Button type="button" size="xs" variant="link" className="h-auto px-0" disabled={models.length >= MAX_PROVIDER_MODELS} onClick={() => setModels((current) => [...current, { key: crypto.randomUUID(), config: { id: '', contextWindow: null, images: false } }])}><Plus />添加模型 ID</Button>
            </div>
            <div className="space-y-2">
              {models.map((item, index) => <div key={item.key} className="flex items-center gap-2">
                <Input aria-label={`模型 ID ${index + 1}`} placeholder="例如 qwen3.8-max" value={item.config.id} maxLength={MAX_MODEL_ID_LENGTH} required onChange={(event) => updateModel(item.key, { ...item.config, id: event.target.value })} />
                <Button type="button" size="icon-sm" variant="ghost" aria-label={`移除模型 ID ${index + 1}`} disabled={models.length <= 1} onClick={() => setModels((current) => current.filter((entry) => entry.key !== item.key))}><Trash2 className="size-3.5" /></Button>
              </div>)}
            </div>
          </div>
        </>
      )}
      </fieldset>
      {step === 'capabilities' && <fieldset disabled={saving}>
        {models.length === 1 ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{modelDisplayName(models[0].config)}</p>
            <ModelCapabilities model={models[0].config} protocol={protocol} idField="hidden" onChange={(config) => updateModel(models[0].key, config)} />
          </div>
        ) : (
          <div className="divide-y rounded-lg border">
            {models.map((item, index) => {
              const expanded = expandedModel === item.key
              return <div key={item.key}>
                <button type="button" aria-expanded={expanded} aria-controls={`capability-panel-${index}`} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset" onClick={() => setExpandedModel(expanded ? null : item.key)}>
                  <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} />
                  <span className="min-w-0 flex-1 truncate">{modelDisplayName(item.config)}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{capabilitySummary(item.config, protocol)}</span>
                </button>
                {expanded && <div id={`capability-panel-${index}`} className="px-3 pt-1 pb-4">
                  <ModelCapabilities model={item.config} protocol={protocol} index={index} idField="hidden" onChange={(config) => updateModel(item.key, config)} />
                </div>}
              </div>
            })}
          </div>
        )}
      </fieldset>}
      </DialogBody>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <Button type="button" variant="ghost" disabled={saving} onClick={step === 'capabilities' ? () => { setStep('connection'); setError(null) } : onCancel}>{step === 'capabilities' ? '返回' : '取消'}</Button>
        <Button type="submit" disabled={saving}>{saving ? '正在校验…' : step === 'connection' ? '下一步' : editing ? '校验并保存' : '校验并添加模型'}</Button>
      </DialogFooter>
    </form>
  )
}

const STEPS = ['连接信息', '模型能力']

function StepIndicator({ current }: { current: number }) {
  return (
    <ol className="flex items-center gap-2 text-xs" aria-label="配置步骤">
      {STEPS.map((label, index) => (
        <li key={label} aria-current={index === current ? 'step' : undefined} className="flex items-center gap-2">
          {index > 0 && <span aria-hidden="true" className="h-px w-8 bg-border" />}
          <span aria-hidden="true" className={cn('flex size-5 items-center justify-center rounded-full border tabular-nums', index < current && 'border-transparent bg-muted text-foreground', index === current && 'border-primary/40 bg-soft text-primary', index > current && 'text-muted-foreground')}>
            {index < current ? <Check className="size-3" /> : index + 1}
          </span>
          <span className={index === current ? 'text-foreground' : 'text-muted-foreground'}>{label}</span>
        </li>
      ))}
    </ol>
  )
}

export function ReadonlyField({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm leading-none">{label}</p>
      <p className={cn('h-8 truncate rounded-lg bg-muted/60 px-2.5 text-sm leading-8', mono && 'font-mono')}>{value}</p>
    </div>
  )
}

export function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
