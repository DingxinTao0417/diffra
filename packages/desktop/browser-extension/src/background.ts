// Diffra 浏览器扩展的后台：连本机宿主（native messaging），把 Diffra 的调试命令转给标签页，把事件转回去；
// 管「Diffra · 任务名」分组里的标签页。读页面、点击这些逻辑都在 Diffra 里，这里只转发
import {
  BRIDGE_PROTOCOL,
  type BridgeCall,
  type BridgeTask,
  type DiffraMessage,
  type ExtensionMessage,
  type ExternalBrowserKind,
  type HostMessage,
  NATIVE_HOST_NAMES,
} from '../../src/shared/browser-bridge'
import type { PopupRequest, PopupState } from './popup-protocol'

const RETRY_MS = 3_000
// 宿主没登记（没装 Diffra）时隔一会儿再试，用 alarms，服务工作线程被回收了也能醒
const MISSING_ALARM = 'diffra-reconnect'
const MISSING_RETRY_MINUTES = 1
const GROUP_TITLE_CHARS = 24
// 智能体的标签页里网页要开新窗口（Page.windowOpen）之后这么久内出现的新标签页，算它开的
const WINDOW_OPEN_MS = 5_000

// 一个宿主名对应一个 Diffra（正式版、开发版可以同时开着）
interface Link {
  host: string
  port: chrome.runtime.Port | null
  // 宿主在跑，但 Diffra 没开
  diffra: boolean
  // 宿主没登记：这台电脑上没有这个 Diffra
  missing: boolean
  tasks: BridgeTask[]
}

// 交给 Diffra 的标签页：哪个 Diffra、哪个任务
interface Owned {
  host: string
  sessionId: string
}

const links = new Map<string, Link>(Object.values(NATIVE_HOST_NAMES).map((host) => [host, { host, port: null, diffra: false, missing: false, tasks: [] }]))
const owned = new Map<number, Owned>()
// 任务 → 浏览器里的分组。分组只能在一个窗口里，交过来的标签页不搬窗口，所以一个任务每个窗口各一个
const groups = new Map<string, number[]>()
// 任务的最新标题：任务刚建时标题还没定，改名可能比分组先到
const titles = new Map<string, string>()
let restored: Promise<void> | null = null
// 智能体的标签页最近一次要开新窗口的时间
const windowOpens = new Map<number, number>()

function browserKind(): ExternalBrowserKind {
  if (navigator.userAgent.includes('Edg/')) return 'edge'
  const brands = (navigator as Navigator & { userAgentData?: { brands: Array<{ brand: string }> } }).userAgentData?.brands ?? []
  return brands.some((item) => item.brand === 'Google Chrome') ? 'chrome' : 'chromium'
}

// 服务工作线程可能被回收重启：交出去的标签页和分组存在会话存储里
async function restore(): Promise<void> {
  const saved = (await chrome.storage.session.get(['owned', 'groups'])) as { owned?: Array<[number, Owned]>; groups?: Array<[string, number[]]> }
  for (const [tabId, item] of saved.owned ?? []) owned.set(tabId, item)
  for (const [sessionId, groupIds] of saved.groups ?? []) groups.set(sessionId, groupIds)
}

function save(): void {
  void chrome.storage.session.set({ owned: [...owned], groups: [...groups] })
  void chrome.action.setBadgeText({ text: owned.size > 0 ? String(owned.size) : '' })
  void chrome.action.setBadgeBackgroundColor({ color: '#22ad7a' })
}

function post(link: Link, message: ExtensionMessage): void {
  link.port?.postMessage(message)
}

function linkOf(tabId: number): Link | null {
  const item = owned.get(tabId)
  return item ? (links.get(item.host) ?? null) : null
}

function connect(link: Link): void {
  if (link.port) return
  let port: chrome.runtime.Port
  try {
    port = chrome.runtime.connectNative(link.host)
  } catch {
    link.missing = true
    return
  }
  link.port = port
  link.missing = false
  port.onMessage.addListener((message: DiffraMessage | HostMessage) => void onMessage(link, message))
  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message ?? ''
    link.port = null
    link.diffra = false
    // 没登记的宿主：等 alarms 再试；其他情况（宿主退出了）过一会儿重连
    if (/not found/i.test(error)) link.missing = true
    else setTimeout(() => connect(link), RETRY_MS)
  })
  post(link, { type: 'hello', protocol: BRIDGE_PROTOCOL, extensionVersion: chrome.runtime.getManifest().version, browser: browserKind(), userAgent: navigator.userAgent })
}

