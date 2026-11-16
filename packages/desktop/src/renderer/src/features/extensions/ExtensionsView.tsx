import { useEffect, useMemo, useState } from 'react'
import { Blocks, Search } from 'lucide-react'
import {
  CATALOG_MCP,
  CATALOG_PLUGINS,
  type CatalogMcp,
  type CatalogPlugin,
  type CatalogView,
  installedServer,
  MCP_GROUP_LABELS,
  type McpGroup,
  PLUGIN_GROUP_LABELS,
  type PluginGroup,
  type PrerequisiteState,
} from '../../../../shared/extensions'
import type { PluginView, SettingsView } from '../../../../shared/settings'
import { cn } from 'cn'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { McpInstalled } from '@/features/mcp/McpSettings'
import { useMcpStatus } from '@/features/mcp/useMcpStatus'
import { ManualPluginInstall, PluginInstalled } from '@/features/plugins/PluginSettings'
import { errorMessage } from '@/lib/errors'
import { formatTime } from '@/lib/format'
import { openExtensions } from '@/state/actions'
import type { ExtensionsTab } from '@/state/store'
import { CatalogMcpRow } from './CatalogMcpRow'
import { CatalogPluginRow } from './CatalogPluginRow'
import { SectionTitle } from './parts'

const GRID = 'grid gap-x-7 sm:grid-cols-2'

const matches = (query: string, ...texts: string[]) => query === '' || texts.some((text) => text.toLowerCase().includes(query))

