import { useContext } from 'react'
import { type PinnedItem, store, useAppState } from '@/state/store'
import { AnswerContext } from './answer-links'

// 白板（第 668、677 步）：固定、取下，记下来自第几轮。本机任务才有（远程、只读的会话没有）

// 这个元素在第几轮里：按它所在的轮次在任务里的位置
export function pinnedFrom(sessionId: string, element: Element | null): { from?: string } {
  const turnId = element?.closest('[data-turn-id]')?.getAttribute('data-turn-id')
  const index = turnId ? (store.get().live[sessionId]?.turns.findIndex((turn) => turn.id === turnId) ?? -1) : -1
  return index >= 0 ? { from: `第 ${index + 1} 轮` } : {}
}

export function pinItem(item: PinnedItem) {
  // 固定后打开白板
  store.set((state) => ({ ...state, pinned: [...state.pinned.filter((entry) => !(entry.sessionId === item.sessionId && entry.id === item.id)), item], panel: 'visuals' }))
}

export function unpinItem(sessionId: string, id: string) {
  store.set((state) => ({ ...state, pinned: state.pinned.filter((entry) => !(entry.sessionId === sessionId && entry.id === id)) }))
}

// 回答里的富块按内容认：同一段围栏固定一次
export function blockPinId(text: string): string {
  let hash = 5381
  for (let index = 0; index < text.length; index++) hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
  return `block-${(hash >>> 0).toString(36)}-${text.length}`
}

// 这个任务能不能固定（本机任务）、这一项固定了没有
export function usePinTarget(id: string | null): { sessionId: string; pinned: boolean } | null {
  const sessionId = useContext(AnswerContext)?.sessionId ?? null
  const pinned = useAppState((state) => Boolean(sessionId && id && state.pinned.some((item) => item.sessionId === sessionId && item.id === id)))
  return sessionId ? { sessionId, pinned } : null
}