async function onMessage(link: Link, message: DiffraMessage | HostMessage): Promise<void> {
  switch (message.type) {
    case 'diffra':
      link.diffra = message.connected
      return
    case 'welcome':
      link.diffra = true
      return
    case 'tasks':
      link.tasks = message.tasks
      return
    case 'call':
      try {
        post(link, { type: 'reply', id: message.id, result: await call(link, message) })
      } catch (error) {
        post(link, { type: 'reply', id: message.id, error: error instanceof Error ? error.message : String(error) })
      }
  }
}

async function call(link: Link, request: BridgeCall): Promise<unknown> {
  switch (request.method) {
    case 'tabs.create': {
      const { sessionId, title, url, active } = request.params
      const tab = await chrome.tabs.create({ url: url || 'about:blank', active })
      if (tab.id === undefined) throw new Error('浏览器没有开出标签页')
      owned.set(tab.id, { host: link.host, sessionId })
      await addToGroup(tab.id, sessionId, title)
      save()
      return { tabId: tab.id }
    }
    case 'tabs.close':
      owned.delete(request.params.tabId)
      save()
      await chrome.tabs.remove(request.params.tabId).catch(() => {})
      return null
    case 'tabs.activate': {
      const tab = await chrome.tabs.update(request.params.tabId, { active: true })
      if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true })
      return null
    }
    case 'tabs.release':
      await release(request.params.tabId)
      return null
    case 'groups.title': {
      titles.set(request.params.sessionId, request.params.title)
      for (const groupId of groups.get(request.params.sessionId) ?? []) await chrome.tabGroups.update(groupId, { title: groupTitle(request.params.title) }).catch(() => {})
      return null
    }
    case 'debugger.attach': {
      const { tabId } = request.params
      if (!owned.has(tabId)) throw new Error('这个标签页没有交给 Diffra')
      await chrome.debugger.attach({ tabId }, '1.3').catch((error: unknown) => {
        // 已经连着（比如扩展重启前连的）不算错
        if (!(error instanceof Error && /already attached/i.test(error.message))) throw error
      })
      // 交过来的、页面自己开的标签页已经有内容，告诉 Diffra 现在的网址和标题
      const tab = await chrome.tabs.get(tabId)
      return { url: tab.url ?? '', title: tab.title ?? '', loading: tab.status === 'loading' }
    }
    case 'cdp': {
      const { tabId, method, params } = request.params
      if (!owned.has(tabId)) throw new Error('这个标签页没有交给 Diffra')
      return (await chrome.debugger.sendCommand({ tabId }, method, params)) ?? null
    }
  }
}

// 放进这个任务在标签页所在窗口的分组；放进别的窗口的分组会把标签页搬过去，在那边成了后台标签页，浏览器就不画了
async function addToGroup(tabId: number, sessionId: string, title: string): Promise<void> {
  const tab = await chrome.tabs.get(tabId)
  const alive = (await Promise.all((groups.get(sessionId) ?? []).map((groupId) => chrome.tabGroups.get(groupId).catch(() => null)))).filter((group) => group !== null)
  const same = alive.find((group) => group.windowId === tab.windowId)
  if (same) {
    groups.set(sessionId, alive.map((group) => group.id))
    await chrome.tabs.group({ tabIds: tabId, groupId: same.id })
    return
  }
  const groupId = await chrome.tabs.group({ tabIds: tabId })
  // 先登记再起名：起名期间到的改名能找到这个分组；起名用最新的标题
  groups.set(sessionId, [...alive.map((group) => group.id), groupId])
  await chrome.tabGroups.update(groupId, { title: groupTitle(titles.get(sessionId) ?? title), color: 'green' })
}

function taskTitle(link: Link | undefined, sessionId: string): string {
  return link?.tasks.find((item) => item.sessionId === sessionId)?.title ?? '任务'
}

function groupTitle(title: string): string {
  return `Diffra · ${title.length > GROUP_TITLE_CHARS ? `${title.slice(0, GROUP_TITLE_CHARS)}…` : title}`
}

