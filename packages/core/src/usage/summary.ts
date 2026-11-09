import type { UsageRecord, UsageSummary, UsageTotals } from '../protocol.js'

const TOP_TASKS = 10
const DAY_MS = 86_400_000

export function emptyTotals(): UsageTotals {
  return { calls: 0, unknownCalls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }
}

function addTo(totals: UsageTotals, record: UsageRecord): void {
  totals.calls += 1
  if (record.input === null && record.output === null) totals.unknownCalls += 1
  totals.input += record.input ?? 0
  totals.cacheRead += record.cacheRead ?? 0
  totals.cacheWrite += record.cacheWrite ?? 0
  totals.output += record.output ?? 0
  totals.reasoning += record.reasoning ?? 0
}

const byTotal = (a: UsageTotals, b: UsageTotals) => b.input + b.output - (a.input + a.output)

// Windows 上路径不分大小写，同一个项目只算一组
const pathKey = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path)

// 边读边汇总：每条记录只加到几个计数器上，内存只和天数、模型数、任务数有关
export class UsageAggregator {
  private readonly totals = emptyTotals()
  private readonly days = new Map<string, UsageTotals & { date: string }>()
  private readonly models = new Map<string, UsageSummary['models'][number]>()
  private readonly projects = new Map<string, UsageSummary['projects'][number]>()
  private readonly tasks = new Map<string, UsageSummary['tasks'][number]>()
  private readonly dayOf: (date: Date) => string

  constructor(from: Date, to: Date, timeZone: string) {
    this.dayOf = dayFormatter(timeZone)
    for (const date of daysBetween(this.dayOf(from), this.dayOf(new Date(to.getTime() - 1)))) {
      this.days.set(date, { date, ...emptyTotals() })
    }
  }

  add(record: UsageRecord): void {
    addTo(this.totals, record)
    const day = this.days.get(this.dayOf(new Date(record.at)))
    if (day) addTo(day, record)

    const modelKey = `${record.providerId ?? ''}\u0000${record.modelId}`
    let model = this.models.get(modelKey)
    if (!model) {
      model = { providerId: record.providerId, providerName: record.providerName, modelId: record.modelId, ...emptyTotals() }
      this.models.set(modelKey, model)
    }
    // 供应商改过名的话用最近一次的名字；记录按时间顺序读
    model.providerName = record.providerName ?? model.providerName
    addTo(model, record)

    let project = this.projects.get(pathKey(record.cwd))
    if (!project) {
      project = { cwd: record.cwd, ...emptyTotals() }
      this.projects.set(pathKey(record.cwd), project)
    }
    addTo(project, record)

    let task = this.tasks.get(record.sessionId)
    if (!task) {
      task = { sessionId: record.sessionId, cwd: record.cwd, ...emptyTotals() }
      this.tasks.set(record.sessionId, task)
    }
    addTo(task, record)
  }

  result(skippedLines: number): UsageSummary {
    return {
      totals: this.totals,
      days: [...this.days.values()],
      models: [...this.models.values()].sort(byTotal),
      projects: [...this.projects.values()].sort(byTotal),
      tasks: [...this.tasks.values()].sort(byTotal).slice(0, TOP_TASKS),
      skippedLines,
    }
  }
}

// 时刻 → 这个时区的日期 YYYY-MM-DD
function dayFormatter(timeZone: string): (date: Date) => string {
  const format = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  return (date) => {
    const parts = Object.fromEntries(format.formatToParts(date).map((part) => [part.type, part.value]))
    return `${parts.year}-${parts.month}-${parts.day}`
  }
}

// 两个日期之间（含两端）的每一天；只做日历上的加一天，不涉及时区
function daysBetween(first: string, last: string): string[] {
  const days: string[] = []
  const [year = 0, month = 1, day = 1] = first.split('-').map(Number)
  for (let time = Date.UTC(year, month - 1, day); ; time += DAY_MS) {
    const date = new Date(time).toISOString().slice(0, 10)
    if (date > last) break
    days.push(date)
  }
  return days
}

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}
