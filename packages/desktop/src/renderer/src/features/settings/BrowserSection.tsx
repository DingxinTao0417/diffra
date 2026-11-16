import { type FormEvent, useState } from 'react'
import { X } from 'lucide-react'
import { EXTENSION_STORE_URLS } from '../../../../shared/browser-bridge'
import type { DirectChromeStatus } from '../../../../shared/ipc'
import { AGENT_BROWSERS, type AgentBrowser, type BrowserSettings, type ComputerUseSettings } from '../../../../shared/settings'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import { errorMessage } from '@/lib/errors'
import { showToast, store, useAppState } from '@/state/store'
import { ComputerUseGroup } from './ComputerUseGroup'
import { SavedHint, SettingsGroup, SettingsHeader, SettingsRow, useSavedFlash } from './SettingsLayout'

const AGENT_OPTIONS: Array<{ value: AgentBrowser; label: string }> = AGENT_BROWSERS.map((value) => ({ value, label: { builtin: '内置浏览器', chrome: '我的 Chrome', edge: '我的 Edge' }[value] }))

const CHROME_MODES: Array<{ value: 'extension' | 'direct'; label: string }> = [
  { value: 'extension', label: '经扩展' },
  { value: 'direct', label: '直接启动' },
]

// 智能体用哪个浏览器；用户自己的 Chrome、Edge 要装 Diffra 浏览器扩展，Chrome 也可以直接启动（v2）；哪些网站直接打开、哪些不让打开
export function BrowserSection() {
  const browser = useAppState((state) => state.settings?.browser ?? null)
  const computerUse = useAppState((state) => state.settings?.computerUse ?? null)
  const bridge = useAppState((state) => state.bridge)
  const [saved, flashSaved] = useSavedFlash()
  if (!browser || !computerUse) return null

  const saveComputerUse = async (next: ComputerUseSettings) => {
    store.set((state) => (state.settings ? { ...state, settings: { ...state.settings, computerUse: next } } : state))
    try {
      const settings = await window.diffra.savePreferences({ computerUse: next })
      store.set((state) => ({ ...state, settings }))
      flashSaved()
    } catch (error) {
      store.set((state) => (state.settings ? { ...state, settings: { ...state.settings, computerUse } } : state))
      showToast(`保存失败：${errorMessage(error)}`)
    }
  }

  const save = async (next: BrowserSettings) => {
    store.set((state) => (state.settings ? { ...state, settings: { ...state.settings, browser: next } } : state))
    try {
      const settings = await window.diffra.savePreferences({ browser: next })
      store.set((state) => ({ ...state, settings }))
      flashSaved()
    } catch (error) {
      store.set((state) => (state.settings ? { ...state, settings: { ...state.settings, browser } } : state))
      showToast(`保存失败：${errorMessage(error)}`)
    }
  }

  return (
    <>
      <SettingsHeader title="浏览器与电脑操控" description="智能体打开网页、读页面、点击输入时用哪个浏览器，哪些网站不用问、哪些不让打开，以及要不要让它操作这台电脑。" actions={<SavedHint saved={saved} />} />
      <SettingsGroup title="智能体用的浏览器">
        <SettingsRow label="默认" hint="单个任务还可以在浏览器面板上换。">
          <Segmented label="智能体用的浏览器" value={browser.agent} options={AGENT_OPTIONS} onChange={(agent) => void save({ ...browser, agent })} />
        </SettingsRow>
        <SettingsRow
          label="Chrome 怎么连"
          hint={
            browser.chromeDirect
              ? '直接启动系统里装的 Chrome，用 Diffra 单独的配置（登录状态和你平时的 Chrome 分开），不用装扩展。在浏览器面板上能打开开发者工具。'
              : '经 Diffra 浏览器扩展，用你平时的 Chrome 和里面的登录状态。'
          }
        >
          <Segmented label="Chrome 怎么连" value={browser.chromeDirect ? 'direct' : 'extension'} options={CHROME_MODES} onChange={(mode) => void save({ ...browser, chromeDirect: mode === 'direct' })} />
        </SettingsRow>
        {browser.chromeDirect && <DirectChromeRow status={bridge.direct ?? null} browser={browser} onSave={(next) => void save(next)} />}
        <SettingsRow label="开发者工具" hint="浏览器面板顶栏显示「开发者工具」按钮：内置浏览器单独开一个窗口，直接启动的 Chrome 在那个 Chrome 里打开检查器（控制台、网络、元素）；经扩展时请在浏览器里按 F12。">
          <Switch label="浏览器面板上的开发者工具" checked={browser.devTools !== false} onChange={(devTools) => void save({ ...browser, devTools })} />
        </SettingsRow>
        {(['chrome', 'edge'] as const).map((kind) => {
          const name = kind === 'chrome' ? 'Chrome' : 'Edge'
          // 测试用的 Chromium 也算 Chrome
          const connections = bridge.connections.filter((connection) => (kind === 'chrome' ? connection.browser !== 'edge' : connection.browser === 'edge'))
          const outdated = connections.some((connection) => connection.outdated)
          const storeUrl = EXTENSION_STORE_URLS[kind]
          return (
            <SettingsRow
              key={kind}
              label={
                <span className="flex items-center gap-2">
                  {name} 扩展
                  {connections.length > 0 ? <Badge variant={outdated ? 'warning' : 'secondary'}>{outdated ? '版本对不上，请更新' : '已连接'}</Badge> : <Badge variant="outline">未连接</Badge>}
                </span>
              }
              hint={
                connections.length > 0
                  ? `扩展 ${connections.map((connection) => connection.version).join('、')}${connections.length > 1 ? `，${connections.length} 个配置文件` : ''}`
                  : storeUrl
                    ? `在 ${name} 里装好 Diffra 扩展后会自动连上。`
                    : `扩展还没上架。开发时：在 ${name} 的扩展页打开开发者模式，加载解压的扩展，选 packages\\desktop\\out\\browser-extension（先运行 pnpm --filter @diffra/desktop build:extension）。`
              }
            >
              {storeUrl && connections.length === 0 && (
                <Button variant="outline" size="sm" onClick={() => void window.diffra.openExternal(storeUrl).catch((error: unknown) => showToast(errorMessage(error)))}>
                  去安装
                </Button>
              )}
            </SettingsRow>
          )
        })}
      </SettingsGroup>
      {/* 夹在两组中间，组和组之间的间距接不上，自己补 */}
      <p className="mt-4 mb-8 text-sm text-muted-foreground">
        用你自己的 Chrome、Edge 时，智能体会用你在那里的登录状态。它只操作自己开的「Diffra · 任务名」分组里的标签页，或者你在扩展里交给它的标签页；操作时浏览器顶部会提示「正在调试此浏览器」，点提示条上的「取消」就会停下。
      </p>
      <ComputerUseGroup value={computerUse} onSave={saveComputerUse} />
      <SettingsGroup title="网站" className="divide-y-0">
        <SiteList
          label="直接打开"
          hint="智能体打开这些网站不用问（也管子域名）。本地地址一直不用问。"
          sites={browser.allowSites}
          onChange={(allowSites) => void save({ ...browser, allowSites, blockSites: browser.blockSites.filter((site) => !allowSites.includes(site)) })}
        />
        <SiteList
          label="不让打开"
          hint="智能体不会打开这些网站，也不会来问你。"
          sites={browser.blockSites}
          onChange={(blockSites) => void save({ ...browser, blockSites, allowSites: browser.allowSites.filter((site) => !blockSites.includes(site)) })}
        />
      </SettingsGroup>
    </>
  )
}