// 交还给用户：断开调试，移出分组，标签页留着
async function release(tabId: number): Promise<void> {
  const item = owned.get(tabId)
  owned.delete(tabId)
  save()
  await chrome.debugger.detach({ tabId }).catch(() => {})
  await chrome.tabs.ungroup(tabId).catch(() => {})
  const link = item ? links.get(item.host) : undefined
  if (link) post(link, { type: 'detached', tabId, reason: 'released' })
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined) return
  const link = linkOf(source.tabId)
  if (!link) return
  if (method === 'Page.windowOpen') windowOpens.set(source.tabId, Date.now())
  post(link, { type: 'event', tabId: source.tabId, method, params: (params ?? {}) as Record<string, unknown> })
})

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return
  const link = linkOf(source.tabId)
  if (!link) return
  // 用户点了提示条上的取消：这个标签页不再交给 Diffra
  if (reason === 'canceled_by_user') {
    owned.delete(source.tabId)
    save()
  }
  post(link, { type: 'detached', tabId: source.tabId, reason })
})

chrome.tabs.onRemoved.addListener((tabId) => {
  const link = linkOf(tabId)
  if (!link) return
  owned.delete(tabId)
  save()
  post(link, { type: 'tab-closed', tabId })
})

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  const link = linkOf(tabId)
  if (!link || (change.url === undefined && change.title === undefined && change.status === undefined)) return
  post(link, { type: 'tab-updated', tabId, url: tab.url ?? '', title: tab.title ?? '', loading: tab.status === 'loading' })
})

// 智能体的标签页里的网页开了新窗口：也交给同一个任务，放进同一个分组
// 只认页面自己开的（调试事件 Page.windowOpen 刚报过）；用户从智能体的标签页里按 Ctrl+T、中键开的不算
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id === undefined || tab.openerTabId === undefined) return
  const opener = owned.get(tab.openerTabId)
  const openedAt = windowOpens.get(tab.openerTabId)
  if (!opener || openedAt === undefined || Date.now() - openedAt > WINDOW_OPEN_MS) return
  windowOpens.delete(tab.openerTabId)
  owned.set(tab.id, opener)
  save()
  const link = links.get(opener.host)
  // 弹出的小窗口不能放分组，失败了不管
  void addToGroup(tab.id, opener.sessionId, taskTitle(link, opener.sessionId)).catch(() => {})
  if (link) post(link, { type: 'tab-opened', tabId: tab.id, openerTabId: tab.openerTabId })
})

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return
  for (const link of links.values()) post(link, { type: 'focus' })
})

// 弹窗：连接状态、当前标签页交给哪个任务、停止任务
chrome.runtime.onMessage.addListener((request: PopupRequest, _sender, respond) => {
  void (async () => {
    await restored
    switch (request.kind) {
      case 'state': {
        const state: PopupState = {
          links: [...links.values()].map((link) => ({ host: link.host, connected: link.port !== null && link.diffra, hostRunning: link.port !== null, missing: link.missing, tasks: link.tasks })),
          tab: request.tabId === null ? null : (owned.get(request.tabId) ?? null),
          busy: [...new Set([...owned.values()].map((item) => `${item.host}\n${item.sessionId}`))].map((key) => {
            const [host = '', sessionId = ''] = key.split('\n')
            return { host, sessionId }
          }),
        }
        return respond(state)
      }
      case 'share': {
        const link = links.get(request.host)
        if (!link?.port) return respond({ ok: false, error: 'Diffra 没有连上' })
        const previous = owned.get(request.tabId)
        if (previous) await release(request.tabId)
        owned.set(request.tabId, { host: request.host, sessionId: request.sessionId })
        await addToGroup(request.tabId, request.sessionId, taskTitle(link, request.sessionId))
        save()
        post(link, { type: 'share-tab', tabId: request.tabId, sessionId: request.sessionId })
        return respond({ ok: true })
      }
      case 'release':
        await release(request.tabId)
        return respond({ ok: true })
      case 'stop': {
        const link = links.get(request.host)
        if (link) post(link, { type: 'stop', sessionId: request.sessionId })
        return respond({ ok: true })
      }
      case 'retry':
        for (const link of links.values()) connect(link)
        return respond({ ok: true })
    }
  })()
  return true
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== MISSING_ALARM) return
  for (const link of links.values()) if (!link.port) connect(link)
})

// 浏览器启动、扩展装好时服务工作线程会醒，顶层代码就会跑；这两个监听只是让它被叫醒
chrome.runtime.onStartup.addListener(() => {})
chrome.runtime.onInstalled.addListener(() => {})

restored = restore().then(() => {
  void chrome.alarms.create(MISSING_ALARM, { periodInMinutes: MISSING_RETRY_MINUTES })
  for (const link of links.values()) connect(link)
  save()
})
