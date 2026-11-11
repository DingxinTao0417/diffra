import type { SessionNotification, TurnKind } from '@diffra/core/types'

// 主进程里会话的动静，设备连接据此给看着的设备推送（docs/decisions.md「设备连接」）：
// update 是 core 推来的会话更新（带 seq）；turn-started 在把一轮交给 core 之前发——一轮开始时 core 不推会话更新，界面是自己建的；
// changed 是列表可能变了（一轮结束、改名、归档、删除）；reset 是整段记录变了（撤销、重新生成），看着的要重新取
export type SessionEvent =
  | { type: 'update'; notification: SessionNotification }
  | { type: 'turn-started'; sessionId: string; turnId: string; kind: TurnKind; prompt: string; startedAt: string }
  | { type: 'changed'; sessionId: string }
  | { type: 'reset'; sessionId: string }

const listeners = new Set<(event: SessionEvent) => void>()

export function onSessionEvent(listener: (event: SessionEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitSessionEvent(event: SessionEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch (error) {
      console.error('[session-events] 处理会话事件出错', error)
    }
  }
}

// 把一轮交给 core：先说一声开始了，跑完（不管成败）再说列表可能变了
export async function aroundTurn<T>(sessionId: string, turnId: string, kind: TurnKind, prompt: string, run: () => Promise<T>): Promise<T> {
  emitSessionEvent({ type: 'turn-started', sessionId, turnId, kind, prompt, startedAt: new Date().toISOString() })
  try {
    return await run()
  } finally {
    emitSessionEvent({ type: 'changed', sessionId })
  }
}
