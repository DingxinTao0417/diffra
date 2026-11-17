import { type CSSProperties, type ReactNode, useEffect, useMemo, useState } from 'react'
import type { PermissionMode, StoredSessionSummary } from '@diffra/core/types'
import {
  Archive,
  ArrowLeft,
  BarChart3,
  Bot,
  Check,
  Ellipsis,
  FlaskConical,
  Folder,
  Globe,
  HardDrive,
  Info,
  ListChecks,
  type LucideIcon,
  Monitor,
  MonitorSmartphone,
  Moon,
  Palette,
  PenTool,
  Search,
  Settings2,
  Shield,
  ShieldCheck,
  Sun,
  Terminal,
  TriangleAlert,
} from 'lucide-react'
import type { ChangelogRelease } from '../../../../shared/changelog'
import type { CoreStatus, UpdateStatus } from '../../../../shared/ipc'
import { REMOTE_DEVICE_CONNECTION_ENABLED } from '../../../../shared/remote'
import { StartupGroup } from './StartupGroup'
import {
  type Appearance,
  COMPACT_AT_PERCENTS,
  CONTENT_WIDTHS,
  DEFAULT_SUGGESTIONS,
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
import { ModelSettings } from '@/features/models/ModelSettings'
import { BrandMark } from '@/features/shell/BrandMark'
import { TaskMenu } from '@/features/shell/TaskMenu'
import { SavedHint, SettingsGroup, SettingsHeader, SettingsRow, useSavedFlash } from './SettingsLayout'
import { BrowserSection } from './BrowserSection'
import { ExternalAgentsSection } from './ExternalAgentsSection'
import { ReleaseItems, ReleaseList } from './Changelog'
import { UsageSection } from './UsageSection'
import { DesignSection } from './DesignSection'
import { EvalSection } from './EvalSection'
import { DevicesSection } from '@/features/devices/DevicesSection'
import { applyAppearance } from '@/lib/appearance'
import { errorMessage } from '@/lib/errors'
import { folderName, formatBytes, formatTime } from '@/lib/format'
import { sameProjectPath } from '@/lib/projects'
import { INSET_PANEL } from '@/lib/shell'
import { PERMISSION_MODES } from '@/lib/permission-modes'
import { leaveSettings, openSettings, setArchived, setProjectArchived } from '@/state/actions'
import { type AppState, type SettingsSection, showToast, store, useAppState } from '@/state/store'
import { IS_MAC, MAC_CHROME_HEIGHT, shortcutKeys } from '@/lib/platform'

const NO_ARCHIVED_PROJECTS: readonly string[] = []

const GROUPS: Array<{ name: string; items: Array<{ id: SettingsSection; label: string; icon: LucideIcon; keywords: string }> }> = [
  {
    name: '通用',
    items: [
      { id: 'general', label: '常规', icon: Settings2, keywords: '快捷键 连接 core 托盘 后台 开机 自动启动 菜单栏' },
      { id: 'appearance', label: '外观', icon: Palette, keywords: '主题 深色 浅色 配色 字号 文字大小 宽度' },
    ],
  },
  {
    name: '智能体',
    items: [
      { id: 'models', label: '模型与角色', icon: Bot, keywords: '供应商 API Key 编码 评审 规划' },
      { id: 'agents', label: '外接智能体', icon: Terminal, keywords: 'Claude Code Codex Gemini Copilot ACP 命令行 CLI 外部' },
      { id: 'permissions', label: '命令权限', icon: ShieldCheck, keywords: '权限模式 询问 自动 完全访问' },
      { id: 'security', label: '安全', icon: Shield, keywords: '深度扫描 漏洞 注入 密钥' },
      { id: 'execution', label: '任务执行', icon: ListChecks, keywords: '上下文 压缩 摘要 步数 上限 卡死 重复 目标 轮数' },
      { id: 'browser', label: '浏览器与电脑操控', icon: Globe, keywords: '内置浏览器 Chrome Edge Chromium 扩展 系统 直接启动 程序 路径 开发者工具 网站 允许 禁止 登录 电脑操控 鼠标 键盘 屏幕' },
      { id: 'design', label: '设计', icon: PenTool, keywords: '图库 图片 Pexels Unsplash 照片 API Key' },
    ],
  },
  {
    name: '连接',
    items: REMOTE_DEVICE_CONNECTION_ENABLED
      ? [{ id: 'devices' as const, label: '设备连接', icon: MonitorSmartphone, keywords: '远程 设备 配对 配对码 局域网 同步 会话 授权 指纹 证书' }]
      : [],
  },
  {
    name: '数据',
    items: [
      { id: 'storage', label: '会话与存储', icon: HardDrive, keywords: '归档 删除 磁盘 记录 默认保存位置 无项目 文件夹' },
      { id: 'usage', label: '用量', icon: BarChart3, keywords: 'token 统计 模型调用 缓存 费用 单价 预算 导出 清理' },
      { id: 'eval', label: '评测结果', icon: FlaskConical, keywords: '评测 results.json 通过率 比较 显著性 难度' },
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
        {/* Mac：红绿灯和顶栏按钮浮在这里（TitleBar），留出位置 */}
        {IS_MAC && <div aria-hidden className="shrink-0" style={{ height: MAC_CHROME_HEIGHT - 12 }} />}
        <button type="button" className="flex h-8.5 items-center gap-2 rounded-lg px-2 text-left hover:bg-accent" onClick={leaveSettings}>
          <ArrowLeft className="size-4" />
          返回
        </button>
        <div className="relative my-2">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="搜索设置" placeholder="搜索设置" value={query} onChange={(event) => setQuery(event.target.value)} className="h-8.5 bg-background pl-8" />
        </div>
        {groups.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">没有匹配的设置</p>}
        {groups.map((group) => (
          <div key={group.name} className="mb-2 flex flex-col gap-0.5">
            <div className="px-2 pb-0.5 text-xs text-muted-foreground">{group.name}</div>
            {group.items.map((item) => {
              const selected = item.id === section
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={selected ? 'page' : undefined}
                  className={cn('flex h-8.5 items-center gap-2 rounded-lg px-2 text-left hover:bg-accent', selected && 'bg-soft text-foreground hover:bg-soft')}
                  onClick={() => openSettings(item.id)}
                >
                  <item.icon className="size-4 shrink-0" />
                  {item.label}
                </button>
              )
            })}
          </div>
        ))}
      </nav>
      <main className={cn('min-w-0 flex-1', INSET_PANEL, IS_MAC && 'rounded-tl-none border-t-0')}>
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
    case 'agents':
      return <ExternalAgentsSection />
    case 'permissions':
      return <PermissionsSection />
    case 'security':
      return <SecuritySection />
    case 'execution':
      return <ExecutionSection />
    case 'browser':
      return <BrowserSection />
    case 'devices':
      return REMOTE_DEVICE_CONNECTION_ENABLED ? <DevicesSection /> : <GeneralSection />
    case 'storage':
      return <StorageSection />
    case 'usage':
      return <UsageSection />
    case 'design':
      return <DesignSection />
    case 'eval':
      return <EvalSection />
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
      <StartupGroup />
      <SuggestionSetting />
      <SettingsGroup title="连接">
        <SettingsRow label="智能体服务" hint="在后台运行任务的本地进程。">
          <CoreStatusView status={status} />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="快捷键">
        {SHORTCUTS.map(({ keys, action }) => (
          <SettingsRow key={action} label={action}>
            <KbdGroup>{shortcutKeys(keys).map((key) => <Kbd key={key}>{key}</Kbd>)}</KbdGroup>
          </SettingsRow>
        ))}
      </SettingsGroup>
    </>
  )
}

function SuggestionSetting() {
  const suggestions = useAppState((state) => state.settings?.suggestions ?? DEFAULT_SUGGESTIONS)
  const change = async (nextPrompt: boolean) => {
    try {
      const settings = await window.diffra.savePreferences({ suggestions: { nextPrompt } })
      store.set((state) => ({ ...state, settings }))
    } catch (error) {
      showToast(`保存失败：${errorMessage(error)}`)
    }
  }
  return (
    <SettingsGroup title="输入框">
      <SettingsRow label="推荐下一句" hint="一轮正常结束后，在输入框里提示下一步；按 Tab 填入，不自动发送。每轮多一次模型调用。">
        <Switch label="推荐下一句" checked={suggestions.nextPrompt} onChange={(value) => void change(value)} />
      </SettingsRow>
    </SettingsGroup>
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
// primary-color-allow: 注释说明缩略图色值的来源，不是用法
// 和 styles.css 里各配色的 --primary、浅色 --sidebar 保持一致；深色侧栏各配色相同，直接用 --sidebar
const PALETTE_LABELS: Record<Appearance['palette'], { label: string; swatch: string; swatchDark: string; side: string }> = {
  forest: { label: '森绿', swatch: '#2e6b57', swatchDark: '#5fa88c', side: '#f5f5f2' },
  indigo: { label: '靛蓝', swatch: '#3b4ba8', swatchDark: '#8c98e6', side: '#f3f4f8' },
  amber: { label: '琥珀', swatch: '#9a5b13', swatchDark: '#d49a52', side: '#f8f5ee' },
  graphite: { label: '石墨', swatch: '#3a3a3a', swatchDark: '#d0d0d0', side: '#f3f3f3' },
  cinnabar: { label: '朱红', swatch: '#a3362b', swatchDark: '#ef8a7d', side: '#f7f2f0' },
  violet: { label: '紫罗兰', swatch: '#6b3fa0', swatchDark: '#b79ae0', side: '#f5f1f9' },
  cyan: { label: '天青', swatch: '#0f6b7f', swatchDark: '#5fc3d8', side: '#f0f5f6' },
  rose: { label: '玫红', swatch: '#a63663', swatchDark: '#ec93b3', side: '#f8f1f4' },
}
const FONT_LABELS: Record<Appearance['fontSize'], string> = { sm: '小', md: '标准', lg: '大' }
const WIDTH_LABELS: Record<Appearance['contentWidth'], string> = { standard: '标准', wide: '宽' }

function AppearanceSection() {
  const appearance = useAppState((state) => state.settings?.appearance ?? null)
  const [saved, flashSaved] = useSavedFlash()
  if (!appearance) return null

  // 先在界面上生效再保存；保存失败就退回原来的外观
  const change = async (next: Partial<Appearance>) => {
    const updated = { ...appearance, ...next }
    applyAppearance(updated)
    store.set((state) => (state.settings ? { ...state, settings: { ...state.settings, appearance: updated } } : state))
    try {
      const settings = await window.diffra.savePreferences({ appearance: updated })
      store.set((state) => ({ ...state, settings }))
      flashSaved()
    } catch (error) {
      applyAppearance(appearance)
      store.set((state) => (state.settings ? { ...state, settings: { ...state.settings, appearance } } : state))
      showToast(`保存失败：${errorMessage(error)}`)
    }
  }

  return (
    <>
      <SettingsHeader title="外观" description="调整主题、强调色、字体和界面大小。" actions={<SavedHint saved={saved} />} />
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
                {/* primary-color-allow: 配色缩略图选中框 */}
                <span className={cn('relative flex h-24 overflow-hidden rounded-lg border bg-(--thumb-side) dark:bg-sidebar', selected ? 'border-primary ring-1 ring-primary/30' : 'border-border group-hover:border-input')}>
                  <span className="absolute top-3 left-3 h-1.5 w-1/2 rounded-sm bg-(--thumb)" />
                  <span className="absolute top-6 left-3 h-1 w-1/3 rounded-sm bg-foreground/10" />
                  <span className={cn('absolute top-2.5 right-2.5 flex size-4 items-center justify-center rounded-full border bg-background text-(--thumb)', selected ? 'border-(--thumb)' : 'border-input')}>{selected && <Check className="size-3" />}</span>
                  <span className="absolute inset-x-3 top-10 bottom-0 space-y-2 rounded-t-md border border-border bg-background p-3"><span className="block h-1.5 w-3/4 rounded-sm bg-foreground/20" /><span className="block h-1.5 w-1/2 rounded-sm bg-foreground/10" /></span>
                </span>
                <span className={selected ? 'text-foreground' : 'text-muted-foreground'}>{item.label}</span>
              </button>
            })}
          </div>
        </div>
        <SettingsRow label="字体风格" hint="对话内容使用无衬线或衬线字体，终端保持等宽。">
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
    </>
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
    try {
      const settings = await window.diffra.savePreferences({ defaultPermissionMode: next })
      store.set((state) => ({ ...state, settings }))
      flashSaved(true)
    } catch (error) {
      showToast(`保存失败：${errorMessage(error)}`)
    }
  }
  return (
    <>
      <SettingsHeader
        title="命令权限"
        description="智能体执行命令前要不要先问你。"
        actions={<SavedHint saved={saved} note="新任务生效" />}
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
              {/* primary-color-allow: 单选点 */}
              <span className={cn('mt-1 flex size-4 shrink-0 items-center justify-center rounded-full border', checked ? 'border-primary' : 'border-muted-foreground/70')}>
                {/* primary-color-allow: 单选点 */}
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
        在输入框里换了模式，也会记成这里的默认值。不管哪种模式：危险命令清单直接拦截；读写 .env、私钥等密钥文件和改动禁写目录的命令总要先问你。
      </p>
    </>
  )
}

const SECURITY_LEVELS: Array<{ key: keyof SecuritySettings; label: string; trigger: string; cost: string; description: string; detail: string }> = [
  {
    key: 'deepScan',
    label: '深度扫描',
    trigger: '提交前询问',
    cost: '多次模型调用',
    description: '智能体要提交或推送这个任务的改动时，先问你要不要做一次深度扫描；任务页也能随时手动发起。',
    detail: '只读地跨文件追踪数据流，从外部输入一路查到危险调用，出一份报告，勾选后交给智能体修复。扫过之后代码没再变，再提交就不问。',
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
        description="智能体提交或推送前问你要不要先做一次深度扫描。改了对已经打开的任务立即生效。"
        actions={<SavedHint saved={saved} />}
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
            <Switch label={level.label} checked={security[level.key] !== false} onChange={(value) => void change(level.key, value)} />
          </SettingsRow>
        ))}
      </SettingsGroup>
      <p className="mt-4 text-sm text-muted-foreground">
        深度扫描能找出常见的问题，但不能保证没有漏洞；业务逻辑上的问题还要靠测试和你的审阅。
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
      flashSaved(true)
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
      <SettingsHeader title="任务执行" description="上下文快满时怎么压缩，单次任务最多跑多少步，目标模式最多跑几轮。" actions={<SavedHint saved={saved} note="新任务生效" />} />
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
        <SettingsRow
          label="自动记忆"
          hint={
            <>
              每轮结束后记下以后用得上的事，这个项目的新任务会带上。每轮多一次模型调用。
              <DetailTip label="自动记忆">记的是你说过的偏好和纠正、不明显的项目约定、要用的命令，不记这一次做了什么，也不记密钥。每个项目最多 60 条，存在应用数据目录的 memory 文件夹里（每个项目一个 MEMORY.md），可以直接改或删。</DetailTip>
            </>
          }
        >
          <Switch label="自动记忆" checked={execution.autoMemory} onChange={(value) => void change({ autoMemory: value })} />
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}

