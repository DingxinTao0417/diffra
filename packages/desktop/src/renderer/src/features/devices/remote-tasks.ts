import type { SessionUpdate, StoredTurn, TaskProgressView } from '@diffra/core/types'
import type { RemoteSnapshotPage, SessionList } from '@diffra/remote/messages'
import type { RemoteSyncEvent } from '../../../../shared/remote'
import { applySilence, applyUpdate, modelSilenceOf, newTurn, taskProgressOf, type Turn, turnFromStored, turnOutcomeOf, type Usage, usageOf } from '@/features/session/transcript'
import { errorMessage } from '@/lib/errors'
import { store } from '@/state/store'

// 连接端：看自己连接的设备授权给本机的会话（docs/decisions.md「设备连接」）。只读，状态只在内存里，不落盘。
// 订阅由远程任务页管：打开时订阅、拿一页快照，之后按被连接端推来的动静往上加；断了、被要求重来、对方一轮结束时重新订阅整页换掉。
// 对方来的内容在主进程只校验了外层，这里转换、应用出错时只让这一页报错，不让整个界面崩

export interface RemoteListState {
  list: SessionList | null
  loading: boolean
  error: string | null
}

export interface RemoteTask {
  deviceId: string
  sessionId: string
  title: string
  projectId: string
  running: boolean
  progress?: TaskProgressView
  usage: Usage | null
  turns: Turn[]
  // turns 是全部轮次里从 start 开始的那些；start > 0 时上面还有更早的
  start: number
  totalTurns: number
  status: 'loading' | 'ready' | 'offline' | 'error'
  error: string | null
  // 加一就让远程任务页重新订阅
  generation: number
  loadingEarlier: boolean
}

export const remoteKey = (deviceId: string, sessionId: string) => `${deviceId}/${sessionId}`

function turnsOf(page: RemoteSnapshotPage): Turn[] {
  return page.turns.map((turn) => {
    const omittedImages = typeof turn.omittedImages === 'number' ? turn.omittedImages : 0
    return { ...turnFromStored(turn as unknown as StoredTurn), ...(omittedImages > 0 ? { omittedImages } : {}) }
  })
}

function updateTask(key: string, change: (task: RemoteTask) => RemoteTask): void {
  store.set((state) => {
    const task = state.remoteTasks[key]
    return task ? { ...state, remoteTasks: { ...state.remoteTasks, [key]: change(task) } } : state
  })
}

export async function loadRemoteList(deviceId: string): Promise<void> {
  store.set((state) => ({ ...state, remoteLists: { ...state.remoteLists, [deviceId]: { list: state.remoteLists[deviceId]?.list ?? null, loading: true, error: null } } }))
  try {
    const list = await window.diffra.listRemoteSessions(deviceId)
    store.set((state) => ({ ...state, remoteLists: { ...state.remoteLists, [deviceId]: { list, loading: false, error: null } } }))
    // 对方一轮跑完、开始：列表里的状态和正在看的不一样了，跑完的重新订阅拿最后的样子
    for (const session of list.sessions) {
      const task = store.get().remoteTasks[remoteKey(deviceId, session.sessionId)]
      if (!task || task.status !== 'ready' || task.running === session.running) continue
      updateTask(remoteKey(deviceId, session.sessionId), (current) => (session.running ? { ...current, running: true } : { ...current, generation: current.generation + 1 }))
    }
  } catch (error) {
    store.set((state) => ({ ...state, remoteLists: { ...state.remoteLists, [deviceId]: { list: state.remoteLists[deviceId]?.list ?? null, loading: false, error: errorMessage(error) } } }))
  }
}

export async function subscribeRemote(deviceId: string, sessionId: string): Promise<void> {
  const key = remoteKey(deviceId, sessionId)
  store.set((state) => {
    const current = state.remoteTasks[key]
    const task: RemoteTask = current
      ? { ...current, status: 'loading', error: null }
      : { deviceId, sessionId, title: '', projectId: '', running: false, usage: null, turns: [], start: 0, totalTurns: 0, status: 'loading', error: null, generation: 0, loadingEarlier: false }
    return { ...state, remoteTasks: { ...state.remoteTasks, [key]: task } }
  })
  try {
    const page = await window.diffra.subscribeRemoteSession(deviceId, sessionId)
    const turns = turnsOf(page)
    updateTask(key, (task) => {
      // 重新订阅只拿最近一页：之前往前翻出来的、和新一页接得上的（同一位置是同一轮）留着，不让看到的内容缩回去
      const kept = task.start < page.start && turns.length > 0 && task.turns[page.start - task.start]?.id === turns[0]!.id ? task.turns.slice(0, page.start - task.start) : []
      return { ...task, title: page.title, projectId: page.projectId, running: page.running, progress: page.taskState, turns: [...kept, ...turns], start: page.start - kept.length, totalTurns: page.totalTurns, status: 'ready', error: null }
    })
  } catch (error) {
    updateTask(key, (task) => ({ ...task, status: 'error', error: errorMessage(error) }))
  }
}

