import { useState } from 'react'
import { type ListedModel } from '@diffra/core/types'
import { Check, Ellipsis, ListPlus, LoaderCircle, Plus } from 'lucide-react'
import { BrandIcon } from './BrandIcon'
import { ModelCapabilityDialog } from './ModelCapabilityDialog'
import { ROLE_INFO } from './RolesCard'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { PROTOCOL_LABELS } from '../../../../shared/presets'
import { modelDisplayName, type ModelConfig, type ProviderView, type Role, ROLES, type SettingsView } from '../../../../shared/settings'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { errorMessage } from '@/lib/errors'
import { useLobeIcons } from '@/lib/model-icons'
import { cn } from 'cn'

// success-color-allow: success 只在用户主动点「测试连接」成功时写入（runTest）
type TestState = { state: 'running' } | { state: 'success' | 'warning' | 'error'; text: string; detail: string }
type FetchState = { state: 'running' } | { state: 'ok'; models: ListedModel[] } | { state: 'error'; text: string }

interface Confirmation {
  title: string
  description: string
  action: string
  destructive: boolean
  run(): void
}

// success-color-allow: 只给用户主动点「测试连接」的结果，后台连接状态不用绿色
const TEST_DOT = { success: 'bg-success', warning: 'bg-warning', error: 'bg-destructive' } as const

interface ProviderCardProps {
  provider: ProviderView
  roles: SettingsView['roles']
  onChange(view: SettingsView): void
  onEdit(): void
}

