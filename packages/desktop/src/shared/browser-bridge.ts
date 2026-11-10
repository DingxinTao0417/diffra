// Diffra 浏览器扩展和 Diffra 之间的协议。消息路径：扩展 ⇄（native messaging）本机宿主 ⇄（命名管道，一行一条 JSON）主进程。
// 宿主只转发，不理解内容；扩展也只做转发和标签页管理，读页面、点击这些都在主进程（PageAgent）里。
// 这个文件扩展、宿主脚本和主进程共用，只放类型和常量

// 协议版本：两边不一致时提示更新落后的一边
export const BRIDGE_PROTOCOL = 1

// native messaging 的宿主名：正式版、开发版分开，同时开着也不抢；test 给 e2e 用，不覆盖开发版的登记
export const NATIVE_HOST_NAMES = { packaged: 'dev.diffra.browser', development: 'dev.diffra.browser_dev', test: 'dev.diffra.browser_test' } as const

// 允许连宿主的扩展。development 由仓库里扩展清单的 key 决定，加载解压的扩展时 ID 不变；
// 两个商店的 ID 在第一次上架后由商店分配，拿到之后填在这里（见 docs/decisions.md「用户自己的浏览器」）
export const EXTENSION_IDS = {
  development: 'gnbcambhefcipgikjdfmfklhbjhebpia',
  chromeWebStore: null as string | null,
  edgeAddons: null as string | null,
}

export const EXTENSION_STORE_URLS = {
  chrome: EXTENSION_IDS.chromeWebStore ? `https://chromewebstore.google.com/detail/${EXTENSION_IDS.chromeWebStore}` : null,
  edge: EXTENSION_IDS.edgeAddons ? `https://microsoftedge.microsoft.com/addons/detail/${EXTENSION_IDS.edgeAddons}` : null,
}

export type ExternalBrowserKind = 'chrome' | 'edge' | 'chromium'

export interface BridgeTask {
  sessionId: string
  title: string
  running: boolean
}

// 扩展（经宿主）发给 Diffra 的
export type ExtensionMessage =
  // 宿主连上管道后的第一行：令牌证明它是这台电脑上这个用户装的 Diffra 登记的宿主
  | { type: 'host'; token: string; pid: number }
  | { type: 'hello'; protocol: number; extensionVersion: string; browser: ExternalBrowserKind; userAgent: string }
  | { type: 'reply'; id: number; result?: unknown; error?: string }
  // 调试协议的事件
  | { type: 'event'; tabId: number; method: string; params: Record<string, unknown> }
  // 调试断开：reason 是 canceled_by_user 时是用户在提示条上点了取消
  | { type: 'detached'; tabId: number; reason: string }
  | { type: 'tab-closed'; tabId: number }
  | { type: 'tab-updated'; tabId: number; url: string; title: string; loading: boolean }
  // 智能体的标签页里的网页开了新窗口
  | { type: 'tab-opened'; tabId: number; openerTabId: number }
  // 用户在扩展里把一个标签页交给某个任务
  | { type: 'share-tab'; tabId: number; sessionId: string }
  // 用户在扩展里停下某个任务
  | { type: 'stop'; sessionId: string }
  // 这个浏览器的窗口刚被用户切到前台，有多个浏览器连着时优先用它
  | { type: 'focus' }

// 扩展能做的事
export type BridgeCall =
  // 在「Diffra · 任务名」分组里开标签页
  | { method: 'tabs.create'; params: { sessionId: string; title: string; url: string; active: boolean } }
  | { method: 'tabs.close'; params: { tabId: number } }
  // 切到这个标签页，并把它所在的窗口放到前台
  | { method: 'tabs.activate'; params: { tabId: number } }
  // 不再由 Diffra 控制：断开调试，移出分组，标签页留着
  | { method: 'tabs.release'; params: { tabId: number } }
  // 任务改了名（或者标题晚到）：分组名跟着改
  | { method: 'groups.title'; params: { sessionId: string; title: string } }
  // 回复标签页现在的 { url, title, loading }
  | { method: 'debugger.attach'; params: { tabId: number } }
  | { method: 'cdp'; params: { tabId: number; method: string; params?: Record<string, unknown> } }

// Diffra 发给扩展的
export type DiffraMessage =
  | { type: 'welcome'; protocol: number; diffraVersion: string }
  | ({ type: 'call'; id: number } & BridgeCall)
  // 扩展弹窗里「交给 Diffra」能选的任务，任务列表变了就发
  | { type: 'tasks'; tasks: BridgeTask[] }

// 宿主自己发给扩展的：Diffra 有没有开着（管道连不上就是没开）
export type HostMessage = { type: 'diffra'; connected: boolean }
