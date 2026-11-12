import { createHash } from 'node:crypto'

// 卡死检测的补充（第 440 步，参照 qwen-code 的 loopDetectionService）。主循环原有的检测只认「同一个调用、结果也一样」；
// 这里补三种原地打转的样子，都只提醒一次、不停下：提醒错了代价只是多一句话，停错了会打断正常的任务。成功改了文件就重新算
const SAME_CALL_REPEATS = 6
const READ_STREAK = 12
const SAME_TEXT_REPEATS = 3
// 太短的话（「好的」「继续」）重复出现很正常，不算
const MIN_TEXT_CHARS = 20
const READ_TOOLS = new Set(['read_file', 'list_files', 'search', 'outline'])

type SpinKind = 'same-call' | 'read-only' | 'same-text'

const REMINDERS: Record<SpinKind, string> = {
  'same-call': `[Diffra] You have made the same call ${SAME_CALL_REPEATS} times without changing any file in between. Repeating it will not give you anything new: act on what you already know, or try a different approach.`,
  'read-only': `[Diffra] Your last ${READ_STREAK} calls only read or searched, and nothing has changed since. If you have what you need, make the change now; if something is blocking you, say what it is instead of reading further.`,
  'same-text': `[Diffra] You have written the same message ${SAME_TEXT_REPEATS} times. Do not repeat it: move on to the next concrete action, or explain what is blocking you.`,
}

export interface SpinTracker {
  // 工具名加参数的哈希 → 自上次成功编辑以来出现的次数（结果不一样也算，比如带时间的输出）
  calls: Map<string, number>
  // 连续的只读调用数；这一轮还没做过别的事（刚开始摸代码）时不算
  readStreak: number
  acted: boolean
  texts: Map<string, number>
  reminded: Set<SpinKind>
  pending: SpinKind[]
}

export function newSpinTracker(): SpinTracker {
  return { calls: new Map(), readStreak: 0, acted: false, texts: new Map(), reminded: new Set(), pending: [] }
}

function flag(tracker: SpinTracker, kind: SpinKind): void {
  if (tracker.reminded.has(kind)) return
  tracker.reminded.add(kind)
  tracker.pending.push(kind)
}

// 成功改了文件：之前的重复不再算数
export function noteEdit(tracker: SpinTracker): void {
  tracker.calls.clear()
  tracker.texts.clear()
  tracker.readStreak = 0
  tracker.acted = true
  tracker.reminded.clear()
  tracker.pending = []
}

// 一次没改文件的工具调用
export function noteCall(tracker: SpinTracker, toolName: string, input: unknown): void {
  const key = createHash('sha256').update(JSON.stringify([toolName, input])).digest('hex')
  const count = (tracker.calls.get(key) ?? 0) + 1
  tracker.calls.set(key, count)
  if (count >= SAME_CALL_REPEATS) flag(tracker, 'same-call')
  if (!READ_TOOLS.has(toolName)) {
    tracker.acted = true
    tracker.readStreak = 0
    return
  }
  if (!tracker.acted) return
  tracker.readStreak++
  if (tracker.readStreak >= READ_STREAK) flag(tracker, 'read-only')
}

// 模型这一步说的话
export function noteText(tracker: SpinTracker, text: string): void {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length < MIN_TEXT_CHARS) return
  const count = (tracker.texts.get(normalized) ?? 0) + 1
  tracker.texts.set(normalized, count)
  if (count >= SAME_TEXT_REPEATS) flag(tracker, 'same-text')
}

// 这一步之后要给模型的提醒，取走就清掉；同一种在下次成功编辑前只提醒一次
export function takeSpinReminders(tracker: SpinTracker): string[] {
  const reminders = tracker.pending.map((kind) => REMINDERS[kind])
  tracker.pending = []
  return reminders
}