export function ProviderCard({ provider, roles, onChange, onEdit }: ProviderCardProps) {
  const [fetchOpen, setFetchOpen] = useState(false)
  const [fetched, setFetched] = useState<FetchState | null>(null)
  const [filter, setFilter] = useState('')
  const [capabilities, setCapabilities] = useState<{ model: ModelConfig | null } | null>(null)
  const [tests, setTests] = useState<Record<string, TestState>>({})
  // 关闭时只收起弹窗、保留内容，淡出动画期间标题不会变空
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const icons = useLobeIcons()
  const providerIcon = icons?.matchProviderIcon(provider) ?? null

  const rolesOf = (modelId: string): Role[] =>
    ROLES.filter((role) => roles[role]?.providerId === provider.id && roles[role]?.modelId === modelId)

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
    setFetched({ state: 'running' })
    setFilter('')
    try {
      const result = await window.diffra.listProviderModels(provider.id)
      setFetched(result.ok ? { state: 'ok', models: result.models } : { state: 'error', text: result.error.message })
    } catch (caught) {
      setFetched({ state: 'error', text: errorMessage(caught) })
    }
  }

  const runTest = async (modelId: string) => {
    setTests((current) => ({ ...current, [modelId]: { state: 'running' } }))
    let next: TestState
    try {
      const result = await window.diffra.testProviderModel(provider.id, modelId)
      if (!result.ok) {
        next = { state: 'error', text: '连接失败', detail: result.error.message }
      } else {
        const reply = `${result.latencyMs}ms · 回复：${result.reply || '（没有文字输出）'}`
        next = result.tools.supported
          // success-color-allow: 用户主动点「测试连接」，连上且支持工具调用
          ? { state: 'success', text: `连接正常 · ${result.latencyMs}ms`, detail: `${reply} · 工具调用：支持` }
          : { state: 'warning', text: '连接正常，但不支持工具调用', detail: `${reply} · 工具调用：不支持（${result.tools.detail ?? '原因未知'}）` }
      }
    } catch (caught) {
      next = { state: 'error', text: '连接失败', detail: errorMessage(caught) }
    }
    setTests((current) => ({ ...current, [modelId]: next }))
  }

  const confirm = (next: Confirmation) => {
    setConfirmation(next)
    setConfirmOpen(true)
  }

  const roleConsequence = (modelRoles: Role[]): string =>
    `${modelRoles.map((role) => ROLE_INFO[role].label).join('、')}角色会被清空` +
    (modelRoles.includes('coder') ? '，清空后任务无法开始。' : '。')

  const setEnabled = (model: ModelConfig, enabled: boolean) => {
    const save = () => void saveModels(provider.models.map((item) => (item.id === model.id ? { ...item, enabled } : item)))
    const modelRoles = rolesOf(model.id)
    if (enabled || modelRoles.length === 0) return save()
    confirm({
      title: `关闭「${modelDisplayName(model)}」？`,
      description: roleConsequence(modelRoles),
      action: '关闭',
      destructive: false,
      run: save,
    })
  }

  const removeModel = (model: ModelConfig) => {
    const remove = () => void saveModels(provider.models.filter((item) => item.id !== model.id))
    const modelRoles = rolesOf(model.id)
    if (modelRoles.length === 0) return remove()
    confirm({
      title: `移除「${modelDisplayName(model)}」？`,
      description: roleConsequence(modelRoles),
      action: '移除',
      destructive: true,
      run: remove,
    })
  }

  const deleteProvider = () => {
    const providerRoles = ROLES.filter((role) => roles[role]?.providerId === provider.id)
    confirm({
      title: `删除「${provider.name}」？`,
      description:
        `连接信息、API Key 和 ${provider.models.length} 个模型会一并删除，不能撤销。` +
        (providerRoles.length > 0 ? roleConsequence(providerRoles) : ''),
      action: '删除',
      destructive: true,
      run: () => {
        setError(null)
        window.diffra.deleteProvider(provider.id).then(onChange, (caught: unknown) => setError(errorMessage(caught)))
      },
    })
  }

  const query = filter.trim().toLowerCase()
  const fetchedModels = fetched?.state === 'ok' ? fetched.models.filter((item) => item.id.toLowerCase().includes(query)) : []

  return (
    <Card data-testid="provider-card" className="gap-0 rounded-xl py-0 shadow-none">
      <div className="flex items-center gap-3 px-4 py-3">
        <BrandIcon id={providerIcon} fallbackText={provider.name} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-base font-bold">{provider.name}</span>
            <Badge variant="secondary">{PROTOCOL_LABELS[provider.protocol]}</Badge>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate font-mono">{provider.baseUrl}</span>
            <span aria-hidden>·</span>
            {provider.keyHint ? (
              <span className="shrink-0">
                密钥 <span data-testid="key-hint" className="font-mono">{provider.keyHint}</span>
              </span>
            ) : (
              <span className="shrink-0 text-destructive">密钥未设置</span>
            )}
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={onEdit}>
          编辑
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label={`${provider.name} 更多操作`}>
              <Ellipsis className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem variant="destructive" onSelect={deleteProvider}>
              删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {provider.models.length === 0 ? (
        <p className="border-t px-4 py-3 text-sm text-muted-foreground">还没有模型。拉取模型列表挑选，或手动添加。</p>
      ) : (
        <ul className="divide-y border-t">
          {provider.models.map((model) => {
            const test = tests[model.id]
            const name = modelDisplayName(model)
            const enabled = model.enabled !== false
            return (
              <li key={model.id} data-testid={`model-row-${model.id}`} className="flex min-h-11 items-center gap-3 px-4 py-2 text-sm hover:bg-muted/50">
                <span className="flex w-8 shrink-0 justify-center">
                  <BrandIcon id={icons?.matchModelIcon(model.id) ?? providerIcon} fallbackText={provider.name} size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className={cn('truncate', !enabled && 'text-muted-foreground')}>{name}</span>
                    {model.contextWindow && (
                      <Badge variant="outline" data-testid={`context-window-${model.id}`}>
                        {formatTokens(model.contextWindow)}
                      </Badge>
                    )}
                    {rolesOf(model.id).map((role) => (
                      <Badge key={role} variant="secondary">
                        {ROLE_INFO[role].label}
                      </Badge>
                    ))}
                  </div>
                  {name !== model.id && <div className="truncate font-mono text-xs text-muted-foreground">{model.id}</div>}
                </div>
                {test?.state === 'running' && (
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
                    测试中
                  </span>
                )}
                {test && test.state !== 'running' && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        tabIndex={0}
                        data-testid={`test-result-${model.id}`}
                        className={cn(
                          'flex max-w-56 min-w-0 items-center gap-1.5 rounded-sm text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          test.state === 'error' ? 'text-destructive' : 'text-muted-foreground',
                        )}
                      >
                        <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', TEST_DOT[test.state])} />
                        <span className="truncate">{test.text}</span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{test.detail}</TooltipContent>
                  </Tooltip>
                )}
                <Switch label={`${model.id} 启用`} checked={enabled} onChange={(next) => setEnabled(model, next)} />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon-sm" variant="ghost" aria-label={`${model.id} 模型操作`}>
                      <Ellipsis className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setCapabilities({ model })}>配置能力</DropdownMenuItem>
                    <DropdownMenuItem disabled={test?.state === 'running'} onSelect={() => void runTest(model.id)}>
                      测试连接
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => removeModel(model)}>
                      移除模型
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            )
          })}
        </ul>
      )}

      <div className="flex items-center gap-1 border-t px-2 py-1.5">
        <Button size="sm" variant="ghost" onClick={() => setCapabilities({ model: null })}>
          <Plus className="size-3.5" />
          添加模型
        </Button>
        <Popover
          open={fetchOpen}
          onOpenChange={(open) => {
            setFetchOpen(open)
            if (open) void fetchModels()
          }}
        >
          <PopoverTrigger asChild>
            <Button size="sm" variant="ghost">
              <ListPlus className="size-3.5" />
              拉取模型列表
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80">
            {fetched?.state === 'running' && (
              <p className="flex items-center gap-1.5 px-1 text-sm text-muted-foreground">
                <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
                正在拉取…
              </p>
            )}
            {fetched?.state === 'error' && (
              <p data-testid="fetch-status" className="px-1 text-sm text-destructive">
                {fetched.text}
              </p>
            )}
            {fetched?.state === 'ok' && (
              <>
                <p data-testid="fetch-status" className="px-1 text-xs text-muted-foreground">
                  已拉取 {fetched.models.length} 个模型
                </p>
                <Input aria-label="筛选模型" placeholder="筛选模型" value={filter} onChange={(event) => setFilter(event.target.value)} />
                <ul className="-mx-1 max-h-64 overflow-y-auto">
                  {fetchedModels.map((item) => {
                    const added = provider.models.some((model) => model.id === item.id)
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          disabled={added}
                          aria-label={added ? `${item.id} 已添加` : item.id}
                          onClick={() => {
                            setFetchOpen(false)
                            setCapabilities({ model: { id: item.id, contextWindow: null, images: false } })
                          }}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent disabled:text-muted-foreground"
                        >
                          <span className="min-w-0 flex-1 truncate font-mono">{item.id}</span>
                          {added && <Check className="size-3.5 shrink-0" aria-hidden />}
                        </button>
                      </li>
                    )
                  })}
                  {fetchedModels.length === 0 && <li className="px-2 py-1.5 text-sm text-muted-foreground">没有匹配的模型</li>}
                </ul>
              </>
            )}
          </PopoverContent>
        </Popover>
      </div>

      {error && <p className="border-t px-4 py-2 text-sm text-destructive">{error}</p>}
      {capabilities && <ModelCapabilityDialog key={capabilities.model?.id ?? 'new'} provider={provider} model={capabilities.model} onClose={() => setCapabilities(null)} onSaved={onChange} />}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmation?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmation?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction variant={confirmation?.destructive ? 'destructive-solid' : 'default'} onClick={() => confirmation?.run()}>
              {confirmation?.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)
}
