import { type FormEvent, type ReactNode, useState } from 'react'
import type { Protocol } from '@diffra/core/types'
import { baseUrlHint, CUSTOM_PROTOCOLS, PROTOCOL_LABELS, PROVIDER_PRESETS } from '../../../../shared/presets'
import { modelDisplayName, MAX_MODEL_ID_LENGTH, MAX_PROVIDER_MODELS, type ModelConfig, type ProviderInput, type ProviderView, type SettingsView } from '../../../../shared/settings'
import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react'
import { ModelCapabilities, validateModelCapabilities } from './ModelCapabilities'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
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
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader className="pr-8">
          <DialogTitle>{provider ? '编辑模型连接' : '添加模型'}</DialogTitle>
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
  const [presetId, setPresetId] = useState(provider?.presetId ?? CUSTOM)
  const [step, setStep] = useState<'connection' | 'capabilities'>('connection')
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

  return (
    <form onSubmit={submit} className="space-y-4">
      <ol className="flex items-center gap-3 border-b pb-3 text-xs text-muted-foreground" aria-label="配置步骤"><li className={step === 'connection' ? 'font-medium text-primary' : ''}>1 · 连接信息</li><li aria-hidden="true">→</li><li className={step === 'capabilities' ? 'font-medium text-primary' : ''}>2 · 模型能力</li></ol>
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
                <SelectItem value={CUSTOM}>OpenAI Compatible（自定义）</SelectItem>
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
            <Input id="provider-name" value={name} onChange={(event) => setName(event.target.value)} required />
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
                      {item === 'openai-compatible' ? 'Chat Completions API' : item === 'openai-responses' ? 'Responses API' : PROTOCOL_LABELS[item]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : (
            <p className="text-sm text-muted-foreground">协议：{PROTOCOL_LABELS[protocol]}</p>
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
        </>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between"><span className="text-sm font-medium">Model ID</span><Button type="button" size="sm" variant="ghost" disabled={models.length >= MAX_PROVIDER_MODELS} onClick={() => setModels((current) => [...current, { key: crypto.randomUUID(), config: { id: '', contextWindow: null, images: false } }])}><Plus className="size-3" />添加 Model ID</Button></div>
        {models.map((item, index) => <div key={item.key} className="flex items-center gap-2">
          <Input aria-label={`Model ID ${index + 1}`} placeholder="例如 qwen3.8-max" value={item.config.id} maxLength={MAX_MODEL_ID_LENGTH} required onChange={(event) => setModels((current) => current.map((entry) => entry.key === item.key ? { ...entry, config: { ...entry.config, id: event.target.value } } : entry))} />
          <Button type="button" size="icon-sm" variant="ghost" aria-label={`移除 Model ID ${index + 1}`} disabled={models.length <= 1} onClick={() => setModels((current) => current.filter((entry) => entry.key !== item.key))}><Trash2 className="size-3.5" /></Button>
        </div>)}
      </div>
      </fieldset>
      {step === 'capabilities' && <div className="space-y-3">
        <h2 className="text-sm font-medium">配置模型能力</h2>
        {models.map((item, index) => <details key={item.key} open={models.length === 1 || undefined} className="rounded-lg border p-2">
          <summary className="cursor-pointer px-2 py-1 text-sm font-medium">{modelDisplayName(item.config)}</summary>
          <ModelCapabilities model={item.config} protocol={protocol} index={index} onChange={(config) => setModels((current) => current.map((entry) => entry.key === item.key ? { ...entry, config } : entry))} />
        </details>)}
      </div>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter className="border-t pt-3">
        <Button type="button" variant="ghost" disabled={saving} onClick={step === 'capabilities' ? () => { setStep('connection'); setError(null) } : onCancel}>{step === 'capabilities' ? '返回' : '取消'}</Button>
        <Button type="submit" disabled={saving}>{saving ? '校验中…' : step === 'connection' ? '下一步' : '校验并添加模型'}</Button>
      </DialogFooter>
    </form>
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
