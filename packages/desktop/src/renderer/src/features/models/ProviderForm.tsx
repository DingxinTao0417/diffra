import { type FormEvent, useEffect, useRef, useState } from 'react'
import type { Protocol } from '@diffra/core/types'
import { ChevronDown, Eye, EyeOff, Plus, Trash2 } from 'lucide-react'
import { baseUrlHint, CUSTOM_PROTOCOLS, PROTOCOL_LABELS, PROVIDER_PRESETS } from '../../../../shared/presets'
import { MAX_MODEL_ID_LENGTH, MAX_PROVIDER_MODELS, type ModelConfig, type ProviderInput, type ProviderView, type SettingsView } from '../../../../shared/settings'
import { cn } from 'cn'
import { IconPicker } from './IconPicker'
import { capabilitySummary, ModelCapabilities, validateModelCapabilities } from './ModelCapabilities'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, ReadonlyField } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Segmented } from '@/components/ui/segmented'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { errorMessage } from '@/lib/errors'
import { useLobeIcons } from '@/lib/model-icons'

const CUSTOM = 'custom'
type Source = 'preset' | 'custom'
const SOURCES: Array<{ value: Source; label: string }> = [
  { value: 'preset', label: '预设服务' },
  { value: 'custom', label: '自定义 API' },
]

interface ProviderFormProps {
  // null 表示新建，表单里带模型；编辑时只改连接信息，模型在面板下半区即时生效
  provider: ProviderView | null
  onSaved(view: SettingsView): void
  onCancel(): void
  onDirtyChange(dirty: boolean): void
}

