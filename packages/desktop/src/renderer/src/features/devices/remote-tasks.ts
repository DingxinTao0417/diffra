import type { CheckpointChange, CommandInfo, PermissionMode, PromptImage, SessionUpdate, SkillInfo, StoredTurn, TaskProgressView, ToolCallContent } from '@diffra/core/types'
import type { RemoteEvent, RemoteSessionDetails, RemoteSnapshotPage, SessionList } from '@diffra/remote/messages'
import type { RemoteSyncEvent } from '../../../../shared/remote'
import type { ModelRef, ProviderView } from '../../../../shared/settings'
import { applySilence, applyUpdate, modelSilenceOf, newTurn, taskProgressOf, type Turn, turnFromStored, turnOutcomeOf, type Usage, usageOf, visualSnapshotOf, withVisualSnapshot } from '@/features/session/transcript'
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
  // 订阅失败后自动重试过几次；对方明确拒绝（关了总开关、没授权本机）时不自动重试
  retries: number
  refused: boolean
  // 对方任务页的配置（模型、权限模式、分支、检查命令……），对方是 0.3.x 时没有
  details: RemoteSessionDetails | null
  // 对方的模型服务（切换模型时取）
  providers?: ProviderView[]
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
    // 对方一轮跑完、开始：列表里的状态和正在看的不一样了，跑完的重新订阅拿最后的样子。
    // 这一轮的结论可能比列表先到（结论随会话更新 150 毫秒一批，列表变动一秒最多说一次），那时这边已经是「没在跑」，
    // 所以最后一轮还有没过来的图片时也要重新订阅，不然图片一直不来
    for (const session of list.sessions) {
      const task = store.get().remoteTasks[remoteKey(deviceId, session.sessionId)]
      if (!task || task.status !== 'ready') continue
      const imagesPending = !session.running && Boolean(task.turns.at(-1)?.pendingImages)
      if (task.running === session.running && !imagesPending) continue
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
          retries: 0,
          refused: false,
          details: null,
        }
    return { ...state, remoteTasks: { ...state.remoteTasks, [key]: task } }
  })
  try {
    const current = store.get().remoteTasks[key]
    const resume = current?.resumable && current.epoch !== null ? { epoch: current.epoch, seq: current.seq } : undefined
    const result = await window.diffra.subscribeRemoteSession(deviceId, sessionId, resume)
    if ('resumed' in result) {
      // 续上了：内容留着，缺的随后补发过来
      updateTask(key, (task) => ({ ...task, running: result.running, status: 'ready', error: null, resumable: false, retries: 0, refused: false }))
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
        retries: 0,
        refused: false,
      }
    })
  } catch (error) {
    updateTask(key, (task) => ({ ...task, status: 'error', error: errorMessage(error) }))
  }
}

