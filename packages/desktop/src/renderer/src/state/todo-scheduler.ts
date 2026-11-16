import { advanceRepeat, type Todo, todoMessage, todoParts, type TodoSchedule } from '../../../shared/todos'
import { errorMessage } from '@/lib/errors'
import { saveTodos, sendInBackground, startInBackground, todoMessageWithAttachments } from './actions'
import { showToast, store } from './store'

// 最多隔这么久查一次：电脑睡眠、改了系统时间后计时器可能不准，靠定期查兜底
const CHECK_MS = 30_000
// 启动前就到点的（应用当时没开）算错过；留一点余量给启动本身
const STARTUP_GRACE_MS = 60_000
// 定时发送晚了这么久（比如电脑睡着了）就不自动发，等用户决定
const SEND_LATE_MS = 10 * 60_000

type Result = NonNullable<TodoSchedule['result']>

// 待办到点的处理放在界面这边：待办只由界面写，不会和主进程抢着存；窗口关了应用就退出，界面在就等于应用在。
// 提醒：系统通知；定时发送：在后台发给任务，不切走正在看的页面。
export function startTodoScheduler(): () => void {
  const startedAt = Date.now()
  const firing = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let seen: Todo[] | null = null

  const arm = () => {
    clearTimeout(timer)
    const now = Date.now()
    const next = (store.get().todos ?? [])
      .filter((todo) => !todo.done && todo.schedule && !todo.schedule.result)
      .map((todo) => Date.parse(todo.schedule!.at))
      .reduce((min, at) => Math.min(min, at), Infinity)
    timer = setTimeout(tick, Math.max(0, Math.min(next - now, CHECK_MS)))
  }

  const tick = () => {
    const todos = store.get().todos
    const now = Date.now()
    for (const todo of todos ?? []) {
      const schedule = todo.schedule
      if (todo.done || !schedule || schedule.result || firing.has(todo.id) || Date.parse(schedule.at) > now) continue
      firing.add(todo.id)
      fire(todo, schedule, now)
        .catch((error: unknown) => console.error('[todos] 处理到点的待办失败', error))
        .finally(() => firing.delete(todo.id))
    }
    arm()
  }

  const fire = async (todo: Todo, schedule: TodoSchedule, now: number) => {
    const at = Date.parse(schedule.at)
    const whileClosed = at < startedAt - STARTUP_GRACE_MS
    if (schedule.action.kind === 'remind') {
      if (!whileClosed) await window.diffra.notifyTodo({ todoId: todo.id, title: '待办到时间了', body: todoMessage(todo) })
      await record(todo.id, schedule.at, { kind: whileClosed ? 'missed' : 'reminded', at: new Date().toISOString() })
      return
    }
    if (whileClosed || now - at > SEND_LATE_MS) {
      if (!whileClosed) await window.diffra.notifyTodo({ todoId: todo.id, title: '错过了定时发送', body: `${todoParts(todo).title}\n${schedule.repeat ? '这一次跳过，到下一次再发。' : '到待办页选择现在发送或取消。'}` })
      await record(todo.id, schedule.at, { kind: 'missed', at: new Date().toISOString() })
      return
    }
    try {
      const sentTo = await sendScheduled(todo, schedule.action)
      await record(todo.id, schedule.at, { kind: 'sent', at: new Date().toISOString() }, sentTo)
      await window.diffra.notifyTodo({ todoId: todo.id, title: `已按时发给任务「${sentTo.title}」`, body: todoParts(todo).title })
    } catch (error) {
      await record(todo.id, schedule.at, { kind: 'failed', at: new Date().toISOString(), error: errorMessage(error) })
      await window.diffra.notifyTodo({ todoId: todo.id, title: '定时发送失败', body: `${todoParts(todo).title}\n${errorMessage(error)}` })
    }
  }

  // 存结果时按 id 和到期时刻对上：处理期间用户改了时间，就不覆盖。
  // 重复的（v2）：这一次的结果记进 last，挪到下一次接着等；错过的（应用没开着）也直接跳到下一次，不等用户补发
  const record = (id: string, at: string, result: Result, sentTo?: Todo['sentTo']) =>
    saveTodos((todos) =>
      todos.map((todo) => {
        if (todo.id !== id || todo.schedule?.at !== at) return todo
        const withSent = sentTo ? { ...todo, sentTo } : todo
        return todo.schedule.repeat ? advanceRepeat(withSent, result, Date.now()) : { ...withSent, schedule: { ...todo.schedule, result } }
      }),
    )

  const unsubscribe = store.subscribe(() => {
    const todos = store.get().todos
    if (todos === seen) return
    seen = todos
    tick()
  })
  tick()
  return () => {
    unsubscribe()
    clearTimeout(timer)
  }
}

// 把定时发送的内容发出去，返回派给了哪个任务；带上待办发送时的附件
export async function sendScheduled(todo: Pick<Todo, 'images' | 'files'>, action: Extract<TodoSchedule['action'], { kind: 'send' }>): Promise<NonNullable<Todo['sentTo']>> {
  const at = new Date().toISOString()
  const message = await todoMessageWithAttachments([todo], action.text)
  if (action.target.kind === 'new') {
    const created = await startInBackground(action.target.project, message.text, { design: action.target.design }, { images: message.images })
    return { sessionId: created.sessionId, title: created.title, at }
  }
  const sent = await sendInBackground(action.target.sessionId, message.text, { images: message.images })
  if (!sent) throw new Error(`任务「${action.target.title}」已经不在了`)
  return { sessionId: action.target.sessionId, title: sent.title, at }
}

// 错过或失败的定时发送，用户点「现在发送」
export async function sendScheduleNow(todo: Todo): Promise<void> {
  const schedule = todo.schedule
  if (schedule?.action.kind !== 'send') return
  try {
    const sentTo = await sendScheduled(todo, schedule.action)
    await saveTodos((todos) => todos.map((item) => (item.id === todo.id ? { ...item, sentTo, schedule: { ...schedule, result: { kind: 'sent', at: new Date().toISOString() } } } : item)))
  } catch (error) {
    showToast(`发送失败：${errorMessage(error)}`)
  }
}
