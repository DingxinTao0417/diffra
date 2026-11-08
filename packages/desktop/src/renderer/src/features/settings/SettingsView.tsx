import { type CSSProperties, type ReactNode, useEffect, useMemo, useState } from 'react'
import type { PermissionMode, StoredSessionSummary } from '@diffra/core/types'
import {
  Archive,
  ArrowLeft,
  BarChart3,
  Bot,
  Check,
  Ellipsis,
  HardDrive,
  Info,
  ListChecks,
  type LucideIcon,
  Monitor,
  Moon,
  Palette,
  Plug,
  Puzzle,
  Search,
  Settings2,
  Shield,
  ShieldCheck,
  Sun,
  TriangleAlert,
} from 'lucide-react'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { McpSettings } from '@/features/mcp/McpSettings'
import { ModelSettings } from '@/features/models/ModelSettings'
import { PluginSettings } from '@/features/plugins/PluginSettings'
import { TaskMenu } from '@/features/shell/TaskMenu'
import { SettingsGroup, SettingsHeader, SettingsRow } from './SettingsLayout'
import { UsageSection } from './UsageSection'
import { applyAppearance } from '@/lib/appearance'
import { errorMessage } from '@/lib/errors'
import { folderName, formatBytes, formatTime } from '@/lib/format'
import { INSET_PANEL } from '@/lib/shell'
import { PERMISSION_MODES } from '@/lib/permission-modes'
import { leaveSettings, openSettings, setArchived, setPermissionMode } from '@/state/actions'
import { type SettingsSection, showToast, store, useAppState } from '@/state/store'

