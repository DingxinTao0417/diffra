import { type FormEvent, useEffect, useRef, useState } from 'react'
import { modelDisplayName, type ModelConfig, type ProviderView, type SettingsView } from '../../../../shared/settings'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/lib/errors'
import { ModelCapabilities, validateModelCapabilities } from './ModelCapabilities'

interface ModelEditorProps {
  provider: ProviderView
  // existing：改已保存模型的能力，不重新校验；不传就是新加一个模型（可以带着拉取到的 ID 预填），校验通过才保存
  existing?: ModelConfig
  initial?: ModelConfig
  onClose(): void
  onSaved(view: SettingsView): void
  onDirtyChange(dirty: boolean): void
}

export function ModelEditor({ provider, existing, initial, onClose, onSaved, onDirtyChange }: ModelEditorProps) {
  const [draft, setDraft] = useState<ModelConfig>(existing ?? initial ?? { id: '', contextWindow: null, images: false })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)

  useEffect(() => onDirtyChange(touched), [touched, onDirtyChange])
  useEffect(() => {
    const form = formRef.current
    form?.scrollIntoView({ block: 'nearest' })
    form?.querySelector<HTMLElement>('input')?.focus()
  }, [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const configured = { ...draft, id: draft.id.trim() }
    const models = existing ? provider.models.map((item) => item.id === existing.id ? configured : item) : [...provider.models, configured]
    const problem = validateModelCapabilities(models)
    if (problem) { setError(problem); return }
    setSaving(true)
    setError(null)
    const { keyHint: _keyHint, ...fields } = provider
    try {
      if (!existing) {
        const result = await window.diffra.validateProviderModel({ ...fields, models }, configured.id)
        if (!result.ok) { setError(result.error.message); return }
        if (!result.tools.supported) { setError('模型不支持工具调用'); return }
      }
      onSaved(await window.diffra.saveProvider({ ...fields, models }))
      onClose()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form ref={formRef} onSubmit={submit} aria-label={existing ? `配置「${modelDisplayName(existing)}」的能力` : '添加模型'} data-testid="model-editor" className="space-y-4 p-4">
      <fieldset disabled={saving}>
        <ModelCapabilities model={draft} protocol={provider.protocol} idField={existing ? 'readonly' : 'editable'} onChange={(next) => { setTouched(true); setDraft(next) }} />
      </fieldset>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="outline" disabled={saving} onClick={onClose}>取消</Button>
        <Button type="submit" size="sm" disabled={saving}>{saving ? (existing ? '保存中…' : '正在校验…') : existing ? '保存模型能力' : '校验并添加模型'}</Button>
      </div>
    </form>
  )
}
