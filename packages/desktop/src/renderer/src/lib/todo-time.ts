import type { Todo } from '../../../shared/todos'

// 待办的时间都按本机时区算：分组、日历、快捷时间。存的是 UTC 时刻，这里只管显示和换算

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes())
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

// 本地日期的键（2026-11-09），日历按它归到哪一天
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function atTime(day: Date, hours: number, minutes = 0): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes)
}

// 周一算一周的第一天
export function startOfWeek(date: Date): Date {
  const day = startOfDay(date)
  return addDays(day, -((day.getDay() + 6) % 7))
}

export type TodoGroup = 'overdue' | 'today' | 'tomorrow' | 'week' | 'later' | 'unscheduled' | 'done'

export const GROUP_LABELS: Record<TodoGroup, string> = {
  overdue: '逾期',
  today: '今天',
  tomorrow: '明天',
  week: '本周',
  later: '以后',
  unscheduled: '未定时间',
  done: '已完成',
}

// 到了时间还没勾掉；定时器已经处理过的（有结果）也算，不用等界面的时钟刷新
export function isDue(todo: Todo, now: Date): boolean {
  return !todo.done && todo.schedule != null && (todo.schedule.result !== null || new Date(todo.schedule.at).getTime() <= now.getTime())
}

export function groupOf(todo: Todo, now: Date): TodoGroup {
  if (todo.done) return 'done'
  if (!todo.schedule) return 'unscheduled'
  const at = new Date(todo.schedule.at)
  if (isDue(todo, now)) return 'overdue'
  const today = startOfDay(now)
  if (sameDay(at, today)) return 'today'
  if (sameDay(at, addDays(today, 1))) return 'tomorrow'
  if (at < addDays(startOfWeek(today), 7)) return 'week'
  return 'later'
}

const pad = (value: number) => String(value).padStart(2, '0')
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

export function formatClock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// 到期时间的说法：今天 15:00、明天 9:00、周三 9:00、11月20日 9:00、2027年1月3日 9:00
export function formatDue(iso: string, now: Date): string {
  const { day, clock } = dueParts(iso, now)
  return `${day} ${clock}`
}

// 拆成日子和钟点两部分，列表左边的时间列分两行显示
export function dueParts(iso: string, now: Date): { day: string; clock: string } {
  const at = new Date(iso)
  const today = startOfDay(now)
  const clock = formatClock(at)
  if (sameDay(at, today)) return { day: '今天', clock }
  if (sameDay(at, addDays(today, 1))) return { day: '明天', clock }
  if (sameDay(at, addDays(today, -1))) return { day: '昨天', clock }
  if (at >= startOfWeek(today) && at < addDays(startOfWeek(today), 7)) return { day: `周${WEEKDAYS[at.getDay()]}`, clock }
  if (at.getFullYear() === now.getFullYear()) return { day: `${at.getMonth() + 1}月${at.getDate()}日`, clock }
  return { day: `${at.getFullYear()}年${at.getMonth() + 1}月${at.getDate()}日`, clock }
}

// 定时的快捷选项；已经过了的（比如晚上 9 点后的「今晚 20:00」）不列
export function timePresets(now: Date): Array<{ label: string; at: Date }> {
  const today = startOfDay(now)
  const nextMonday = addDays(startOfWeek(today), 7)
  return [
    { label: '1 小时后', at: new Date(Math.ceil((now.getTime() + 60 * 60_000) / 60_000) * 60_000) },
    { label: '今晚 20:00', at: atTime(today, 20) },
    { label: '明早 9:00', at: atTime(addDays(today, 1), 9) },
    { label: '下周一 9:00', at: atTime(nextMonday, 9) },
  ].filter((preset) => preset.at.getTime() > now.getTime())
}

// 一个月的日历格子：从这个月 1 号所在那周的周一开始，固定 6 周 42 天
export function monthGrid(month: Date): Date[] {
  const first = startOfWeek(new Date(month.getFullYear(), month.getMonth(), 1))
  return Array.from({ length: 42 }, (_, index) => addDays(first, index))
}

// <input type="date"> 和 <input type="time"> 的值
export function dateInputValue(date: Date): string {
  return dayKey(date)
}

export function fromInputs(date: string, time: string): Date | null {
  const [year, month, day] = date.split('-').map(Number)
  const [hours, minutes] = time.split(':').map(Number)
  if (!year || !month || !day || hours === undefined || minutes === undefined || Number.isNaN(hours) || Number.isNaN(minutes)) return null
  return new Date(year, month - 1, day, hours, minutes)
}