const GROUPS: Array<{ name: string; items: Array<{ id: SettingsSection; label: string; icon: LucideIcon; keywords: string }> }> = [
  {
    name: '通用',
    items: [
      { id: 'general', label: '常规', icon: Settings2, keywords: '快捷键 连接 core' },
      { id: 'appearance', label: '外观', icon: Palette, keywords: '主题 深色 浅色 配色 字号 文字大小 宽度' },
    ],
  },
  {
    name: '智能体',
    items: [
      { id: 'models', label: '模型与角色', icon: Bot, keywords: '供应商 API Key 编码 评审 规划' },
      { id: 'permissions', label: '命令权限', icon: ShieldCheck, keywords: '权限模式 询问 自动 完全访问' },
      { id: 'security', label: '安全', icon: Shield, keywords: '静态检查 轻量扫描 深度扫描 漏洞 注入 密钥' },
      { id: 'execution', label: '任务执行', icon: ListChecks, keywords: '上下文 压缩 摘要 步数 上限 卡死 重复 目标 轮数' },
      { id: 'mcp', label: 'MCP 服务器', icon: Plug, keywords: 'MCP 工具 提示词模板 prompt 外部工具' },
      { id: 'plugins', label: '插件', icon: Puzzle, keywords: '插件 自定义命令 斜杠 Skill MCP 安装 Git' },
    ],
  },
  {
    name: '数据',
    items: [
      { id: 'storage', label: '会话与存储', icon: HardDrive, keywords: '归档 删除 磁盘 记录' },
      { id: 'usage', label: '用量', icon: BarChart3, keywords: 'token 统计 模型调用 缓存' },
    ],
  },
  { name: '应用', items: [{ id: 'about', label: '更新与关于', icon: Info, keywords: '版本 更新' }] },
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
        <button type="button" className="flex h-8 items-center gap-2.5 rounded-lg px-2 text-left hover:bg-accent" onClick={leaveSettings}>
          <ArrowLeft className="size-4" />
          返回
        </button>
        <div className="relative my-2">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="搜索设置" placeholder="搜索设置" value={query} onChange={(event) => setQuery(event.target.value)} className="bg-background pl-8" />
        </div>
        {groups.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">没有匹配的设置</p>}
        {groups.map((group) => (
          <div key={group.name} className="mb-2 flex flex-col gap-0.5">
            <div className="px-2 pb-1 text-xs text-muted-foreground">{group.name}</div>
            {group.items.map((item) => {
              const selected = item.id === section
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={selected ? 'page' : undefined}
                  className={cn('flex h-8 items-center gap-2.5 rounded-lg px-2 text-left hover:bg-accent', selected && 'bg-soft text-foreground hover:bg-soft')}
                  onClick={() => openSettings(item.id)}
                >
                  <item.icon className={cn('size-4 shrink-0', selected ? 'text-foreground' : 'text-muted-foreground')} />
                  {item.label}
                </button>
              )
            })}
          </div>
        ))}
      </nav>
      <main className={cn('min-w-0 flex-1', INSET_PANEL)}>
        <div className="h-full overflow-y-auto [scrollbar-gutter:stable]">
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

const SHORTCUTS: Array<{ keys: string[]; action: string }> = [
  { keys: ['Ctrl', 'N'], action: '新任务' },
  { keys: ['Ctrl', 'K'], action: '搜索任务' },
  { keys: ['Ctrl', 'B'], action: '收起或展开侧栏' },
  { keys: ['Ctrl', ','], action: '打开设置' },
  { keys: ['Ctrl', '`'], action: '打开或收起终端（任务页）' },
  { keys: ['Ctrl', 'Enter'], action: '发送消息' },
  { keys: ['Alt', '←'], action: '后退' },
  { keys: ['Alt', '→'], action: '前进' },
  { keys: ['Esc'], action: '关闭对话框和菜单' },
]

function GeneralSection() {
  const status = useCoreStatus()
  return (
    <>
      <SettingsHeader title="常规" />
      <SettingsGroup title="连接">
        <SettingsRow label="智能体服务" hint="在后台运行任务的本地进程">
          <CoreStatusView status={status} />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="快捷键">
        {SHORTCUTS.map(({ keys, action }) => (
          <div key={action} className="flex h-10 items-center gap-4 px-4 text-base">
            <span className="flex-1">{action}</span>
            <KbdGroup>{keys.map((key) => <Kbd key={key}>{key}</Kbd>)}</KbdGroup>
          </div>
        ))}
      </SettingsGroup>
    </>
  )
}

function CoreStatusView({ status }: { status: CoreStatus | null }) {
  const headline = status === null ? '正在连接…' : status.state === 'failed' ? '连接失败' : '已连接'
  const detail = status === null ? null : status.state === 'failed' ? status.error : `${status.agentName} ${status.agentVersion} · ACP 协议 v${status.protocolVersion}`
  return (
    <div className="flex max-w-80 flex-col items-end gap-0.5 text-right" data-testid="core-status">
      <span className="flex items-center gap-1.5 text-sm">
        <span className={cn('size-1.5 shrink-0 rounded-full', status === null ? 'animate-pulse bg-muted-foreground' : status.state === 'failed' ? 'bg-destructive' : 'bg-muted-foreground')} />
        {headline}
      </span>
      {detail && <span className={cn('text-xs break-words select-text', status?.state === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>{detail}</span>}
    </div>
  )
}

const THEME_LABELS: Record<Appearance['theme'], string> = { light: '浅色', dark: '深色', system: '跟随系统' }
// 和 styles.css 里各配色的 --primary、浅色 --sidebar 保持一致；深色侧栏各配色相同，直接用 --sidebar
const PALETTE_LABELS: Record<Appearance['palette'], { label: string; swatch: string; swatchDark: string; side: string }> = {
  forest: { label: '森绿', swatch: '#2e6b57', swatchDark: '#5fa88c', side: '#f5f5f2' },
  indigo: { label: '靛蓝', swatch: '#3b4ba8', swatchDark: '#8c98e6', side: '#f3f4f8' },
  amber: { label: '琥珀', swatch: '#9a5b13', swatchDark: '#d49a52', side: '#f8f5ee' },
  graphite: { label: '石墨', swatch: '#3a3a3a', swatchDark: '#d0d0d0', side: '#f3f3f3' },
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
      <SettingsHeader title="外观" />
      <SettingsGroup data-testid="appearance-settings">
        <SettingsRow label="主题" hint="浅色、深色或跟随系统。">
          <Select value={appearance.theme} onValueChange={(value) => { const theme = THEME_MODES.find((item) => item === value); if (theme) void change({ theme }) }}>
            <SelectTrigger aria-label="主题" className="w-32 bg-background"><SelectValue /></SelectTrigger>
            <SelectContent>{THEME_MODES.map((value) => {
              const Icon = value === 'light' ? Sun : value === 'dark' ? Moon : Monitor
              return <SelectItem key={value} value={value}><Icon className="size-3.5" />{THEME_LABELS[value]}</SelectItem>
            })}</SelectContent>
          </Select>
        </SettingsRow>
        <div>
          <SettingsRow label="强调色" hint="按钮、当前项和侧栏使用的颜色。" />
          <div className="grid grid-cols-2 gap-3 px-4 pb-4 sm:grid-cols-4" role="radiogroup" aria-label="配色">
            {PALETTES.map((palette) => {
              const item = PALETTE_LABELS[palette]
              const selected = appearance.palette === palette
              return <button
                key={palette}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => void change({ palette })}
                // 缩略图按当前亮暗模式取这套配色的颜色，不跟着当前选中的配色走
                style={{ '--thumb-light': item.swatch, '--thumb-dark': item.swatchDark, '--thumb-side': item.side } as CSSProperties}
                className="group space-y-2 rounded-lg text-xs outline-none [--thumb:var(--thumb-light)] focus-visible:ring-2 focus-visible:ring-ring dark:[--thumb:var(--thumb-dark)]"
              >
                <span className={cn('relative flex h-24 overflow-hidden rounded-lg border bg-(--thumb-side) dark:bg-sidebar', selected ? 'border-primary ring-1 ring-primary/30' : 'border-border group-hover:border-input')}>
                  <span className="absolute top-3 left-3 h-1.5 w-1/2 rounded bg-(--thumb)" />
                  <span className="absolute top-6 left-3 h-1 w-1/3 rounded bg-foreground/10" />
                  <span className={cn('absolute top-2.5 right-2.5 flex size-4 items-center justify-center rounded-full border bg-background text-(--thumb)', selected ? 'border-(--thumb)' : 'border-input')}>{selected && <Check className="size-3" />}</span>
                  <span className="absolute inset-x-3 top-10 bottom-0 space-y-2 rounded-t-md border border-border bg-background p-3"><span className="block h-1.5 w-3/4 rounded bg-foreground/20" /><span className="block h-1.5 w-1/2 rounded bg-foreground/10" /></span>
                </span>
                <span className={selected ? 'text-foreground' : 'text-muted-foreground'}>{item.label}</span>
              </button>
            })}
          </div>
        </div>
        <SettingsRow label="字体风格" hint="对话内容使用无衬线或衬线字体。">
          <Select value={appearance.fontStyle ?? 'sans'} onValueChange={(value) => { const fontStyle = FONT_STYLES.find((item) => item === value); if (fontStyle) void change({ fontStyle }) }}>
            <SelectTrigger aria-label="字体风格" className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="sans">无衬线</SelectItem><SelectItem value="serif">衬线</SelectItem></SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow label="文字大小" hint="调整整个界面的文字和间距大小。">
          <Select value={appearance.fontSize} onValueChange={(value) => { const fontSize = FONT_SIZES.find((item) => item === value); if (fontSize) void change({ fontSize }) }}>
            <SelectTrigger aria-label="文字大小" className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>{FONT_SIZES.map((value) => <SelectItem key={value} value={value}>{FONT_LABELS[value]}</SelectItem>)}</SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow label="内容宽度" hint="调整任务内容和输入区域的最大宽度。">
          <Select value={appearance.contentWidth} onValueChange={(value) => { const contentWidth = CONTENT_WIDTHS.find((item) => item === value); if (contentWidth) void change({ contentWidth }) }}>
            <SelectTrigger aria-label="内容宽度" className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>{CONTENT_WIDTHS.map((value) => <SelectItem key={value} value={value}>{WIDTH_LABELS[value]}</SelectItem>)}</SelectContent>
          </Select>
        </SettingsRow>
      </SettingsGroup>
      <p className="mt-3 text-xs text-muted-foreground">设置立即生效并自动保存，所有项目共用。终端保留等宽字体，不随对话字体改变。</p>
    </>
  )
}

// 自动保存成功后在页头短暂提示；连续改动会重新计时
function useSavedFlash(): [boolean, () => void] {
  const [savedAt, setSavedAt] = useState(0)
  useEffect(() => {
    if (savedAt === 0) return
    const timer = setTimeout(() => setSavedAt(0), 1500)
    return () => clearTimeout(timer)
  }, [savedAt])
  return [savedAt !== 0, () => setSavedAt(Date.now())]
}

function SavedHint({ shown }: { shown: boolean }) {
  // 看得见的部分只做淡出；读屏靠单独的 status 区域在内容变化时播报
  return (
    <span className="flex h-8 items-center">
      <span
        aria-hidden="true"
        className={cn('flex items-center gap-1 text-xs text-muted-foreground', shown ? 'opacity-100' : 'opacity-0 transition-opacity duration-300 motion-reduce:transition-none')}
      >
        <Check className="size-3.5" />
        已保存
      </span>
      <span role="status" className="sr-only">{shown ? '已保存' : ''}</span>
    </span>
  )
}

function DetailTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`${label}说明`}
          className="ml-1 inline-flex size-4 items-center justify-center rounded-sm align-middle text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{children}</TooltipContent>
    </Tooltip>
  )
}

