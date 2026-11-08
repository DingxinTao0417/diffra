import { useEffect, useMemo, useState } from 'react'
import type { StoredSessionSummary } from '@diffra/core/types'
import { ArrowLeft, Check, Ellipsis, Monitor, Moon, Sun } from 'lucide-react'
import type { CoreStatus, UpdateStatus } from '../../../../shared/ipc'
import {
  type Appearance,
  COMPACT_AT_PERCENTS,
  CONTENT_WIDTHS,
  type ExecutionSettings,
  FONT_SIZES,
  FONT_STYLES,
  GOAL_ROUND_OPTIONS,
  MAX_STEP_OPTIONS,
  PALETTES,
  type SecuritySettings,
  THEME_MODES,
} from '../../../../shared/settings'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { McpSettings } from '@/features/mcp/McpSettings'
import { ModelSettings } from '@/features/models/ModelSettings'
import { PluginSettings } from '@/features/plugins/PluginSettings'
import { TaskMenu } from '@/features/shell/TaskMenu'
import { UsageSection } from './UsageSection'
import { applyAppearance } from '@/lib/appearance'
import { errorMessage } from '@/lib/errors'
import { folderName, formatBytes, formatTime } from '@/lib/format'
import { INSET_PANEL } from '@/lib/shell'
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
      { id: 'permissions', label: '命令权限', keywords: '权限模式 询问 自动 完全访问' },
      { id: 'security', label: '安全', keywords: '静态检查 轻量扫描 深度扫描 漏洞 注入 密钥' },
      { id: 'execution', label: '任务执行', keywords: '上下文 压缩 摘要 步数 上限 卡死 重复 目标 轮数' },
      { id: 'mcp', label: 'MCP 服务器', keywords: 'MCP 工具 prompt 外部工具' },
      { id: 'plugins', label: '插件', keywords: '插件 自定义命令 斜杠 Skill MCP 安装 Git' },
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
    <div className="flex min-w-0 flex-1">
      <nav aria-label="设置分区" className="flex w-(--sidebar-w) shrink-0 flex-col gap-1 bg-sidebar px-2 py-3">
        <button type="button" className="flex h-8.5 items-center gap-2 rounded-lg px-2 text-left hover:bg-accent" onClick={leaveSettings}>
          <ArrowLeft className="size-4" />
          返回
        </button>
        <input
          aria-label="搜索设置"
          placeholder="搜索设置"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="mx-1 my-2 h-8 rounded-lg border bg-background px-2.5 text-sm outline-none focus:border-ring/60"
        />
        {groups.map((group) => (
          <div key={group.name} className="mb-2 flex flex-col gap-0.5">
            <div className="px-2 pb-1 text-xs text-muted-foreground">{group.name}</div>
            {group.items.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-current={item.id === section ? 'page' : undefined}
                className={cn('flex h-8 items-center rounded-lg px-2 text-left hover:bg-accent', item.id === section && 'bg-soft hover:bg-soft')}
                onClick={() => openSettings(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <main className={cn('min-w-0 flex-1', INSET_PANEL)}>
        <div className="h-full overflow-y-auto">
          <div className="mx-auto max-w-[760px] px-6 py-10 lg:py-12">
            <SectionBody section={section} />
          </div>
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
    case 'permissions':
      return <PermissionsSection />
    case 'security':
      return <SecuritySection />
    case 'execution':
      return <ExecutionSection />
    case 'mcp':
      return <McpSettings />
    case 'plugins':
      return <PluginSettings />
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

const SHORTCUTS = [
  ['Ctrl+N', '新任务'],
  ['Ctrl+K', '搜索任务'],
  ['Ctrl+B', '收起或展开侧栏'],
  ['Ctrl+,', '打开设置'],
  ['Ctrl+`', '打开或收起终端（任务页）'],
  ['Ctrl+Enter', '发送消息'],
  ['Alt+← / Alt+→', '后退 / 前进'],
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
            <div key={keys} className="flex items-center px-3 py-2 text-sm">
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
      <Heading title="外观" />
      <p className="mb-3 text-xs text-muted-foreground">界面样式</p>
      <div className="rounded-xl border bg-card px-4 shadow-xs sm:px-5" data-testid="appearance-settings">
        <div className="border-b border-dashed py-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div><h2 className="text-sm font-medium">主题模式</h2><p className="mt-1 text-xs text-muted-foreground">选择 Diffra 的界面主题和亮暗模式。</p></div>
            <Select value={appearance.theme} onValueChange={(value) => { const theme = THEME_MODES.find((item) => item === value); if (theme) void change({ theme }) }}>
              <SelectTrigger aria-label="主题" className="w-32 bg-background"><SelectValue /></SelectTrigger>
              <SelectContent>{THEME_MODES.map((value) => {
                const Icon = value === 'light' ? Sun : value === 'dark' ? Moon : Monitor
                return <SelectItem key={value} value={value}><Icon className="size-3.5" />{THEME_LABELS[value]}</SelectItem>
              })}</SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" role="radiogroup" aria-label="配色">
            {PALETTES.map((palette) => {
              const item = PALETTE_LABELS[palette]
              const selected = appearance.palette === palette
              return <button key={palette} type="button" role="radio" aria-checked={selected} onClick={() => void change({ palette })} className="group space-y-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg">
                <span className={cn('relative flex h-24 overflow-hidden rounded-lg border transition-shadow group-hover:shadow-sm', selected ? 'border-primary ring-1 ring-primary/30' : 'border-border')} style={{ background: item.side }}>
                  <span className="absolute top-3 left-3 h-1.5 w-1/2 rounded" style={{ background: item.swatch }} />
                  <span className="absolute top-6 left-3 h-1 w-1/3 rounded bg-black/10" />
                  <span className="absolute top-2.5 right-2.5 flex size-4 items-center justify-center rounded-full border bg-white" style={{ borderColor: selected ? item.swatch : '#c9ccc9', color: item.swatch }}>{selected && <Check className="size-3" />}</span>
                  <span className="absolute inset-x-3 top-10 bottom-0 space-y-2 rounded-t-md border border-black/10 bg-white/85 p-3"><span className="block h-1.5 w-3/4 rounded bg-black/20" /><span className="block h-1.5 w-1/2 rounded bg-black/10" /></span>
                </span>
                <span className={selected ? 'font-semibold text-foreground' : 'text-muted-foreground'}>{item.label}</span>
              </button>
            })}
          </div>
        </div>
        <SettingRow label="字体风格" hint="对话内容使用无衬线或衬线字体。">
          <Select value={appearance.fontStyle ?? 'sans'} onValueChange={(value) => { const fontStyle = FONT_STYLES.find((item) => item === value); if (fontStyle) void change({ fontStyle }) }}>
            <SelectTrigger aria-label="字体风格" className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="sans">无衬线</SelectItem><SelectItem value="serif">衬线</SelectItem></SelectContent>
          </Select>
        </SettingRow>
        <SettingRow label="文字大小" hint="调整整个界面的文字和间距大小。">
          <Select value={appearance.fontSize} onValueChange={(value) => { const fontSize = FONT_SIZES.find((item) => item === value); if (fontSize) void change({ fontSize }) }}>
            <SelectTrigger aria-label="文字大小" className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>{FONT_SIZES.map((value) => <SelectItem key={value} value={value}>{FONT_LABELS[value]}</SelectItem>)}</SelectContent>
          </Select>
        </SettingRow>
        <SettingRow label="内容宽度" hint="调整任务内容和输入区域的最大宽度。">
          <Select value={appearance.contentWidth} onValueChange={(value) => { const contentWidth = CONTENT_WIDTHS.find((item) => item === value); if (contentWidth) void change({ contentWidth }) }}>
            <SelectTrigger aria-label="内容宽度" className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>{CONTENT_WIDTHS.map((value) => <SelectItem key={value} value={value}>{WIDTH_LABELS[value]}</SelectItem>)}</SelectContent>
          </Select>
        </SettingRow>
        <div className="border-t border-dashed py-4 text-xs text-muted-foreground">设置立即生效并自动保存，所有项目共用。终端保留等宽字体，不随对话字体改变。</div>
      </div>
    </>
  )
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

const SECURITY_LEVELS: Array<{ key: keyof SecuritySettings; label: string; badge?: string; description: string }> = [
  {
    key: 'staticCheck',
    label: '静态检查',
    badge: '本机',
    description: '每轮完成前检查本轮新增的代码，按规则匹配常见高危写法：SQL 拼接、命令注入、eval、关闭证书校验、硬写的密钥等，发现就打回修改。不调用模型。',
  },
  {
    key: 'lightScan',
    label: '轻量扫描',
    description: '每轮完成前用评审模型审查本轮改动和相关函数，找注入、SSRF、路径穿越、缺少权限校验、敏感信息泄露；依赖文件变了时顺带查已知漏洞（需要联网）。每轮多一次模型调用。',
  },
  {
    key: 'deepScan',
    label: '深度扫描',
    description: '在任务页手动发起：只读地跨文件追踪数据流，从外部输入一路查到危险调用，出一份报告，勾选后交给智能体修复。会多次调用模型。',
  },
]

function SecuritySection() {
  const security = useAppState((state) => state.settings?.security ?? null)
  if (!security) return null

  const change = async (key: keyof SecuritySettings, value: boolean) => {
    const updated = { ...security, [key]: value }
    store.set((state) => (state.settings ? { ...state, settings: { ...state.settings, security: updated } } : state))
    try {
      const settings = await window.diffra.savePreferences({ security: updated })
      store.set((state) => ({ ...state, settings }))
    } catch (error) {
      store.set((state) => (state.settings ? { ...state, settings: { ...state.settings, security } } : state))
      showToast(`保存失败：${errorMessage(error)}`)
    }
  }

  return (
    <>
      <Heading title="安全" description="让智能体写出的代码在完成前过安全检查，问题打回给它修。所有项目共用；新建或重新打开的任务生效。" />
      <div className="mb-2 text-xs text-muted-foreground">扫描层级</div>
      <div className="divide-y rounded-lg border" data-testid="security-levels">
        {SECURITY_LEVELS.map((level) => (
          <div key={level.key} className="flex items-start gap-4 px-4 py-3.5">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center gap-2 font-medium">
                {level.label}
                {level.badge && <span className="rounded bg-muted px-1.5 text-xs font-normal text-muted-foreground">{level.badge}</span>}
              </div>
              <div className="text-sm text-muted-foreground">{level.description}</div>
            </div>
            <div className="flex h-lh items-center">
              <Switch label={level.label} checked={security[level.key]} onChange={(value) => void change(level.key, value)} />
            </div>
          </div>
        ))}
      </div>
      <p className="mt-4 text-sm text-muted-foreground">
        这些检查能拦下常见的问题，但不能保证没有漏洞；规则抓不到的业务逻辑问题，还要靠测试和你的审阅。
      </p>
    </>
  )
}

const COMPACT_OPTIONS = COMPACT_AT_PERCENTS.map((value) => ({ value: String(value), label: `${value}%` }))
const NO_STEP_LIMIT = 'none'
const STEP_OPTIONS = [...MAX_STEP_OPTIONS.map((value) => ({ value: String(value), label: `${value} 步` })), { value: NO_STEP_LIMIT, label: '无上限' }]
const GOAL_ROUND_SEGMENTS = GOAL_ROUND_OPTIONS.map((value) => ({ value: String(value), label: `${value} 轮` }))

function ExecutionSection() {
  const execution = useAppState((state) => state.settings?.execution ?? null)
  if (!execution) return null

  const change = async (next: Partial<ExecutionSettings>) => {
    const updated = { ...execution, ...next }
    store.set((state) => (state.settings ? { ...state, settings: { ...state.settings, execution: updated } } : state))
    try {
      const settings = await window.diffra.savePreferences({ execution: updated })
      store.set((state) => ({ ...state, settings }))
    } catch (error) {
      store.set((state) => (state.settings ? { ...state, settings: { ...state.settings, execution } } : state))
      showToast(`保存失败：${errorMessage(error)}`)
    }
  }
  const changeCompactAt = (value: string) => {
    const percent = COMPACT_AT_PERCENTS.find((item) => String(item) === value)
    if (percent) void change({ compactAtPercent: percent })
  }
  const changeMaxSteps = (value: string) => {
    if (value === NO_STEP_LIMIT) return void change({ maxSteps: null })
    const steps = MAX_STEP_OPTIONS.find((item) => String(item) === value)
    if (steps) void change({ maxSteps: steps })
  }
  const changeGoalRounds = (value: string) => {
    const rounds = GOAL_ROUND_OPTIONS.find((item) => String(item) === value)
    if (rounds) void change({ goalMaxRounds: rounds })
  }

  return (
    <>
      <Heading title="任务执行" description="所有项目共用；新建或重新打开的任务生效。" />
      <SettingRow
        label="上下文压缩"
        hint="上下文用到模型窗口的这个比例时，先省略较早的工具输出，还不够再把早期对话压成摘要，然后接着做。比例越低越省 token，越高保留的原文越多。"
      >
        <Segmented label="上下文压缩" value={String(execution.compactAtPercent)} options={COMPACT_OPTIONS} onChange={changeCompactAt} />
      </SettingRow>
      <SettingRow label="单次任务步数上限" hint="模型每回复一次算一步，到了上限就停下等你发话。智能体反复做同样的操作时，不管有没有上限都会自动停下。">
        <Segmented label="单次任务步数上限" value={execution.maxSteps === null ? NO_STEP_LIMIT : String(execution.maxSteps)} options={STEP_OPTIONS} onChange={changeMaxSteps} />
      </SettingRow>
      <SettingRow
        label="目标模式轮数上限"
        hint="输入框里用 /目标 发的任务，智能体每轮做完自己判断目标达成没有，没达成就接着做下一轮，到这个轮数还没完成就停下说明还差什么。每轮各有一份步数上限。"
      >
        <Segmented label="目标模式轮数上限" value={String(execution.goalMaxRounds)} options={GOAL_ROUND_SEGMENTS} onChange={changeGoalRounds} />
      </SettingRow>
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
    <div className="flex items-center gap-3 px-3 py-2 text-sm" data-testid="archived-task">
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
        <span className="text-sm text-muted-foreground" data-testid="app-version">
          {version ?? '…'}
        </span>
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
