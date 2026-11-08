import { type FormEvent, useState } from 'react'
import type { ModelConfig, ProviderView, SettingsView } from '../../../../shared/settings'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/lib/errors'
import { ModelCapabilities, validateModelCapabilities } from './ModelCapabilities'

export function ModelCapabilityDialog({ provider, model, onClose, onSaved }: { provider: ProviderView; model: ModelConfig | null; onClose(): void; onSaved(view: SettingsView): void }) {
  const [draft, setDraft] = useState<ModelConfig>(model ?? { id: '', contextWindow: null, images: false })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const configured = { ...draft, id: draft.id.trim() }
    const models = model ? provider.models.map((item) => item.id === model.id ? configured : item) : [...provider.models, configured]
    const problem = validateModelCapabilities(models)
    if (problem) { setError(problem); return }
    setSaving(true)
    setError(null)
    const { keyHint: _keyHint, ...fields } = provider
    try {
      if (!model) {
        const result = await window.diffra.validateProviderModel({ ...fields, models }, configured.id)
        if (!result.ok) { setError(result.error.message); return }
        if (!result.tools.supported) { setError('模型不支持工具调用'); return }
      }
      onSaved(await window.diffra.saveProvider({ ...fields, models }))
      onClose()
    } catch (caught) { setError(errorMessage(caught)) }
    finally { setSaving(false) }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose() }}>
    <DialogContent className="top-[10vh] translate-y-0 sm:max-w-lg">
      <DialogHeader className="pr-8"><DialogTitle>配置模型能力</DialogTitle><DialogDescription>{provider.name} · {model ? '调整现有模型，不改变已保存的 API Key。' : '为此连接添加模型，校验通过后保存。'}</DialogDescription></DialogHeader>
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4">
        <DialogBody>
          <fieldset disabled={saving}><ModelCapabilities model={draft} protocol={provider.protocol} idField={model ? 'readonly' : 'editable'} onChange={setDraft} /></fieldset>
        </DialogBody>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button type="button" variant="ghost" disabled={saving} onClick={onClose}>取消</Button><Button type="submit" disabled={saving}>{saving ? '保存中…' : model ? '保存模型能力' : '校验并添加模型'}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}
