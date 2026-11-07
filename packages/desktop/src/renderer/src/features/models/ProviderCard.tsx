import { useState } from 'react'
import { type ListedModel } from '@diffra/core/types'
import { Ellipsis, Plus, Zap } from 'lucide-react'
import { ModelCapabilityDialog } from './ModelCapabilityDialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { PROTOCOL_LABELS } from '../../../../shared/presets'
import { modelDisplayName, type ModelConfig, type ProviderView, type SettingsView } from '../../../../shared/settings'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
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
  const [capabilities, setCapabilities] = useState<{ model: ModelConfig | null } | null>(null)
  const [tests, setTests] = useState<Record<string, TestState>>({})
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)

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


  const runTest = async (modelId: string) => {
    setTests((current) => ({ ...current, [modelId]: { state: 'running' } }))
    let next: TestState
    try {
      const result = await window.diffra.testProviderModel(provider.id, modelId)
      next = result.ok
        ? {
            state: 'ok',
            text:
              `连接正常 · ${result.latencyMs}ms · 回复：${result.reply || '（没有文字输出）'} · ` +
              (result.tools.supported ? '工具调用：支持' : `工具调用：不支持，agent 用不了这个模型（${result.tools.detail ?? '原因未知'}）`),
          }
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
    <Card data-testid="provider-card" className="gap-3 rounded-xl py-4 shadow-none">
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
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-muted/50"><Zap className="size-4 text-muted-foreground" /></span>
                    <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{modelDisplayName(model)}</div><div className="mt-1 text-xs text-muted-foreground">{PROTOCOL_LABELS[provider.protocol]} · {model.id}</div></div>
                    <span className="text-muted-foreground">
                      {model.contextWindow ? `上下文 ${formatTokens(model.contextWindow)}` : '上下文未填'}
                    </span>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label={`${model.id} 模型操作`}><Ellipsis className="size-4" /></Button></DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setCapabilities({ model })}>配置能力</DropdownMenuItem>
                        <DropdownMenuItem disabled={test?.state === 'running'} onSelect={() => void runTest(model.id)}>测试连接</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => void saveModels(provider.models.filter((item) => item.id !== model.id))}>移除模型</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <Switch label={`${model.id} 启用`} checked={model.enabled !== false} onChange={(enabled) => void saveModels(provider.models.map((item) => item.id === model.id ? { ...item, enabled } : item))} />
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

          <Button size="sm" variant="ghost" onClick={() => setCapabilities({ model: null })}><Plus className="size-3.5" />添加模型</Button>
          {fetched.length > 0 && <div className="flex max-h-32 flex-wrap gap-1 overflow-auto">{fetched.filter((item) => !provider.models.some((model) => model.id === item.id)).map((item) => <Button key={item.id} size="sm" variant="outline" onClick={() => setCapabilities({ model: { id: item.id, contextWindow: null, images: false } })}>{item.id}</Button>)}</div>}
          {capabilities && <ModelCapabilityDialog key={capabilities.model?.id ?? 'new'} provider={provider} model={capabilities.model} onClose={() => setCapabilities(null)} onSaved={onChange} />}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  )
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)
}
