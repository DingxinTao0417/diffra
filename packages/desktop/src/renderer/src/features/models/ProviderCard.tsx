import { Fragment, type ReactNode, useEffect, useState } from 'react'
import { type ListedModel } from '@diffra/core/types'
import { Check, ChevronUp, Ellipsis, ListPlus, LoaderCircle, Plus } from 'lucide-react'
import { BrandIcon } from './BrandIcon'
import { ModelEditor } from './ModelEditor'
import { ProviderForm } from './ProviderForm'
import { ROLE_INFO } from './RolesCard'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { PROTOCOL_LABELS } from '../../../../shared/presets'
import { reasoningEffortsFor } from '../../../../shared/reasoning'
import { modelDisplayName, type ModelConfig, type ProviderView, type Role, ROLES, type SettingsView } from '../../../../shared/settings'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { errorMessage } from '@/lib/errors'
import { formatTokens } from '@/lib/format'
import { useLobeIcons } from '@/lib/model-icons'
import { cn } from 'cn'

// success-color-allow: success 只在用户主动点「测试连接」成功时写入（runTest）
type TestState = { state: 'running' } | { state: 'success' | 'warning' | 'error'; text: string; detail: string }
type FetchState = { state: 'running' } | { state: 'ok'; models: ListedModel[] } | { state: 'error'; text: string }
type EditorState = { kind: 'existing'; model: ModelConfig } | { kind: 'new'; initial?: ModelConfig } | null

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
  expanded: boolean
  onExpand(): void
  // force：保存成功或用户点了取消，直接收起；否则有没保存的改动时由页面先问
  onCollapse(force: boolean): void
  onChange(view: SettingsView): void
  onDirtyChange(dirty: boolean): void
}

export function ProviderCard({ provider, roles, expanded, onExpand, onCollapse, onChange, onDirtyChange }: ProviderCardProps) {
  const icons = useLobeIcons()
  const providerIcon = icons?.matchProviderIcon(provider) ?? null
  const usedBy = ROLES.filter((role) => roles[role]?.providerId === provider.id)

  return (
    <div data-testid="provider-card">
      <div className="flex items-center gap-3 px-4 py-3">
        <BrandIcon id={providerIcon} fallbackText={provider.name} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-bold">{provider.name}</div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {PROTOCOL_LABELS[provider.protocol]} ·{' '}
            {provider.keyHint ? (
              <>
                密钥 <span data-testid="key-hint">{provider.keyHint}</span>
              </>
            ) : (
              <span className="text-destructive">密钥未设置</span>
            )}{' '}
            · {provider.models.length} 个模型
            {usedBy.length > 0 && ` · 用于${usedBy.map((role) => ROLE_INFO[role].label).join('、')}`}
          </p>
        </div>
        {expanded ? (
          <Button size="sm" variant="ghost" aria-expanded onClick={() => onCollapse(false)}>
            收起
            <ChevronUp className="size-3.5" />
          </Button>
        ) : (
          <Button size="sm" variant="outline" aria-expanded={false} onClick={onExpand}>
            编辑
          </Button>
        )}
      </div>
      {expanded && <ProviderPanel provider={provider} providerIcon={providerIcon} roles={roles} onChange={onChange} onClose={() => onCollapse(true)} onDirtyChange={onDirtyChange} />}
    </div>
  )
}

interface ProviderPanelProps {
  provider: ProviderView
  providerIcon: string | null
  roles: SettingsView['roles']
  onChange(view: SettingsView): void
  onClose(): void
  onDirtyChange(dirty: boolean): void
}

