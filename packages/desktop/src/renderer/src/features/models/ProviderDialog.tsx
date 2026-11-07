import { type FormEvent, type ReactNode, useState } from 'react'
import type { Protocol } from '@diffra/core/types'
import { baseUrlHint, CUSTOM_PROTOCOLS, PROTOCOL_LABELS, PROVIDER_PRESETS } from '../../../../shared/presets'
import type { ProviderView, SettingsView } from '../../../../shared/settings'
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
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{provider ? '编辑供应商' : '添加供应商'}</DialogTitle>
          <DialogDescription>密钥加密保存在本机，界面上只显示末 4 位。</DialogDescription>
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
  const [presetId, setPresetId] = useState(provider ? (provider.presetId ?? CUSTOM) : '')
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
    setSaving(true)
    setError(null)
    try {
      onSaved(
        await window.diffra.saveProvider({
          id: provider?.id,
          presetId: presetId === CUSTOM ? null : presetId,
          name,
          protocol,
          baseUrl: baseUrl.trim(),
          models: provider?.models ?? [],
          apiKey: apiKey.trim() || undefined,
        }),
      )
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {!editing && (
        <Field id="provider-preset" label="类型">
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
                <SelectItem value={CUSTOM}>自定义</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      )}

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
            <Field id="provider-protocol" label="协议">
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
                      {PROTOCOL_LABELS[item]}
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
            <Input
              id="provider-api-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </Field>
        </>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" disabled={saving || presetId === ''}>
          {saving ? '保存中…' : '保存'}
        </Button>
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
