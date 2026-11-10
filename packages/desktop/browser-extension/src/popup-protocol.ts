import type { BridgeTask } from '../../src/shared/browser-bridge'

// 弹窗和后台之间的消息
export type PopupRequest =
  | { kind: 'state'; tabId: number | null }
  | { kind: 'share'; host: string; tabId: number; sessionId: string }
  | { kind: 'release'; tabId: number }
  | { kind: 'stop'; host: string; sessionId: string }
  | { kind: 'retry' }

export interface PopupState {
  links: Array<{ host: string; connected: boolean; hostRunning: boolean; missing: boolean; tasks: BridgeTask[] }>
  // 当前标签页交给了哪个任务
  tab: { host: string; sessionId: string } | null
  // 手上有标签页的任务
  busy: Array<{ host: string; sessionId: string }>
}