export function unsubscribeRemote(deviceId: string, sessionId: string): void {
  window.diffra.unsubscribeRemoteSession(deviceId, sessionId).catch((error: unknown) => console.error('[remote] 退订失败', error))
}

export function dropRemoteTask(key: string): void {
  store.set((state) => {
    if (!(key in state.remoteTasks)) return state
    const { [key]: _dropped, ...rest } = state.remoteTasks
    return { ...state, remoteTasks: rest }
  })
}

export function markRemoteOffline(key: string): void {
  updateTask(key, (task) => (task.status === 'ready' || task.status === 'loading' ? { ...task, status: 'offline' } : task))
}

export async function loadEarlierRemote(key: string): Promise<void> {
  const task = store.get().remoteTasks[key]
  if (!task || task.start === 0 || task.loadingEarlier) return
  updateTask(key, (current) => ({ ...current, loadingEarlier: true }))
  try {
    const page = await window.diffra.pageRemoteSession(task.deviceId, task.sessionId, task.start)
    const earlier = turnsOf(page)
    updateTask(key, (current) => ({ ...current, turns: [...earlier, ...current.turns.filter((turn) => !earlier.some((item) => item.id === turn.id))], start: page.start, loadingEarlier: false }))
  } catch (error) {
    updateTask(key, (current) => ({ ...current, loadingEarlier: false, error: errorMessage(error) }))
  }
}

// 和本机任务收会话更新的办法一样（state/actions.ts 的 wireCoreEvents）
function applyLive(task: RemoteTask, update: SessionUpdate): RemoteTask {
  const usage = usageOf(update)
  if (usage) return { ...task, usage }
  const last = task.turns.at(-1)
  if (!last) return task
  const silence = modelSilenceOf(update)
  if (silence) return { ...task, turns: [...task.turns.slice(0, -1), { ...last, silence: applySilence(last.silence, silence) }] }
  const outcome = turnOutcomeOf(update)
  return {
    ...task,
    // 一轮的结论到了：这一轮结束
    running: outcome ? false : task.running,
    progress: taskProgressOf(update) ?? task.progress,
    turns: [...task.turns.slice(0, -1), { ...last, items: applyUpdate(last.items, update), outcome: outcome ?? last.outcome, ...(outcome ? { endedAt: Date.now() } : {}) }],
  }
}

export function applyRemoteEvent(payload: RemoteSyncEvent): void {
  const { deviceId } = payload
  if ('disconnected' in payload) {
    // 通道断了：正在看的都要重新订阅（对方还在线时马上重连，不在线时等它回来）
    store.set((state) => ({
      ...state,
      remoteTasks: Object.fromEntries(Object.entries(state.remoteTasks).map(([key, task]) => [key, task.deviceId === deviceId ? { ...task, status: task.status === 'ready' ? 'offline' : task.status, generation: task.generation + 1 } : task])),
    }))
    return
  }
  const { event } = payload
  switch (event.event) {
    case 'session.updates': {
      const key = remoteKey(deviceId, event.sessionId)
      try {
        updateTask(key, (task) => (task.status === 'ready' ? event.updates.reduce((current, { update }) => applyLive(current, update as unknown as SessionUpdate), task) : task))
      } catch (error) {
        console.error('[remote] 应用对方的会话更新出错，重新订阅', error)
        updateTask(key, (task) => ({ ...task, generation: task.generation + 1 }))
      }
      return
    }
    case 'turn.started':
      updateTask(remoteKey(deviceId, event.sessionId), (task) =>
        task.status !== 'ready' || task.turns.some((turn) => turn.id === event.turnId)
          ? task
          : { ...task, running: true, totalTurns: task.totalTurns + 1, turns: [...task.turns, newTurn(event.turnId, event.prompt, event.kind as Turn['kind'])] },
      )
      return
    case 'session.reset':
      updateTask(remoteKey(deviceId, event.sessionId), (task) => ({ ...task, generation: task.generation + 1 }))
      return
    case 'sessions.changed':
      void loadRemoteList(deviceId)
      return
    default:
      return
  }
}
