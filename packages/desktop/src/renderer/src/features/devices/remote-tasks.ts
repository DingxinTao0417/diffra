import type { SessionUpdate, StoredTurn, TaskProgressView } from '@diffra/core/types'
import type { RemoteEvent, RemoteSnapshotPage, SessionList } from '@diffra/remote/messages'
import type { RemoteSyncEvent } from '../../../../shared/remote'
import { applySilence, applyUpdate, modelSilenceOf, newTurn, taskProgressOf, type Turn, turnFromStored, turnOutcomeOf, type Usage, usageOf } from '@/features/session/transcript'
import { errorMessage } from '@/lib/errors'
import { showToast, store } from '@/state/store'

// 连接端：看、操作自己连接的设备授权给本机的会话（docs/decisions.md「设备连接」）。状态只在内存里，不落盘；操作是否允许由对方检查。
// 订阅由远程任务页管：打开时订阅、拿一页快照，之后按被连接端推来的动静往上加；被要求重来、对方一轮结束时重新订阅整页换掉；
// 断了重连时带上看到的位置，对方接得上就只补发缺的（断线续传），接不上照样整页换掉。
// 对方来的内容在主进程只校验了外层，这里转换、应用出错时只让这一页报错，不让整个界面崩

export interface RemoteListState {
  list: SessionList | null
  loading: boolean
  error: string | null
}

// 对方在等确认、发给了本机（项目开放了「可查看和操作」）
export type RemotePermission = Extract<RemoteEvent, { event: 'permission.request' }>

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
  permission: RemotePermission | null
  // 看到的位置：对方 core 的 epoch 和最后一条更新的序号；断线后为 true，重新订阅时带上位置续传
  epoch: string | null
  seq: number
  resumable: boolean
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
      : {
          deviceId,
          sessionId,
          title: '',
          projectId: '',
          running: false,
          usage: null,
          turns: [],
          start: 0,
          totalTurns: 0,
          status: 'loading',
          error: null,
          generation: 0,
          loadingEarlier: false,
          permission: null,
          epoch: null,
          seq: 0,
          resumable: false,
        }
    return { ...state, remoteTasks: { ...state.remoteTasks, [key]: task } }
  })
  try {
    const current = store.get().remoteTasks[key]
    const resume = current?.resumable && current.epoch !== null ? { epoch: current.epoch, seq: current.seq } : undefined
    const result = await window.diffra.subscribeRemoteSession(deviceId, sessionId, resume)
    if ('resumed' in result) {
      // 续上了：内容留着，缺的随后补发过来
      updateTask(key, (task) => ({ ...task, running: result.running, status: 'ready', error: null, resumable: false }))
      return
    }
    const page = result
    const turns = turnsOf(page)
    updateTask(key, (task) => {
      // 重新订阅只拿最近一页：之前往前翻出来的、和新一页接得上的（同一位置是同一轮）留着，不让看到的内容缩回去
      const kept = task.start < page.start && turns.length > 0 && task.turns[page.start - task.start]?.id === turns[0]!.id ? task.turns.slice(0, page.start - task.start) : []
      return {
        ...task,
        title: page.title,
        projectId: page.projectId,
        running: page.running,
        progress: page.taskState,
        turns: [...kept, ...turns],
        start: page.start - kept.length,
        totalTurns: page.totalTurns,
        status: 'ready',
        error: null,
        epoch: page.epoch,
        seq: page.seq,
        resumable: false,
      }
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
    // 通道断了：正在看的都要重新订阅（对方还在线时马上重连，不在线时等它回来）；在等的确认作废，重新订阅时对方会再发
    store.set((state) => ({
      ...state,
      remoteTasks: Object.fromEntries(
        Object.entries(state.remoteTasks).map(([key, task]) => [
          key,
          task.deviceId === deviceId
            ? { ...task, status: task.status === 'ready' ? 'offline' : task.status, generation: task.generation + 1, permission: null, resumable: task.resumable || task.status === 'ready' }
            : task,
        ]),
      ),
    }))
    return
  }
  const { event } = payload
  switch (event.event) {
    case 'session.updates': {
      const key = remoteKey(deviceId, event.sessionId)
      try {
        updateTask(key, (task) => {
          if (task.status !== 'ready') return task
          // 对方 core 重启过：序号重新数了，整页重来
          if (task.epoch !== null && task.epoch !== event.epoch) return { ...task, generation: task.generation + 1 }
          const applied = event.updates.reduce((current, { update }) => applyLive(current, update as unknown as SessionUpdate), task)
          return { ...applied, epoch: event.epoch, seq: Math.max(task.seq, ...event.updates.map((item) => item.seq)) }
        })
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
          : { ...task, running: true, totalTurns: task.totalTurns + 1, turns: [...task.turns, newTurn(event.turnId, event.prompt, event.kind as Turn['kind'], [], [], event.from, event.remote)] },
      )
      return
    case 'session.reset':
      updateTask(remoteKey(deviceId, event.sessionId), (task) => ({ ...task, generation: task.generation + 1 }))
      return
    case 'sessions.changed':
      void loadRemoteList(deviceId)
      return
    case 'permission.request':
      updateTask(remoteKey(deviceId, event.sessionId), (task) => ({ ...task, permission: event }))
      return
    case 'permission.settled':
      store.set((state) => ({
        ...state,
        remoteTasks: Object.fromEntries(Object.entries(state.remoteTasks).map(([key, task]) => [key, task.deviceId === deviceId && task.permission?.requestId === event.requestId ? { ...task, permission: null } : task])),
      }))
      return
    default:
      return
  }
}

// 以下是操作，对方按授权检查；出错只提示，不改这一页的状态（结果会经推送回来）
export async function sendRemote(key: string, text: string): Promise<boolean> {
  const task = store.get().remoteTasks[key]
  if (!task) return false
  try {
    const { queued } = await window.diffra.promptRemoteSession(task.deviceId, task.sessionId, text)
    if (queued) showToast('对方正在跑，这条消息排在这一轮后面')
    return true
  } catch (error) {
    showToast(errorMessage(error))
    return false
  }
}

export function stopRemote(key: string): void {
  const task = store.get().remoteTasks[key]
  if (!task) return
  window.diffra.cancelRemoteSession(task.deviceId, task.sessionId).catch((error: unknown) => showToast(errorMessage(error)))
}

export function answerRemotePermission(key: string, optionId: 'allow_once' | 'reject'): void {
  const task = store.get().remoteTasks[key]
  const permission = task?.permission
  if (!task || !permission) return
  updateTask(key, (current) => ({ ...current, permission: null }))
  window.diffra.respondRemotePermission(task.deviceId, permission.requestId, optionId).catch((error: unknown) => showToast(errorMessage(error)))
}

// 在对方开放的项目里新建任务；建好返回会话 id
export async function createRemoteTask(deviceId: string, projectId: string, text: string): Promise<string | null> {
  try {
    const { sessionId } = await window.diffra.createRemoteSession(deviceId, projectId, text)
    void loadRemoteList(deviceId)
    return sessionId
  } catch (error) {
    showToast(errorMessage(error))
    return null
  }
}
