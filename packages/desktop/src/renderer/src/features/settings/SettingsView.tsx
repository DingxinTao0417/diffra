import { useEffect, useMemo, useState } from 'react'
import type { StoredSessionSummary } from '@diffra/core/types'
import { ArrowLeft, Ellipsis } from 'lucide-react'
import type { CoreStatus, UpdateStatus } from '../../../../shared/ipc'
import { type Appearance, CONTENT_WIDTHS, FONT_SIZES, PALETTES, THEME_MODES } from '../../../../shared/settings'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { ModelSettings } from '@/features/models/ModelSettings'
import { RulesView } from '@/features/rules/RulesView'
import { TaskMenu } from '@/features/shell/TaskMenu'
import { UsageSection } from './UsageSection'
import { applyAppearance } from '@/lib/appearance'
import { errorMessage } from '@/lib/errors'
import { folderName, formatBytes, formatTime } from '@/lib/format'
import { PERMISSION_MODES } from '@/lib/permission-modes'
import { leaveSettings, openSettings, setArchived, setPermissionMode } from '@/state/actions'
import { type SettingsSection, showToast, store, useAppState } from '@/state/store'

const GROUPS: Array<{ name: string; items: Array<{ id: SettingsSection; label: string; keywords: string }> }> = [
  {
    name: '通用',
    items: [
      { id: 'general', label: '常规', keywords: '快捷键 连接 core' },
      { id: 'appearance', label: '外观', keywords: '主题 深色 浅色 配色 字号 文字大小 宽度' },
    ],
  },
  {
    name: '智能体',
    items: [
      { id: 'models', label: '模型与角色', keywords: '供应商 API Key 编码 评审 规划' },
      { id: 'rules', label: '规范', keywords: '规则包 编码规范 审查' },
      { id: 'permissions', label: '命令权限', keywords: '权限模式 询问 自动 完全访问' },
    ],
  },
  {
    name: '数据',
    items: [
      { id: 'storage', label: '会话与存储', keywords: '归档 删除 磁盘 记录' },
      { id: 'usage', label: '用量', keywords: 'token 统计 模型调用 缓存' },
    ],
  },
  { name: '应用', items: [{ id: 'about', label: '更新与关于', keywords: '版本 更新' }] },
]