export function ProviderForm({ provider, onSaved, onCancel, onDirtyChange }: ProviderFormProps) {
  const editing = provider !== null
  // 新建时不预选，先让用户在预设里挑
  const [presetId, setPresetId] = useState(provider ? provider.presetId ?? CUSTOM : '')
  // 预设服务的名称、图标和地址已经预填，默认收起；编辑时多半就是来改它们，默认展开
  const [detailsOpen, setDetailsOpen] = useState(editing)
  const [expandedModel, setExpandedModel] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [models, setModels] = useState<Array<{ key: string; config: ModelConfig }>>(() => [{ key: crypto.randomUUID(), config: { id: '', contextWindow: null, images: false } }])
  const [icon, setIcon] = useState(provider?.icon ?? null)
  const [iconPickerOpen, setIconPickerOpen] = useState(false)
  const [name, setName] = useState(provider?.name ?? '')
  const [protocol, setProtocol] = useState<Protocol>(provider?.protocol ?? 'openai-compatible')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)

  const preset = PROVIDER_PRESETS.find((item) => item.id === presetId)
  const source: Source = presetId === CUSTOM ? 'custom' : 'preset'
  const icons = useLobeIcons()
  const matchedIcon = icons?.matchProviderIcon({ icon: null, presetId: presetId === CUSTOM ? null : presetId, name, baseUrl }) ?? null
  const iconUnrecognized = icons !== null && icon === null && matchedIcon === null && name.trim() !== ''

  useEffect(() => onDirtyChange(touched), [touched, onDirtyChange])
  // 打开时把面板滚进视野，焦点放到第一个要填的控件上
  useEffect(() => {
    const form = formRef.current
    form?.scrollIntoView({ block: 'nearest' })
    form?.querySelector<HTMLElement>('#provider-preset, #provider-name')?.focus()
  }, [])

  const touch = () => setTouched(true)

  const choosePreset = (id: string) => {
    touch()
    setPresetId(id)
    setIcon(null)
    const chosen = PROVIDER_PRESETS.find((item) => item.id === id)
    setName(chosen?.name ?? '')
    setProtocol(chosen?.protocol ?? 'openai-compatible')
    setBaseUrl(chosen?.baseUrl ?? '')
  }

  const chooseSource = (next: Source) => choosePreset(next === 'custom' ? CUSTOM : '')

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
    const configured = editing ? provider.models : models.map(({ config }) => ({ ...config, id: config.id.trim() }))
    if (!editing) {
      const problem = validateModelCapabilities(configured)
      if (problem) { setError(problem); return }
    }
    setSaving(true)
    setError(null)
    const input: ProviderInput = { id: provider?.id, presetId: presetId === CUSTOM ? null : presetId, icon, name: name.trim(), protocol, baseUrl: baseUrl.trim(), models: configured, apiKey: apiKey.trim() || undefined }
    try {
      for (const model of configured.filter((item) => item.enabled !== false)) {
        const result = await window.diffra.validateProviderModel(input, model.id)
        if (!result.ok) { setError(`${model.id}：${result.error.message}`); return }
        if (!result.tools.supported) { setError(`${model.id} 不支持工具调用，暂时无法用于编程任务（${result.tools.detail ?? '原因未知'}）`); return }
      }
      onSaved(await window.diffra.saveProvider(input))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  const updateModel = (key: string, config: ModelConfig) => {
    touch()
    setModels((current) => current.map((entry) => entry.key === key ? { ...entry, config } : entry))
  }

  const nameField = (
    <div className="space-y-1.5">
      <div className="flex h-4 items-center justify-between">
        <Label htmlFor="provider-name">名称</Label>
        {iconUnrecognized && <Button type="button" size="xs" variant="link" className="h-auto px-0" onClick={() => setIconPickerOpen(true)}>没认出来，点这里选</Button>}
      </div>
      <div className="flex items-center gap-2">
        <IconPicker value={icon} matched={matchedIcon} fallbackText={name} open={iconPickerOpen} onOpenChange={setIconPickerOpen} onChange={(next) => { touch(); setIcon(next) }} />
        <Input id="provider-name" placeholder="例如 DeepSeek" value={name} className="bg-background" onChange={(event) => { touch(); setName(event.target.value) }} required />
      </div>
    </div>
  )
  const baseUrlField = (
    <Field id="provider-base-url" label="地址" hint={baseUrlHint(protocol)}>
      <Input id="provider-base-url" value={baseUrl} className="bg-background" onChange={(event) => { touch(); setBaseUrl(event.target.value) }} required />
    </Field>
  )
  const apiKeyField = (
    <Field id="provider-api-key" label="API Key" hint={editing ? `留空则不修改（当前：${provider.keyHint ?? '未设置'}）。` : '密钥加密保存在本机。'}>
      <div className="relative">
        <Input id="provider-api-key" type={showKey ? 'text' : 'password'} autoComplete="off" value={apiKey} className="bg-background pr-9" onChange={(event) => { touch(); setApiKey(event.target.value) }} />
        <button type="button" aria-label={showKey ? '隐藏 API Key' : '显示 API Key'} className="absolute inset-y-0 right-2 flex items-center text-muted-foreground" onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button>
      </div>
    </Field>
  )

  return (
    <form ref={formRef} onSubmit={submit} aria-label={editing ? `编辑「${provider.name}」的连接` : '添加模型服务'} data-testid="provider-panel" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-bold">{editing ? '连接信息' : '添加模型服务'}</h3>
        <Segmented label="服务来源" size="sm" value={source} options={SOURCES} onChange={chooseSource} />
      </div>
      <fieldset disabled={saving} className="space-y-4">
        {source === 'preset' ? (
          <>
            <Field id="provider-preset" label="供应商">
              <Select value={presetId} onValueChange={choosePreset}>
                <SelectTrigger id="provider-preset" className="w-full bg-background sm:w-80">
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
                </SelectContent>
              </Select>
            </Field>
            {preset && (
              <>
                {preset.note && (
                  <Alert>
                    <AlertDescription>{preset.note}</AlertDescription>
                  </Alert>
                )}
                {apiKeyField}
                <div>
                  <button type="button" aria-expanded={detailsOpen} aria-controls="provider-details" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" onClick={() => setDetailsOpen(!detailsOpen)}>
                    <ChevronDown className={cn('size-4 transition-transform', !detailsOpen && '-rotate-90')} />
                    名称和地址
                  </button>
                  <div id="provider-details" hidden={!detailsOpen} className="mt-3 space-y-4">
                    {nameField}
                    <ReadonlyField label="API 类型" value={PROTOCOL_LABELS[protocol]} />
                    {baseUrlField}
                  </div>
                </div>
              </>
            )}
          </>
        ) : (
          <>
            {nameField}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="provider-protocol" label="API 类型">
                <Select
                  value={protocol}
                  onValueChange={(value) => {
                    const next = CUSTOM_PROTOCOLS.find((item) => item === value)
                    if (next) { touch(); setProtocol(next) }
                  }}
                >
                  <SelectTrigger id="provider-protocol" className="w-full bg-background">
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
              {apiKeyField}
            </div>
            {baseUrlField}
          </>
        )}

        {!editing && presetId !== '' && (
          <div role="group" aria-labelledby="provider-models" className="space-y-2 border-t pt-4">
            <span id="provider-models" className="block text-sm leading-none">模型</span>
            <div className="divide-y rounded-lg border bg-background">
              {models.map((item, index) => {
                const expanded = expandedModel === item.key
                const summary = capabilitySummary(item.config, protocol)
                return (
                  <div key={item.key}>
                    <div className="flex items-center gap-1.5 py-1 pr-1 pl-1">
                      <Input aria-label={`模型 ID ${index + 1}`} placeholder="例如 qwen3.8-max" value={item.config.id} maxLength={MAX_MODEL_ID_LENGTH} required className="h-7 min-w-0 flex-1 border-transparent bg-transparent font-mono text-xs hover:border-input dark:bg-transparent" onChange={(event) => updateModel(item.key, { ...item.config, id: event.target.value })} />
                      {summary && <span className="shrink-0 text-xs text-muted-foreground">{summary}</span>}
                      <Button type="button" size="icon-sm" variant="ghost" aria-expanded={expanded} aria-controls={`capability-panel-${index}`} aria-label={`模型 ID ${index + 1} 的能力`} onClick={() => setExpandedModel(expanded ? null : item.key)}>
                        <ChevronDown className={cn('size-4 text-muted-foreground transition-transform', expanded && 'rotate-180')} />
                      </Button>
                      <Button type="button" size="icon-sm" variant="ghost" aria-label={`移除模型 ID ${index + 1}`} disabled={models.length <= 1} onClick={() => { touch(); setModels((current) => current.filter((entry) => entry.key !== item.key)) }}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                    {expanded && (
                      <div id={`capability-panel-${index}`} className="border-t px-3 pt-3 pb-4">
                        <ModelCapabilities model={item.config} protocol={protocol} index={index} idField="hidden" onChange={(config) => updateModel(item.key, config)} />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            <Button type="button" size="xs" variant="outline" className="bg-background" disabled={models.length >= MAX_PROVIDER_MODELS} onClick={() => { touch(); setModels((current) => [...current, { key: crypto.randomUUID(), config: { id: '', contextWindow: null, images: false } }]) }}>
              <Plus />
              添加模型 ID
            </Button>
          </div>
        )}
      </fieldset>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" className="bg-background" disabled={saving} onClick={onCancel}>取消</Button>
        <Button type="submit" disabled={saving}>{saving ? '正在校验…' : editing ? '校验并保存' : '校验并添加模型'}</Button>
      </div>
    </form>
  )
}