function PermissionsSection() {
  const mode = useAppState((state) => state.settings?.defaultPermissionMode ?? 'ask')
  const [saved, flashSaved] = useSavedFlash()
  const choose = async (next: PermissionMode) => {
    if (next === mode) return
    await setPermissionMode(null, next)
    // setPermissionMode 失败时只弹 toast、不改设置，按存下来的值判断是否成功
    if (store.get().settings?.defaultPermissionMode === next) flashSaved()
  }
  return (
    <>
      <SettingsHeader
        title="命令权限"
        description="智能体执行命令前要不要先问你。新任务用这里的默认值；在输入框里换了模式也会记成默认值。"
        actions={<SavedHint shown={saved} />}
      />
      <SettingsGroup role="radiogroup" aria-label="默认权限模式">
        {PERMISSION_MODES.map((item) => {
          const checked = item.mode === mode
          return (
            <button
              key={item.mode}
              type="button"
              role="radio"
              aria-checked={checked}
              className={cn('flex w-full items-start gap-3 px-4 py-3 text-left outline-none first:rounded-t-xl last:rounded-b-xl hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset', checked && 'bg-soft hover:bg-soft')}
              onClick={() => void choose(item.mode)}
            >
              <span className={cn('mt-1 flex size-4 shrink-0 items-center justify-center rounded-full border', checked ? 'border-primary' : 'border-muted-foreground/70')}>
                {checked && <span className="size-1.5 rounded-full bg-primary" />}
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-base">
                  {item.label}
                  {item.mode === 'full' && (
                    <>
                      <TriangleAlert aria-hidden="true" className="size-3.5 text-warning" />
                      <span className="sr-only">（高风险）</span>
                    </>
                  )}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{item.description}</span>
              </span>
            </button>
          )
        })}
      </SettingsGroup>
      <p className="mt-4 text-sm text-muted-foreground">
        不管哪种模式：危险命令清单直接拦截；读写 .env、私钥等密钥文件和改动禁写目录的命令总要先问你。
      </p>
    </>
  )
}