export function SettingsView({ section }: { section: SettingsSection }) {
  const [query, setQuery] = useState('')
  const text = query.trim().toLowerCase()
  const groups = GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !text || `${item.label} ${item.keywords}`.toLowerCase().includes(text)),
  })).filter((group) => group.items.length > 0)

  return (
    <div className="flex h-full min-w-0">
      <nav aria-label="设置分区" className="flex w-60 shrink-0 flex-col gap-1 border-r border-sidebar-border bg-sidebar px-2.5 py-3">
        <button type="button" className="flex h-8.5 items-center gap-2 rounded-lg px-2.5 text-left hover:bg-accent" onClick={leaveSettings}>
          <ArrowLeft className="size-4" />
          返回
        </button>
        <input
          aria-label="搜索设置"
          placeholder="搜索设置"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="mx-1 my-2 h-8 rounded-lg border bg-background px-2.5 text-[0.93rem] outline-none focus:border-ring/60"
        />
        {groups.map((group) => (
          <div key={group.name} className="mb-2 flex flex-col gap-0.5">
            <div className="px-2.5 pb-1 text-xs text-muted-foreground">{group.name}</div>
            {group.items.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-current={item.id === section ? 'page' : undefined}
                className={cn('flex h-8 items-center rounded-lg px-2.5 text-left hover:bg-accent', item.id === section && 'bg-soft font-medium hover:bg-soft')}
                onClick={() => openSettings(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 py-8">
          <SectionBody section={section} />
        </div>
      </main>
    </div>
  )
}

function SectionBody({ section }: { section: SettingsSection }) {
  switch (section) {
    case 'general':
      return <GeneralSection />
    case 'appearance':
      return <AppearanceSection />
    case 'models':
      return <ModelSettings />
    case 'rules':
      return <RulesSection />
    case 'permissions':
      return <PermissionsSection />
    case 'storage':
      return <StorageSection />
    case 'usage':
      return <UsageSection />
    case 'about':
      return <AboutSection />
  }
}

function Heading({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-6 space-y-1">
      <h1 className="text-xl font-semibold">{title}</h1>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </div>
  )
}

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-4 border-b py-4 last:border-b-0">
      <div className="min-w-48 flex-1 space-y-0.5">
        <div className="font-medium">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ value: T; label: string }>; onChange(value: T): void }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-lg bg-muted p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className={cn('h-7 rounded-md px-3 text-[0.93rem]', option.value === value ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground')}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

const SHORTCUTS = [
  ['Ctrl+K', '搜索任务'],
  ['Ctrl+B', '收起或展开侧栏'],
  ['Ctrl+,', '打开设置'],
  ['Ctrl+`', '打开或收起终端（任务页）'],
  ['Ctrl+Enter', '发送消息'],
  ['Esc', '关闭对话框和菜单'],
] as const

function GeneralSection() {
  const status = useCoreStatus()
  return (
    <>
      <Heading title="常规" />
      <SettingRow label="Core" hint="在后台运行智能体的进程">
        <span className={cn('text-sm', status?.state === 'failed' ? 'text-destructive' : 'text-muted-foreground')} data-testid="core-status">
          {describeCoreStatus(status)}
        </span>
      </SettingRow>
      <div className="py-4">
        <div className="mb-2 font-medium">快捷键</div>
        <div className="divide-y rounded-lg border">
          {SHORTCUTS.map(([keys, action]) => (
            <div key={keys} className="flex items-center px-3 py-2 text-[0.93rem]">
              <span className="flex-1">{action}</span>
              <kbd className="rounded border bg-muted px-1.5 font-mono text-xs">{keys}</kbd>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

const THEME_LABELS: Record<Appearance['theme'], string> = { light: '浅色', dark: '深色', system: '跟随系统' }
const PALETTE_LABELS: Record<Appearance['palette'], { label: string; swatch: string; side: string }> = {
  forest: { label: '森绿', swatch: '#2E6B57', side: '#F5F5F2' },
  indigo: { label: '靛蓝', swatch: '#3B4BA8', side: '#F3F4F8' },
  amber: { label: '琥珀', swatch: '#9A5B13', side: '#F8F5EE' },
  graphite: { label: '石墨', swatch: '#3A3A3A', side: '#F3F3F3' },
}
const FONT_LABELS: Record<Appearance['fontSize'], string> = { sm: '小', md: '标准', lg: '大' }
const WIDTH_LABELS: Record<Appearance['contentWidth'], string> = { standard: '标准', wide: '宽' }

function AppearanceSection() {
  const appearance = useAppState((state) => state.settings?.appearance ?? null)
  if (!appearance) return null

  // 先在界面上生效再保存；保存失败就退回原来的外观
  const change = async (next: Partial<Appearance>) => {
    const updated = { ...appearance, ...next }
    applyAppearance(updated)
    store.set((state) => (state.settings ? { ...state, settings: { ...state.settings, appearance: updated } } : state))
    try {
      const settings = await window.diffra.savePreferences({ appearance: updated })
      store.set((state) => ({ ...state, settings }))
    } catch (error) {
      applyAppearance(appearance)
      store.set((state) => (state.settings ? { ...state, settings: { ...state.settings, appearance } } : state))
      showToast(`保存外观失败：${errorMessage(error)}`)
    }
  }

  return (
    <>
      <Heading title="外观" description="改动立即生效，所有项目共用。" />
      <SettingRow label="主题" hint="跟随系统时按 Windows 的深浅色设置切换">
        <Segmented label="主题" value={appearance.theme} options={THEME_MODES.map((value) => ({ value, label: THEME_LABELS[value] }))} onChange={(theme) => void change({ theme })} />
      </SettingRow>
      <SettingRow label="配色" hint="强调色和侧栏底色">
        <div className="flex gap-2.5" role="radiogroup" aria-label="配色">
          {PALETTES.map((palette) => {
            const item = PALETTE_LABELS[palette]
            const active = appearance.palette === palette
            return (
              <button
                key={palette}
                type="button"
                role="radio"
                aria-checked={active}
                className="flex flex-col items-center gap-1.5 text-xs"
                onClick={() => void change({ palette })}
              >
                <span className={cn('flex h-10 w-14 overflow-hidden rounded-lg border-2', active ? 'border-primary' : 'border-border')}>
                  <span className="w-4" style={{ background: item.side }} />
                  <span className="flex flex-1 items-end bg-white p-1">
                    <span className="h-2 w-full rounded-sm" style={{ background: item.swatch }} />
                  </span>
                </span>
                <span className={cn(active ? 'font-medium' : 'text-muted-foreground')}>{item.label}</span>
              </button>
            )
          })}
        </div>
      </SettingRow>
      <SettingRow label="文字大小" hint="对话、输入框和侧栏的字号">
        <Segmented label="文字大小" value={appearance.fontSize} options={FONT_SIZES.map((value) => ({ value, label: FONT_LABELS[value] }))} onChange={(fontSize) => void change({ fontSize })} />
      </SettingRow>
      <SettingRow label="内容宽度" hint="对话区和输入框的最大宽度">
        <Segmented
          label="内容宽度"
          value={appearance.contentWidth}
          options={CONTENT_WIDTHS.map((value) => ({ value, label: WIDTH_LABELS[value] }))}
          onChange={(contentWidth) => void change({ contentWidth })}
        />
      </SettingRow>
    </>
  )
}

function RulesSection() {
  const projects = useAppState((state) => state.projects)
  const lastWorkRoute = useAppState((state) => state.lastWorkRoute)
  const live = useAppState((state) => state.live)
  // 默认显示刚才在用的项目
  const current = lastWorkRoute.name === 'task' ? (live[lastWorkRoute.sessionId]?.project ?? null) : lastWorkRoute.name === 'home' ? lastWorkRoute.project : null
  const [picked, setPicked] = useState<string | null>(null)
  const projectPath = picked ?? current ?? projects[0] ?? null
  return <RulesView projectPath={projectPath} projects={projects} onProjectChange={setPicked} />
}

function PermissionsSection() {
  const mode = useAppState((state) => state.settings?.defaultPermissionMode ?? 'ask')
  return (
    <>
      <Heading title="命令权限" description="智能体执行命令前要不要先问你。新任务用这里的默认值；在输入框里换了模式也会记成默认值。" />
      <div className="space-y-2" role="radiogroup" aria-label="默认权限模式">
        {PERMISSION_MODES.map((item) => (
          <button
            key={item.mode}
            type="button"
            role="radio"
            aria-checked={item.mode === mode}
            className={cn('flex w-full items-start gap-3 rounded-lg border px-4 py-3 text-left', item.mode === mode ? 'border-primary bg-soft' : 'hover:bg-muted/60')}
            onClick={() => void setPermissionMode(null, item.mode)}
          >
            <span className={cn('mt-1 size-3.5 shrink-0 rounded-full border-2', item.mode === mode ? 'border-primary bg-primary' : 'border-input')} />
            <span className="space-y-0.5">
              <span className={cn('block font-medium', item.mode === 'full' && 'text-destructive')}>{item.label}</span>
              <span className="block text-sm text-muted-foreground">{item.description}</span>
            </span>
          </button>
        ))}
      </div>
      <p className="mt-4 text-sm text-muted-foreground">
        不管哪种模式：危险命令清单直接拦截；读写 .env、私钥等密钥文件和改动禁写目录的命令总要先问你。
      </p>
    </>
  )
}

function StorageSection() {
  const tasks = useAppState((state) => state.tasks)
  const [storage, setStorage] = useState<{ bytes: number; dir: string } | null>(null)
  const archived = useMemo(() => tasks.filter((task) => task.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [tasks])

  useEffect(() => {
    window.diffra.sessionsStorage().then(setStorage, (error: unknown) => showToast(errorMessage(error)))
  }, [tasks])

  return (
    <>
      <Heading title="会话与存储" description="任务的对话记录保存在本机，不含 API Key。" />
      <SettingRow label="任务记录" hint={storage?.dir}>
        <span className="text-sm text-muted-foreground">
          {tasks.length} 个任务 · {storage ? formatBytes(storage.bytes) : '…'}
        </span>
        {storage && (
          <Button size="sm" variant="outline" onClick={() => window.diffra.openProjectFolder(storage.dir).catch((error: unknown) => showToast(errorMessage(error)))}>
            打开文件夹
          </Button>
        )}
      </SettingRow>
      <div className="py-4">
        <div className="mb-2 font-medium">已归档的任务</div>
        {archived.length === 0 ? (
          <p className="text-sm text-muted-foreground">没有归档的任务</p>
        ) : (
          <div className="divide-y rounded-lg border">
            {archived.map((task) => (
              <ArchivedRow key={task.sessionId} task={task} />
            ))}
          </div>
        )}
      </div>
    </>
  )
}

function ArchivedRow({ task }: { task: StoredSessionSummary }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 text-[0.93rem]" data-testid="archived-task">
      <span className="min-w-0 flex-1 truncate">{task.title}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{folderName(task.cwd)}</span>
      <span className="w-12 shrink-0 text-right text-xs text-muted-foreground">{formatTime(task.updatedAt)}</span>
      <Button size="sm" variant="ghost" onClick={() => void setArchived(task.sessionId, false)}>
        取消归档
      </Button>
      <TaskMenu sessionId={task.sessionId} title={task.title} project={task.cwd} archived align="end">
        <button type="button" aria-label="任务菜单" className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted">
          <Ellipsis className="size-4" />
        </button>
      </TaskMenu>
    </div>
  )
}

function AboutSection() {
  const [version, setVersion] = useState<string | null>(null)
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    window.diffra.getAppVersion().then(setVersion, (error: unknown) => console.error('读取版本号失败', error))
    const unsubscribe = window.diffra.onUpdateStatus(setStatus)
    window.diffra.getUpdateStatus().then(setStatus, (error: unknown) => setStatus({ state: 'error', message: errorMessage(error) }))
    return unsubscribe
  }, [])
  const canCheck = status?.state === 'idle' || status?.state === 'up-to-date' || status?.state === 'error'
  return (
    <>
      <Heading title="更新与关于" />
      <SettingRow label="版本">
        <span className="text-sm text-muted-foreground">{version ?? '…'}</span>
      </SettingRow>
      <SettingRow label="更新">
        <span className="text-sm text-muted-foreground" data-testid="update-status">
          {status ? describeUpdateStatus(status) : '…'}
        </span>
        {status?.state === 'downloaded' && (
          <Button size="sm" onClick={() => window.diffra.installUpdate().catch((error: unknown) => showToast(errorMessage(error)))}>
            重启并更新
          </Button>
        )}
        {canCheck && (
          <Button size="sm" variant="outline" onClick={() => window.diffra.checkForUpdates().catch((error: unknown) => showToast(errorMessage(error)))}>
            检查更新
          </Button>
        )}
      </SettingRow>
    </>
  )
}

function useCoreStatus(): CoreStatus | null {
  const [status, setStatus] = useState<CoreStatus | null>(null)
  useEffect(() => {
    window.diffra.getCoreStatus().then(setStatus, (error: unknown) => setStatus({ state: 'failed', error: errorMessage(error) }))
  }, [])
  return status
}

function describeCoreStatus(status: CoreStatus | null): string {
  if (status === null) return '正在连接…'
  if (status.state === 'failed') return `连接失败：${status.error}`
  return `已连接：${status.agentName} ${status.agentVersion} · ACP 协议 v${status.protocolVersion}`
}

function describeUpdateStatus(status: UpdateStatus): string {
  switch (status.state) {
    case 'disabled':
      return '开发模式不检查更新'
    case 'idle':
      return '尚未检查更新'
    case 'checking':
      return '正在检查更新…'
    case 'up-to-date':
      return '已是最新版本'
    case 'downloading':
      return `正在下载新版本 ${status.version}（${status.percent}%）`
    case 'downloaded':
      return `新版本 ${status.version} 已下载`
    case 'error':
      return `检查更新失败：${status.message}`
  }
}