function StorageSection() {
  const tasks = useAppState((state) => state.tasks)
  const archivedProjects = useAppState((state) => state.settings?.archivedProjects ?? NO_ARCHIVED_PROJECTS)
  const [storage, setStorage] = useState<{ bytes: number; dir: string } | null>(null)
  const archived = useMemo(() => tasks.filter((task) => task.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [tasks])
  const projectCount = useMemo(
    () => (path: string) => tasks.filter((task) => !task.noProject && sameProjectPath(task.cwd, path)).length,
    [tasks],
  )

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
      <WorkspaceGroup />
      <SettingsGroup title="已归档的任务">
        {archived.length === 0 ? (
          <EmptyState icon={Archive} title="没有已归档的任务" description="在任务菜单里选择「归档」后，任务会出现在这里。" variant="plain" className="py-8" />
        ) : (
          archived.map((task) => <ArchivedRow key={task.sessionId} task={task} />)
        )}
      </SettingsGroup>
      <SettingsGroup title="已归档的项目">
        {archivedProjects.length === 0 ? (
          <EmptyState icon={Archive} title="没有已归档的项目" description="在侧边栏右键项目并选择「归档」后，项目和它下面的会话会出现在这里。" variant="plain" className="py-8" />
        ) : (
          archivedProjects.map((path) => (
            <div key={path} className="flex items-center gap-3 px-4 py-2 text-sm" data-testid="archived-project">
              <Folder className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{folderName(path)}</span>
                <span className="block truncate font-mono text-xs text-muted-foreground" title={path}>
                  {path}
                </span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{projectCount(path)} 个会话</span>
              <Button size="sm" variant="ghost" onClick={() => void setProjectArchived(path, false)}>
                恢复项目
              </Button>
            </div>
          ))
        )}
      </SettingsGroup>
    </>
  )
}