const SECURITY_LEVELS: Array<{ key: keyof SecuritySettings; label: string; trigger: string; cost: string; description: string; detail: string }> = [
  {
    key: 'staticCheck',
    label: '静态检查',
    trigger: '完成前自动',
    cost: '本机，不调用模型',
    description: '按规则检查本轮新增的代码，发现高危写法就打回修改。',
    detail: '匹配 SQL 拼接、命令注入、eval、关闭证书校验、硬写的密钥等常见高危写法。',
  },
  {
    key: 'lightScan',
    label: '轻量扫描',
    trigger: '完成前自动',
    cost: '每轮多一次模型调用',
    description: '让评审模型审查本轮改动，发现问题就打回修改。',
    detail: '查注入、SSRF、路径穿越、缺少权限校验、敏感信息泄露；依赖文件变了时顺带查已知漏洞，需要联网。',
  },
  {
    key: 'deepScan',
    label: '深度扫描',
    trigger: '手动',
    cost: '多次模型调用',
    description: '在任务页显示深度扫描入口',
    detail: '从任务页发起后，只读地跨文件追踪数据流，从外部输入一路查到危险调用，出一份报告，勾选后交给智能体修复。',
  },
]

function SecuritySection() {
  const security = useAppState((state) => state.settings?.security ?? null)
  const [saved, flashSaved] = useSavedFlash()
  if (!security) return null

  const change = async (key: keyof SecuritySettings, value: boolean) => {
    const updated = { ...security, [key]: value }
    store.set((state) => (state.settings ? { ...state, settings: { ...state.settings, security: updated } } : state))
    try {
      const settings = await window.diffra.savePreferences({ security: updated })
      store.set((state) => ({ ...state, settings }))
      flashSaved()
    } catch (error) {
      store.set((state) => (state.settings ? { ...state, settings: { ...state.settings, security } } : state))
      showToast(`保存失败：${errorMessage(error)}`)
    }
  }

  return (
    <>
      <SettingsHeader
        title="安全"
        description="让智能体写出的代码在完成前过安全检查，问题打回给它修。所有项目共用；新建或重新打开的任务生效。"
        actions={<SavedHint shown={saved} />}
      />
      <SettingsGroup data-testid="security-levels">
        {SECURITY_LEVELS.map((level) => (
          <SettingsRow
            key={level.key}
            label={
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {level.label}
                <span className="flex gap-1">
                  <Badge variant="outline">{level.trigger}</Badge>
                  <Badge variant="outline">{level.cost}</Badge>
                </span>
              </span>
            }
            hint={
              <>
                {level.description}
                <DetailTip label={level.label}>{level.detail}</DetailTip>
              </>
            }
          >
            <Switch label={level.label} checked={security[level.key]} onChange={(value) => void change(level.key, value)} />
          </SettingsRow>
        ))}
      </SettingsGroup>
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
  const [saved, flashSaved] = useSavedFlash()
  if (!execution) return null

  const change = async (next: Partial<ExecutionSettings>) => {
    const updated = { ...execution, ...next }
    store.set((state) => (state.settings ? { ...state, settings: { ...state.settings, execution: updated } } : state))
    try {
      const settings = await window.diffra.savePreferences({ execution: updated })
      store.set((state) => ({ ...state, settings }))
      flashSaved()
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
      <SettingsHeader title="任务执行" description="所有项目共用；新建或重新打开的任务生效。" actions={<SavedHint shown={saved} />} />
      <SettingsGroup>
        <SettingsRow
          label="上下文压缩"
          hint={
            <>
              上下文用到模型窗口的这个比例时自动压缩。
              <DetailTip label="上下文压缩">先省略较早的工具输出，还不够再把早期对话压成摘要，然后接着做。比例越低越省 token，越高保留的原文越多。</DetailTip>
            </>
          }
        >
          <Segmented label="上下文压缩" value={String(execution.compactAtPercent)} options={COMPACT_OPTIONS} onChange={changeCompactAt} />
        </SettingsRow>
        <SettingsRow
          label="单次任务步数上限"
          hint={
            <>
              模型每回复一次算一步，到上限就停下等你发话。
              <DetailTip label="单次任务步数上限">智能体反复做同样的操作时，不管有没有上限都会自动停下。</DetailTip>
            </>
          }
        >
          <Segmented label="单次任务步数上限" value={execution.maxSteps === null ? NO_STEP_LIMIT : String(execution.maxSteps)} options={STEP_OPTIONS} onChange={changeMaxSteps} />
        </SettingsRow>
        <SettingsRow
          label="目标模式轮数上限"
          hint={
            <>
              用 /目标 发的任务到这个轮数还没完成就停下。
              <DetailTip label="目标模式轮数上限">智能体每轮做完自己判断目标达成没有，没达成就接着做下一轮；停下时说明还差什么。每轮各有一份步数上限。</DetailTip>
            </>
          }
        >
          <Segmented label="目标模式轮数上限" value={String(execution.goalMaxRounds)} options={GOAL_ROUND_SEGMENTS} onChange={changeGoalRounds} />
        </SettingsRow>
      </SettingsGroup>
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
      <SettingsHeader title="会话与存储" description="任务的对话记录保存在本机，不含 API Key。" />
      <SettingsGroup title="任务记录">
        <SettingsRow
          label="存储位置"
          hint={
            storage && (
              <span className="block truncate font-mono" title={storage.dir}>
                {storage.dir}
              </span>
            )
          }
        >
          {storage && (
            <Button variant="outline" onClick={() => window.diffra.openProjectFolder(storage.dir).catch((error: unknown) => showToast(errorMessage(error)))}>
              在资源管理器中打开
            </Button>
          )}
        </SettingsRow>
        <SettingsRow label="占用空间" hint={`${tasks.length} 个任务`}>
          <span className="text-sm text-muted-foreground tabular-nums">{storage ? (storage.bytes < 1024 ? '不到 1 KB' : formatBytes(storage.bytes)) : '…'}</span>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="已归档的任务">
        {archived.length === 0 ? (
          <EmptyState icon={Archive} title="没有已归档的任务" description="在任务菜单里选择「归档」后，任务会出现在这里。" className="rounded-none bg-transparent py-8" />
        ) : (
          archived.map((task) => <ArchivedRow key={task.sessionId} task={task} />)
        )}
      </SettingsGroup>
    </>
  )
}

function ArchivedRow({ task }: { task: StoredSessionSummary }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2 text-sm" data-testid="archived-task">
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
  const blocked = checkBlockedReason(status)
  const checkButton = (
    <Button variant="outline" disabled={blocked !== null} onClick={() => window.diffra.checkForUpdates().catch((error: unknown) => showToast(errorMessage(error)))}>
      检查更新
    </Button>
  )
  return (
    <>
      <SettingsHeader title="更新与关于" />
      <SettingsGroup>
        <div className="flex items-center gap-3 px-4 py-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-soft text-primary">
            <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="size-5" aria-hidden="true">
              <path d="M2.5 6.5h8.5" />
              <path d="M7 11.5h8.5" />
            </svg>
          </span>
          <div className="min-w-0">
            <div className="text-lg font-semibold">Diffra</div>
            <div className="text-sm text-muted-foreground tabular-nums">
              版本 <span data-testid="app-version">{version ?? '…'}</span>
            </div>
          </div>
        </div>
        <SettingsRow label="更新">
          <span className="text-sm text-muted-foreground" data-testid="update-status">
            {status ? describeUpdateStatus(status) : '…'}
          </span>
          {status?.state === 'downloaded' && (
            <Button onClick={() => window.diffra.installUpdate().catch((error: unknown) => showToast(errorMessage(error)))}>
              重启并更新
            </Button>
          )}
          {blocked === null ? (
            checkButton
          ) : (
            // 禁用的按钮收不到指针事件，Tooltip 挂在外层可聚焦的 span 上
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0} className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">{checkButton}</span>
              </TooltipTrigger>
              <TooltipContent>{blocked}</TooltipContent>
            </Tooltip>
          )}
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}

function checkBlockedReason(status: UpdateStatus | null): string | null {
  if (status === null) return '正在读取更新状态'
  switch (status.state) {
    case 'idle':
    case 'up-to-date':
    case 'error':
      return null
    case 'disabled':
      return '开发模式不检查更新'
    case 'checking':
      return '正在检查更新'
    case 'downloading':
      return '正在下载新版本'
    case 'downloaded':
      return '新版本已下载，重启即可更新'
  }
}

function useCoreStatus(): CoreStatus | null {
  const [status, setStatus] = useState<CoreStatus | null>(null)
  useEffect(() => {
    window.diffra.getCoreStatus().then(setStatus, (error: unknown) => setStatus({ state: 'failed', error: errorMessage(error) }))
  }, [])
  return status
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
