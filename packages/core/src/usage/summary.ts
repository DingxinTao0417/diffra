import type { UsagePrice, UsageRecord, UsageSummary, UsageTotals } from '../protocol.js'
import { formatCost, PriceBook } from './pricing.js'

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

// 费用按整数累加（见 pricing.ts），出结果时才换成字符串
const costs = new WeakMap<UsageTotals, bigint>()

function addCost(totals: UsageTotals, cost: bigint | null): void {
  if (cost === null) {
    totals.unpricedCalls = (totals.unpricedCalls ?? 0) + 1
    return
  }
  costs.set(totals, (costs.get(totals) ?? 0n) + cost)
}

function withCost<T extends UsageTotals>(totals: T, priced: boolean): T {
  if (!priced) return totals
  return { ...totals, cost: formatCost(costs.get(totals) ?? 0n), unpricedCalls: totals.unpricedCalls ?? 0 }
}

// 边读边汇总：每条记录只加到几个计数器上，内存只和天数、模型数、任务数有关
export class UsageAggregator {
  private readonly totals = emptyTotals()
  private readonly prices: PriceBook
  private readonly workspace: string | null
  // 显示用的无项目根目录（原样大小写）
  private readonly workspaceRoot: string | null
  private readonly noProjectTasks = new Set<string>()
  private readonly days = new Map<string, UsageTotals & { date: string }>()
  private readonly models = new Map<string, UsageSummary['models'][number]>()
  private readonly projects = new Map<string, UsageSummary['projects'][number]>()
  private readonly tasks = new Map<string, UsageSummary['tasks'][number]>()
  private readonly dayOf: (date: Date) => string

  constructor(from: Date, to: Date, timeZone: string, options: { prices?: readonly UsagePrice[]; workspaceRoot?: string | null } = {}) {
    this.prices = new PriceBook(options.prices ?? [])
    this.workspaceRoot = options.workspaceRoot ? options.workspaceRoot.replace(/[\\/]+$/, '') : null
    this.workspace = this.workspaceRoot ? pathKey(this.workspaceRoot) : null
    this.dayOf = dayFormatter(timeZone)
    for (const date of daysBetween(this.dayOf(from), this.dayOf(new Date(to.getTime() - 1)))) {
      this.days.set(date, { date, ...emptyTotals() })
    }
  }

  add(record: UsageRecord): void {
    const cost = this.prices.empty ? null : this.prices.cost(record)
    const count = (totals: UsageTotals) => {
      addTo(totals, record)
      if (!this.prices.empty) addCost(totals, cost)
    }
    count(this.totals)
    const day = this.days.get(this.dayOf(new Date(record.at)))
    if (day) count(day)

    const modelKey = `${record.providerId ?? ''}\u0000${record.modelId}`
    let model = this.models.get(modelKey)
    if (!model) {
      model = { providerId: record.providerId, providerName: record.providerName, modelId: record.modelId, ...emptyTotals() }
      this.models.set(modelKey, model)
    }
    // 供应商改过名的话用最近一次的名字；记录按时间顺序读
    model.providerName = record.providerName ?? model.providerName
    count(model)

    // 无项目任务每个一个文件夹，都在同一个根目录下：合成一行（v2）
    const key = pathKey(record.cwd)
    const noProject = this.workspace !== null && (key === this.workspace || key.startsWith(`${this.workspace}/`) || key.startsWith(`${this.workspace}\\`))
    const projectKey = noProject ? '\u0000no-project' : key
    let project = this.projects.get(projectKey)
    if (!project) {
      project = noProject ? { cwd: this.workspaceRoot!, noProject: true, tasks: 0, ...emptyTotals() } : { cwd: record.cwd, ...emptyTotals() }
      this.projects.set(projectKey, project)
    }
    if (noProject && !this.noProjectTasks.has(record.sessionId)) {
      this.noProjectTasks.add(record.sessionId)
      project.tasks = (project.tasks ?? 0) + 1
    }
    count(project)

    let task = this.tasks.get(record.sessionId)
    if (!task) {
      task = { sessionId: record.sessionId, cwd: record.cwd, ...emptyTotals() }
      this.tasks.set(record.sessionId, task)
    }
    count(task)
  }

  result(skippedLines: number): UsageSummary {
    const priced = !this.prices.empty
    return {
      totals: withCost(this.totals, priced),
      days: [...this.days.values()].map((day) => withCost(day, priced)),
      models: [...this.models.values()].sort(byTotal).map((model) => withCost(model, priced)),
      projects: [...this.projects.values()].sort(byTotal).map((project) => withCost(project, priced)),
      tasks: [...this.tasks.values()].sort(byTotal).slice(0, TOP_TASKS).map((task) => withCost(task, priced)),
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