function WorkspaceGroup() {
  const workspace = useAppState((state) => state.settings?.defaultWorkspace ?? null)
  const save = async (change: () => Promise<AppState['settings']>) => {
    try {
      const settings = await change()
      if (settings) store.set((state) => ({ ...state, settings }))
    } catch (error) {
      showToast(errorMessage(error))
    }
  }
  return (
    <SettingsGroup title="无项目任务">
      <SettingsRow
        label="默认保存位置"
        hint={
          <>
            {workspace && (
              <span className="block truncate font-mono" title={workspace.path}>
                {workspace.path}
              </span>
            )}
            <span className="block">
              不选项目时，每个任务在这里新建一个文件夹，只影响以后新建的任务。「文档」目录可能被 OneDrive 同步，任务里的依赖文件也会被同步。
            </span>
          </>
        }
      >
        <Button variant="outline" onClick={() => void save(() => window.diffra.pickWorkspace())}>
          更改…
        </Button>
        {workspace && !workspace.isDefault && (
          <Button variant="outline" onClick={() => void save(() => window.diffra.resetWorkspace())}>
            恢复默认
          </Button>
        )}
        <Button variant="outline" onClick={() => window.diffra.openWorkspace().catch((error: unknown) => showToast(errorMessage(error)))}>
          在资源管理器中打开
        </Button>
      </SettingsRow>
    </SettingsGroup>
  )
}

