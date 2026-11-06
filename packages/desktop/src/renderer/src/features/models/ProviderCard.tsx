import { type FormEvent, useState } from 'react'
import type { ListedModel } from '@diffra/core/types'
import { PROTOCOL_LABELS } from '../../../../shared/presets'
import type { ModelConfig, ProviderView, SettingsView } from '../../../../shared/settings'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { errorMessage } from '@/lib/errors'

type TestState = { state: 'running' } | { state: 'ok' | 'error'; text: string }

interface ProviderCardProps {
  provider: ProviderView
  onChange(view: SettingsView): void
  onEdit(): void
}

export function ProviderCard({ provider, onChange, onEdit }: ProviderCardProps) {
  const [fetched, setFetched] = useState<ListedModel[]>([])
  const [fetching, setFetching] = useState(false)
  const [fetchStatus, setFetchStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [newModelId, setNewModelId] = useState('')
  const [newContextWindow, setNewContextWindow] = useState('')
  const [tests, setTests] = useState<Record<string, TestState>>({})
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const datalistId = `models-${provider.id}`

  const saveModels = async (models: ModelConfig[]): Promise<boolean> => {
    setError(null)
    const { keyHint: _keyHint, ...fields } = provider
    try {
      onChange(await window.diffra.saveProvider({ ...fields, models }))
      return true
    } catch (caught) {
      setError(errorMessage(caught))
      return false
    }
  }

  const fetchModels = async () => {
    setFetching(true)
    setFetchStatus(null)
    try {
      const result = await window.diffra.listProviderModels(provider.id)
      if (result.ok) {
        setFetched(result.models)
        setFetchStatus({ ok: true, text: `已拉取 ${result.models.length} 个模型，在下面的「模型 ID」里输入可以筛选` })
      } else {
        setFetchStatus({ ok: false, text: result.error.message })
      }
    } catch (caught) {
      setFetchStatus({ ok: false, text: errorMessage(caught) })
    } finally {
      setFetching(false)
    }
  }

  const addModel = async (event: FormEvent) => {
    event.preventDefault()
    const id = newModelId.trim()
    const contextWindow = newContextWindow.trim() === '' ? null : Number(newContextWindow)
    if (contextWindow !== null && (!Number.isInteger(contextWindow) || contextWindow <= 0)) {
      setError('上下文长度要填正整数（单位：token）')
      return
    }
    if (provider.models.some((model) => model.id === id)) {
      setError('这个模型已经添加过了')
      return
    }
    if (await saveModels([...provider.models, { id, contextWindow }])) {
      setNewModelId('')
      setNewContextWindow('')
    }
  }

  const runTest = async (modelId: string) => {
    setTests((current) => ({ ...current, [modelId]: { state: 'running' } }))
    let next: TestState
    try {
      const result = await window.diffra.testProviderModel(provider.id, modelId)
      next = result.ok
        ? { state: 'ok', text: `连接正常 · ${result.latencyMs}ms · 回复：${result.reply || '（没有文字输出）'}` }
        : { state: 'error', text: result.error.message }
    } catch (caught) {
      next = { state: 'error', text: errorMessage(caught) }
    }
    setTests((current) => ({ ...current, [modelId]: next }))
  }

  const deleteProvider = async () => {
    try {
      onChange(await window.diffra.deleteProvider(provider.id))
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  return (
    <Card data-testid="provider-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {provider.name}
          <Badge variant="secondary">{PROTOCOL_LABELS[provider.protocol]}</Badge>
        </CardTitle>
        <CardDescription className="break-all">{provider.baseUrl}</CardDescription>
        <CardAction className="flex gap-2">
          <Button size="sm" variant="outline" onClick={onEdit}>
            编辑
          </Button>
          {confirmingDelete ? (
            <>
              <Button size="sm" variant="destructive" onClick={deleteProvider}>
                确认删除
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmingDelete(false)}>
                取消
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirmingDelete(true)}>
              删除
            </Button>
          )}
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">密钥</span>
          {provider.keyHint ? (
            <Badge variant="outline" data-testid="key-hint">
              {provider.keyHint}
            </Badge>
          ) : (
            <Badge variant="destructive">未设置</Badge>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">模型</span>
            <Button size="sm" variant="outline" onClick={fetchModels} disabled={fetching}>
              {fetching ? '正在拉取…' : '拉取模型列表'}
            </Button>
          </div>

          {fetchStatus && (
            <p data-testid="fetch-status" className={`text-sm ${fetchStatus.ok ? 'text-muted-foreground' : 'text-destructive'}`}>
              {fetchStatus.text}
            </p>
          )}

          {provider.models.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有模型。拉取列表后选择，或直接填写模型 ID。</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {provider.models.map((model) => {
                const test = tests[model.id]
                return (
                  <li key={model.id} data-testid={`model-row-${model.id}`} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                    <span className="font-mono">{model.id}</span>
                    <span className="text-muted-foreground">
                      {model.contextWindow ? `上下文 ${formatTokens(model.contextWindow)}` : '上下文未填'}
                    </span>
                    <div className="ml-auto flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => runTest(model.id)}
                        disabled={test?.state === 'running'}
                      >
                        {test?.state === 'running' ? '测试中…' : '测试'}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => saveModels(provider.models.filter((item) => item.id !== model.id))}>
                        移除
                      </Button>
                    </div>
                    {test && test.state !== 'running' && (
                      <p
                        data-testid={`test-result-${model.id}`}
                        className={`w-full ${test.state === 'ok' ? 'text-muted-foreground' : 'text-destructive'}`}
                      >
                        {test.text}
                      </p>
                    )}
                  </li>
                )
              })}
            </ul>
          )}

          <form onSubmit={addModel} className="flex gap-2">
            <Input
              aria-label="模型 ID"
              placeholder="模型 ID"
              list={datalistId}
              value={newModelId}
              onChange={(event) => setNewModelId(event.target.value)}
              className="flex-1"
            />
            <Input
              aria-label="上下文长度"
              placeholder="上下文长度（可选）"
              inputMode="numeric"
              value={newContextWindow}
              onChange={(event) => setNewContextWindow(event.target.value)}
              className="w-44"
            />
            <Button type="submit" variant="secondary" disabled={newModelId.trim() === ''}>
              添加模型
            </Button>
            <datalist id={datalistId}>
              {fetched.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </datalist>
          </form>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  )
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)
}