// 展开后的编辑区：上半是连接信息（校验并保存），下半是模型（开关、能力、测试、移除即时生效），最底下删除服务
function ProviderPanel({ provider, providerIcon, roles, onChange, onClose, onDirtyChange }: ProviderPanelProps) {
  const [fetchOpen, setFetchOpen] = useState(false)
  const [fetched, setFetched] = useState<FetchState | null>(null)
  const [filter, setFilter] = useState('')
  const [editor, setEditor] = useState<EditorState>(null)
  const [tests, setTests] = useState<Record<string, TestState>>({})
  // 关闭时只收起弹窗、保留内容，淡出动画期间标题不会变空
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [formDirty, setFormDirty] = useState(false)
  const [editorDirty, setEditorDirty] = useState(false)
  const icons = useLobeIcons()

  useEffect(() => onDirtyChange(formDirty || editorDirty), [formDirty, editorDirty, onDirtyChange])

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

  const openEditor = (next: EditorState) => {
    const open = () => {
      setEditorDirty(false)
      setEditor(next)
    }
    if (!editorDirty) return open()
    confirm({ title: '放弃没保存的改动？', description: '刚才填写的模型能力不会保存。', action: '放弃', destructive: false, run: open })
  }
  const closeEditor = () => {
    setEditorDirty(false)
    setEditor(null)
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
  const editorProps = { provider, onClose: closeEditor, onSaved: onChange, onDirtyChange: setEditorDirty }

  return (
    <div className="mx-2.5 mb-2.5 space-y-5 rounded-xl bg-muted p-5">
      <ProviderForm provider={provider} onSaved={(view) => { onChange(view); onClose() }} onCancel={onClose} onDirtyChange={setFormDirty} />

      <section aria-labelledby={`provider-models-${provider.id}`} className="space-y-2 border-t pt-5">
        <div className="flex items-center justify-between gap-3">
          <h3 id={`provider-models-${provider.id}`} className="text-sm font-bold">模型</h3>
          <Popover
            open={fetchOpen}
            onOpenChange={(open) => {
              setFetchOpen(open)
              if (open) void fetchModels()
            }}
          >
            <PopoverTrigger asChild>
              <Button size="xs" variant="ghost" className="text-muted-foreground">
                <ListPlus className="size-3.5" />
                拉取模型列表
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80">
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
                              openEditor({ kind: 'new', initial: { id: item.id, contextWindow: null, images: false } })
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

        {provider.models.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有模型。拉取模型列表挑选，或手动添加。</p>
        ) : (
          <ul className="divide-y overflow-hidden rounded-lg border bg-background">
            {provider.models.map((model) => {
              const test = tests[model.id]
              const name = modelDisplayName(model)
              const enabled = model.enabled !== false
              const modelRoles = rolesOf(model.id)
              const meta: ReactNode[] = []
              if (name !== model.id) meta.push(<span key="id" className="font-mono">{model.id}</span>)
              if (model.contextWindow) meta.push(<span key="context" data-testid={`context-window-${model.id}`}>{formatTokens(model.contextWindow)}</span>)
              if (model.images) meta.push('视觉')
              if (reasoningEffortsFor({ protocol: provider.protocol }, model).some((value) => value !== 'default')) meta.push('思考')
              if (modelRoles.length > 0) {
                meta.push(
                  <span key="roles">
                    用于{' '}
                    {modelRoles.map((role, index) => (
                      <Fragment key={role}>
                        {index > 0 && '、'}
                        <span>{ROLE_INFO[role].label}</span>
                      </Fragment>
                    ))}
                  </span>,
                )
              }
              return (
                <li key={model.id} data-testid={`model-row-${model.id}`}>
                  <div className="flex min-h-11 items-center gap-3 px-3 py-2 text-sm">
                    <BrandIcon id={icons?.matchModelIcon(model.id) ?? providerIcon} fallbackText={provider.name} size={16} />
                    <div className="min-w-0 flex-1">
                      <div className={cn('truncate', !enabled && 'text-muted-foreground')}>{name}</div>
                      {meta.length > 0 && (
                        <div className="truncate text-xs text-muted-foreground">
                          {meta.map((part, index) => (
                            <Fragment key={index}>
                              {index > 0 && ' · '}
                              {part}
                            </Fragment>
                          ))}
                        </div>
                      )}
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
                        <DropdownMenuItem onSelect={() => openEditor({ kind: 'existing', model })}>配置能力</DropdownMenuItem>
                        <DropdownMenuItem disabled={test?.state === 'running'} onSelect={() => void runTest(model.id)}>
                          测试连接
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onSelect={() => removeModel(model)}>
                          移除模型
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  {editor?.kind === 'existing' && editor.model.id === model.id && (
                    <div className="border-t">
                      <ModelEditor key={model.id} existing={model} {...editorProps} />
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {editor?.kind === 'new' && (
          <div className="overflow-hidden rounded-lg border bg-background">
            <ModelEditor key={editor.initial?.id ?? 'new'} initial={editor.initial} {...editorProps} />
          </div>
        )}
        {editor?.kind !== 'new' && (
          <Button size="xs" variant="outline" className="bg-background" onClick={() => openEditor({ kind: 'new' })}>
            <Plus className="size-3.5" />
            添加模型
          </Button>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </section>

      <div className="border-t pt-4">
        <Button size="sm" variant="ghost" className="text-destructive hover:bg-destructive-soft hover:text-destructive" onClick={deleteProvider}>
          删除服务
        </Button>
      </div>

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
    </div>
  )
}