// 订阅失败后再试一次（远程任务页的「重试」，或者对方在线时自动隔几秒重试），列表也一起重取
export function retryRemote(key: string, auto: boolean): void {
  const task = store.get().remoteTasks[key]
  if (!task) return
  updateTask(key, (current) => ({ ...current, generation: current.generation + 1, retries: auto ? current.retries + 1 : 0, refused: false }))
  void loadRemoteList(task.deviceId)
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

// 对方任务页的配置：订阅上之后、一轮结束时取。拿不到只记日志，任务页照样能看对话
export async function loadRemoteDetails(key: string): Promise<void> {
  const task = store.get().remoteTasks[key]
  if (!task) return
  try {
    const details = (await window.diffra.remoteCall(task.deviceId, { method: 'session.details', sessionId: task.sessionId })) as RemoteSessionDetails
    updateTask(key, (current) => ({ ...current, details }))
  } catch (error) {
    console.error('[remote] 读对方任务的配置失败', error)
  }
}

// 从某一轮开始到现在的文件改动（任务监控、审阅改动）
export async function remoteDiff(key: string, turnId: string): Promise<string> {
  const task = store.get().remoteTasks[key]
  if (!task) throw new Error('这个任务已经关了')
  const { diff } = (await window.diffra.remoteCall(task.deviceId, { method: 'session.diff', sessionId: task.sessionId, turnId })) as { diff: string }
  return diff
}

// 展开只同步了开头的工具输出：向对方要这一步的全部输出，写回这一步。对方按这一轮在全部轮次里的位置找，再核对轮次 id
export async function loadRemoteToolOutput(key: string, toolCallId: string): Promise<void> {
  const task = store.get().remoteTasks[key]
  const index = task ? task.turns.findIndex((turn) => turn.items.some((item) => item.kind === 'tool' && item.id === toolCallId)) : -1
  const turn = task?.turns[index]
  if (!task || !turn) throw new Error('找不到这一步，重新打开这个任务')
  const { content } = await window.diffra.remoteToolOutput(task.deviceId, task.sessionId, task.start + index, turn.id, toolCallId)
  updateTask(key, (current) => ({
    ...current,
    turns: current.turns.map((item) =>
      item.id === turn.id ? { ...item, items: item.items.map((entry) => (entry.kind === 'tool' && entry.id === toolCallId ? { ...entry, content: content as unknown as ToolCallContent[] } : entry)) } : item,
    ),
  }))
}

// 和本机任务收会话更新的办法一样（state/actions.ts 的 wireCoreEvents）
function applyLive(task: RemoteTask, update: SessionUpdate): RemoteTask {
  const usage = usageOf(update)
  if (usage) return { ...task, usage }
  if (visualSnapshotOf(update).visualSnapshot) return { ...task, turns: withVisualSnapshot(task.turns, update) }
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

// 远程终端的输出、结束：按终端 id 交给开着它的面板（RemoteTerminalPanel）；面板还没登记（开终端的回复还没到）时先攒着，
// 攒满就不再攒；没人登记就结束了的直接丢掉
type TerminalItem = { data: string } | { exit: number | null }
interface TerminalListener {
  data(data: string): void
  exit(code: number | null): void
}
const terminalListeners = new Map<string, TerminalListener>()
const terminalPending = new Map<string, TerminalItem[]>()
const MAX_TERMINAL_PENDING = 256

export function listenRemoteTerminal(terminalId: string, listener: TerminalListener): () => void {
  terminalListeners.set(terminalId, listener)
  for (const item of terminalPending.get(terminalId) ?? []) deliverTerminal(terminalId, item)
  terminalPending.delete(terminalId)
  return () => terminalListeners.delete(terminalId)
}

function deliverTerminal(terminalId: string, item: TerminalItem): void {
  const listener = terminalListeners.get(terminalId)
  if (listener) return 'data' in item ? listener.data(item.data) : listener.exit(item.exit)
  if ('exit' in item) return void terminalPending.delete(terminalId)
  const pending = terminalPending.get(terminalId) ?? []
  if (pending.length < MAX_TERMINAL_PENDING) terminalPending.set(terminalId, [...pending, item])
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
  if ('refused' in payload) {
    // 对方明确拒绝本机（关了总开关、撤销了授权）：它开放的项目从侧栏收起，正在看的任务停在这个原因上、不自动重试。
    // 互相配对时对方在中转上仍显示在线，所以不能只看在线状态
    store.set((state) => ({
      ...state,
      remoteLists: { ...state.remoteLists, [deviceId]: { list: null, loading: false, error: payload.message } },
      remoteTasks: Object.fromEntries(
        Object.entries(state.remoteTasks).map(([key, task]) => [key, task.deviceId === deviceId ? { ...task, status: 'error', error: payload.message, refused: true, permission: null } : task]),
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
          : {
              ...task,
              running: true,
              totalTurns: task.totalTurns + 1,
              turns: [...task.turns, { ...newTurn(event.turnId, event.prompt, event.kind as Turn['kind'], [], [], event.from, event.remote), ...(event.imageCount ? { pendingImages: event.imageCount } : {}) }],
            },
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
    case 'terminal.data':
      deliverTerminal(event.terminalId, { data: event.data })
      return
    case 'terminal.exit':
      deliverTerminal(event.terminalId, { exit: event.exitCode })
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

// 以下是操作，对方按授权检查；出错只提示，不改这一页的状态（结果会经推送回来）。
// extras：本机输入框的 Skill、目标、计划模式和图片（对方 0.3.x 时不带，只发文字）
export async function sendRemote(key: string, text: string, extras?: { skills: string[]; goal: boolean; plan: boolean; images: PromptImage[] }): Promise<boolean> {
  const task = store.get().remoteTasks[key]
  if (!task) return false
  try {
    const { queued } = extras
      ? ((await window.diffra.remoteCall(task.deviceId, { method: 'session.prompt', sessionId: task.sessionId, text, ...extras })) as { queued: boolean })
      : await window.diffra.promptRemoteSession(task.deviceId, task.sessionId, text)
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

// 对方的模型服务：打开模型菜单时取
export async function loadRemoteProviders(key: string): Promise<void> {
  const task = store.get().remoteTasks[key]
  if (!task) return
  try {
    const { providers } = (await window.diffra.remoteCall(task.deviceId, { method: 'models.list' })) as { providers: ProviderView[] }
    updateTask(key, (current) => ({ ...current, providers }))
  } catch (error) {
    showToast(`读对方的模型失败：${errorMessage(error)}`)
  }
}

// 斜杠菜单里对方的 Skill 和自定义命令
export async function remoteSkills(key: string): Promise<SkillInfo[]> {
  const task = store.get().remoteTasks[key]
  if (!task) return []
  const { skills } = (await window.diffra.remoteCall(task.deviceId, { method: 'skills.list', sessionId: task.sessionId })) as { skills: SkillInfo[] }
  return skills
}

export async function remoteCommands(key: string): Promise<CommandInfo[]> {
  const task = store.get().remoteTasks[key]
  if (!task) return []
  const { commands } = (await window.diffra.remoteCall(task.deviceId, { method: 'commands.list', sessionId: task.sessionId })) as { commands: CommandInfo[] }
  return commands
}

// 对方项目的本地分支（底栏的分支菜单）
export async function remoteBranches(key: string): Promise<{ current: string | null; branches: string[] }> {
  const task = store.get().remoteTasks[key]
  if (!task) return { current: null, branches: [] }
  return (await window.diffra.remoteCall(task.deviceId, { method: 'project.branches', sessionId: task.sessionId })) as { current: string | null; branches: string[] }
}

// 撤销之前列出会改回去的文件
export async function remoteRestorePreview(key: string, turnId: string): Promise<CheckpointChange[]> {
  const task = store.get().remoteTasks[key]
  if (!task) return []
  const { changes } = (await window.diffra.remoteCall(task.deviceId, { method: 'session.restorePreview', sessionId: task.sessionId, turnId })) as { changes: CheckpointChange[] }
  return changes
}

// 改对方任务的操作：做完再取一次配置（模型、权限模式变了）；撤销、重新生成改了整段记录，对方会推 session.reset 让这一页重来
type RemoteChange =
  | { method: 'session.setModel'; ref: ModelRef }
  | { method: 'session.setPermissionMode'; mode: PermissionMode }
  | { method: 'session.compact' }
  | { method: 'session.regenerate' | 'session.restore'; turnId: string }
  | { method: 'project.switchBranch'; branch: string }

export async function changeRemote(key: string, change: RemoteChange): Promise<void> {
  const task = store.get().remoteTasks[key]
  if (!task) return
  await window.diffra.remoteCall(task.deviceId, { ...change, sessionId: task.sessionId })
  void loadRemoteDetails(key)
}