// 直接启动的系统 Chrome：用哪个程序（自动找到的或用户选的）、在不在跑、上次为什么没启动起来。
// 用不上时任务改用内置浏览器，面板上写原因（v2）。Linux 按常见位置找，没在 Linux 上实测过
function DirectChromeRow({ status, browser, onSave }: { status: DirectChromeStatus | null; browser: BrowserSettings; onSave(next: BrowserSettings): void }) {
  const custom = browser.chromePath ?? null
  const pick = async () => {
    try {
      const path = await window.diffra.pickChromeExecutable()
      if (path) onSave({ ...browser, chromePath: path })
    } catch (error) {
      showToast(errorMessage(error))
    }
  }
  const badge = !status ? null : !status.executable ? (
    <Badge variant="warning">{custom ? '选的程序不在了' : '没找到 Chrome'}</Badge>
  ) : status.running ? (
    <Badge variant="secondary">运行中</Badge>
  ) : (
    <Badge variant="outline">用到时启动</Badge>
  )
  const hint = !status
    ? '正在检测…'
    : custom
      ? status.executable
        ? `用你选的程序（${status.name ?? 'Chrome'}）：${custom}`
        : `你选的程序不在了：${custom}。重新选一个，或者改回自动找。`
      : status.executable
        ? `自动找到的 ${status.name ?? 'Chrome'}：${status.executable}`
        : '没找到 Chrome、Edge 或 Chromium。可以自己选一个程序，或者改回「经扩展」。用不上时任务会先用内置浏览器，面板上会写原因。'
  return (
    <SettingsRow
      label={
        <span className="flex items-center gap-2" data-testid="direct-chrome-status">
          系统 Chrome
          {badge}
        </span>
      }
      hint={
        <span className="break-all" data-testid="direct-chrome-hint">
          {hint}
          {status?.error && <span className="block text-destructive">上次没启动起来：{status.error}</span>}
        </span>
      }
    >
      <div className="flex shrink-0 flex-wrap justify-end gap-2">
        {custom && (
          <Button variant="ghost" size="sm" onClick={() => onSave({ ...browser, chromePath: null })}>
            改回自动找
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => void pick()}>
          选择程序…
        </Button>
      </div>
    </SettingsRow>
  )
}

// 主机名：去掉协议、路径和端口
function hostOf(input: string): string | null {
  const host = input
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^\*\./, '')
  return /^[a-z0-9.-]+$/.test(host) && host.includes('.') ? host : null
}

function SiteList({ label, hint, sites, onChange }: { label: string; hint: string; sites: string[]; onChange(sites: string[]): void }) {
  const [draft, setDraft] = useState('')
  const add = (event: FormEvent) => {
    event.preventDefault()
    const host = hostOf(draft)
    if (!host) return showToast('网站要写主机名，比如 example.com')
    if (!sites.includes(host)) onChange([...sites, host])
    setDraft('')
  }
  return (
    <div className="border-b px-4 py-3 last:border-b-0">
      <div className="text-base">{label}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>
      {sites.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={label}>
          {sites.map((site) => (
            <li key={site} className="flex h-7 items-center gap-1 rounded-md bg-soft pr-0.5 pl-2 text-sm">
              {site}
              <button type="button" aria-label={`移除 ${site}`} className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/10 hover:text-foreground" onClick={() => onChange(sites.filter((item) => item !== site))}>
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="mt-2 flex gap-2">
        <Input aria-label={`添加到「${label}」`} placeholder="example.com" value={draft} onChange={(event) => setDraft(event.target.value)} className="h-8 max-w-64" />
        <Button type="submit" variant="outline" size="sm" disabled={!draft.trim()}>
          添加
        </Button>
      </form>
    </div>
  )
}