function ArchivedRow({ task }: { task: StoredSessionSummary }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2 text-sm" data-testid="archived-task">
      <span className="min-w-0 flex-1 truncate">{task.title}</span>
      <span className="shrink-0 text-xs text-muted-foreground" title={task.noProject ? task.cwd : undefined}>
        {task.noProject ? '无项目' : folderName(task.cwd)}
      </span>
      <span className="w-12 shrink-0 text-right text-xs text-muted-foreground">{formatTime(task.updatedAt)}</span>
      <Button size="sm" variant="ghost" onClick={() => void setArchived(task.sessionId, false)}>
        取消归档
      </Button>
      <TaskMenu sessionId={task.sessionId} title={task.title} project={task.cwd} noProject={task.noProject} archived align="end">
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
  const [releases, setReleases] = useState<ChangelogRelease[] | null>(null)
  useEffect(() => {
    window.diffra.getAppVersion().then(setVersion, (error: unknown) => console.error('读取版本号失败', error))
    window.diffra.getChangelog().then(setReleases, (error: unknown) => {
      console.error('读取更新日志失败', error)
      setReleases([])
    })
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
          <BrandMark className="size-10" />
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
        {(status?.state === 'downloading' || status?.state === 'downloaded') && status.notes && (
          <div className="px-4 py-3" data-testid="update-notes">
            <div className="mb-2 text-sm font-bold tabular-nums">{status.version} 的改动</div>
            <ReleaseItems added={status.notes.added} fixed={status.notes.fixed} />
          </div>
        )}
      </SettingsGroup>
      <SettingsGroup title="更新日志">
        {releases === null ? (
          <div className="px-4 py-3 text-sm text-muted-foreground">…</div>
        ) : releases.length === 0 ? (
          <div className="px-4 py-3 text-sm text-muted-foreground">这个版本没有附带更新日志。</div>
        ) : (
          <ReleaseList releases={releases} current={version} />
        )}
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
      return disabledUpdateText(status.reason)
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

function disabledUpdateText(reason: 'development' | 'portable' | 'mac-unsigned'): string {
  if (reason === 'mac-unsigned') return '这个 Mac 版没有正式签名，不自动更新，新版本请到官网下载'
  return reason === 'portable' ? '免安装版不检查更新，请用安装版' : '开发模式不检查更新'
}

function describeUpdateStatus(status: UpdateStatus): string {
  switch (status.state) {
    case 'disabled':
      return disabledUpdateText(status.reason)
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