// 侧栏「扩展」（第 595 步）：内置目录里的 MCP 服务和插件，一键装；「已安装」管装好的，所有项目共用、新任务生效
export function ExtensionsView({ tab }: { tab: ExtensionsTab }) {
  const [view, setView] = useState<SettingsView | null>(null)
  const [plugins, setPlugins] = useState<PluginView[] | null>(null)
  const [prerequisites, setPrerequisites] = useState<PrerequisiteState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pluginError, setPluginError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  // 目录：先用缓存的（或内置的）显示出来，再联网看有没有更新
  const [catalog, setCatalog] = useState<CatalogView | null>(null)
  const [checking, setChecking] = useState(false)
  // 同一时间只展开一个目录项的安装面板
  const [expanded, setExpanded] = useState<string | null>(null)
  // 配置改了重新查连接状态；只在「已安装」里查，目录页不去连服务器
  const [version, setVersion] = useState(0)
  const status = useMcpStatus(tab === 'installed' && view ? { projectPath: null } : null, version)

  const recheck = () => {
    window.diffra.extensionPrerequisites().then(setPrerequisites, (error: unknown) => setLoadError(errorMessage(error)))
  }
  useEffect(() => {
    window.diffra.getSettings().then(setView, (error: unknown) => setLoadError(errorMessage(error)))
    // 装插件的结果比最初的列表先回来时，不能被晚到的旧列表盖掉
    window.diffra.listPlugins().then(
      (list) => setPlugins((current) => current ?? list),
      (error: unknown) => setLoadError(errorMessage(error)),
    )
    recheck()
    window.diffra
      .extensionCatalog('cached')
      .then((cached) => {
        setCatalog((current) => current ?? cached)
        return checkCatalog('check')
      })
      .catch((error: unknown) => setLoadError(errorMessage(error)))
  }, [])

  const checkCatalog = async (mode: 'check' | 'force') => {
    setChecking(true)
    try {
      setCatalog(await window.diffra.extensionCatalog(mode))
    } finally {
      setChecking(false)
    }
  }

  const settingsChanged = (next: SettingsView) => {
    setView(next)
    setVersion((value) => value + 1)
  }
  const text = query.trim().toLowerCase()
  const servers = view?.mcpServers ?? []
  const pluginNames = new Set((plugins ?? []).map((plugin) => plugin.name.toLowerCase()))
  const mcpRow = (entry: CatalogMcp) => (
    <CatalogMcpRow
      key={entry.id}
      entry={entry}
      installed={installedServer(entry, servers) !== undefined}
      prerequisites={prerequisites}
      expanded={expanded === `mcp:${entry.id}`}
      onExpand={(open) => setExpanded(open ? `mcp:${entry.id}` : null)}
      onInstalled={settingsChanged}
      onRecheck={recheck}
    />
  )
  const pluginRow = (entry: CatalogPlugin) => (
    <CatalogPluginRow key={entry.id} entry={entry} installed={pluginNames.has(entry.pluginName)} onInstalled={(next) => setPlugins(next)} />
  )
  const catalogMcp = catalog?.mcp ?? CATALOG_MCP
  const catalogPlugins = catalog?.plugins ?? CATALOG_PLUGINS
  const mcpEntries = useMemo(() => catalogMcp.filter((entry) => matches(text, entry.name, entry.description, entry.publisher)), [catalogMcp, text])
  const pluginEntries = useMemo(() => catalogPlugins.filter((entry) => matches(text, entry.name, entry.description, entry.publisher)), [catalogPlugins, text])
  const nothing = <p className="py-6 text-sm text-muted-foreground">没有匹配「{query.trim()}」的扩展</p>

  const body = () => {
    switch (tab) {
      case 'recommended': {
        const mcp = mcpEntries.filter((entry) => entry.recommended)
        const methods = pluginEntries.filter((entry) => entry.recommended)
        if (mcp.length + methods.length === 0) return nothing
        return (
          <>
            {mcp.length > 0 && <CatalogSection title="接上常用服务">{mcp.map(mcpRow)}</CatalogSection>}
            {methods.length > 0 && <CatalogSection title="更好的工作方法">{methods.map(pluginRow)}</CatalogSection>}
          </>
        )
      }
      case 'mcp': {
        if (mcpEntries.length === 0) return nothing
        return (Object.keys(MCP_GROUP_LABELS) as McpGroup[]).map((group) => {
          const entries = mcpEntries.filter((entry) => entry.group === group)
          return entries.length > 0 && <CatalogSection key={group} title={MCP_GROUP_LABELS[group]}>{entries.map(mcpRow)}</CatalogSection>
        })
      }
      case 'plugins':
        return (
          <>
            {pluginEntries.length === 0
              ? nothing
              : (Object.keys(PLUGIN_GROUP_LABELS) as PluginGroup[]).map((group) => {
                  const entries = pluginEntries.filter((entry) => entry.group === group)
                  return entries.length > 0 && <CatalogSection key={group} title={PLUGIN_GROUP_LABELS[group]}>{entries.map(pluginRow)}</CatalogSection>
                })}
            <div className="mt-6 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              <span className="mr-1">目录里没有的：</span>
              <ManualPluginInstall onInstalled={setPlugins} onError={setPluginError} />
            </div>
            {pluginError && (
              <Alert variant="destructive" className="mt-3">
                <AlertDescription className="whitespace-pre-wrap">{pluginError}</AlertDescription>
              </Alert>
            )}
          </>
        )
      case 'installed':
        return (
          <div className="space-y-8">
            {view && (
              <McpInstalled
                view={view}
                status={status}
                catalog={catalogMcp}
                prerequisites={prerequisites}
                onChange={settingsChanged}
                onRecheck={recheck}
                onBrowse={() => openExtensions('mcp')}
              />
            )}
            <PluginInstalled
              plugins={plugins}
              error={pluginError}
              onChange={setPlugins}
              onError={setPluginError}
              onBrowse={() => openExtensions('plugins')}
            />
            <p className="text-sm text-muted-foreground">所有项目共用，改动对新任务生效。兼容 Claude Code 插件的格式；插件里的 MCP 服务器和钩子会在本机运行命令。</p>
          </div>
        )
    }
  }

  const installedCount = servers.length + (plugins?.length ?? 0)
  return (
    <div className="h-full overflow-y-auto [scrollbar-gutter:stable]" data-testid="extensions-view">
      <div className="mx-auto max-w-[896px] px-6 py-10 lg:py-12">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-60 flex-1">
            <div className="flex items-center gap-3">
              <Blocks className="size-5 text-muted-foreground" />
              <h1 className="text-xl font-bold">扩展</h1>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">给智能体接上外部服务、工具和工作方法。装在这里的所有项目共用。</p>
          </div>
          {/* 搜的是目录；已安装的就那么几个，不用搜 */}
          {tab !== 'installed' && (
            <div className="relative w-60">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input aria-label="搜索扩展" placeholder="搜索名称或用途" value={query} onChange={(event) => setQuery(event.target.value)} className="pl-8" />
            </div>
          )}
        </div>
        <div className="mt-6">
          <Segmented<ExtensionsTab>
            label="扩展分类"
            value={tab}
            options={[
              { value: 'recommended', label: '推荐' },
              { value: 'mcp', label: 'MCP' },
              { value: 'plugins', label: '插件' },
              { value: 'installed', label: installedCount > 0 ? `已安装 ${installedCount}` : '已安装' },
            ]}
            onChange={(next) => {
              setExpanded(null)
              openExtensions(next)
            }}
          />
        </div>
        {loadError && (
          <Alert variant="destructive" className="mt-4">
            <AlertTitle>读取扩展失败</AlertTitle>
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        )}
        {view?.loadError && (
          <Alert variant="destructive" className="mt-4">
            <AlertTitle>设置暂时无法保存</AlertTitle>
            <AlertDescription>{view.loadError}</AlertDescription>
          </Alert>
        )}
        <div className={cn('mt-6', tab !== 'installed' && 'space-y-8')}>{body()}</div>
        {tab !== 'installed' && catalog && (
          <CatalogStatus catalog={catalog} checking={checking} onCheck={() => void checkCatalog('force').catch((error: unknown) => setLoadError(errorMessage(error)))} />
        )}
      </div>
    </div>
  )
}

// 目录从哪来：联网取到的、联网失败用的缓存、内置的；能手动检查更新
function CatalogStatus({ catalog, checking, onCheck }: { catalog: CatalogView; checking: boolean; onCheck(): void }) {
  const checked = catalog.fetchedAt ? `，${formatTime(catalog.fetchedAt)} 联网检查过` : ''
  const label = catalog.error
    ? catalog.source === 'cache'
      ? `没连上目录服务器（${catalog.error}），用的是${catalog.fetchedAt ? ` ${formatTime(catalog.fetchedAt)} ` : '上次'}取到的目录（${catalog.updatedAt} 版）`
      : `没连上目录服务器（${catalog.error}），用的是内置目录（${catalog.updatedAt} 版）`
    : `目录 ${catalog.updatedAt} 版${catalog.source === 'builtin' && !catalog.fetchedAt ? '（内置）' : checked}`
  return (
    <div className="mt-8 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground" data-testid="catalog-source" data-source={catalog.source}>
      <span className={cn('break-words', catalog.error && 'text-warning')}>{label}。已经装上的不受目录变化影响。</span>
      <Button size="xs" variant="ghost" disabled={checking} onClick={onCheck}>
        {checking ? '正在检查…' : '检查更新'}
      </Button>
    </div>
  )
}

function CatalogSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <SectionTitle>{title}</SectionTitle>
      <div className={GRID}>{children}</div>
    </section>
  )
}
