import { DEFAULT_USAGE, type UsageSettings } from '../../../shared/settings'
import { errorMessage } from '@/lib/errors'
import { showToast, store } from './store'

// 用量预算（v2 · M11）：每月预算到 80%、100% 时各提醒一次（记在设置里，换月重来）；只提醒，不拦着继续用。
// 启动时和每一轮结束时查，一分钟内最多查一次
const CHECK_INTERVAL_MS = 60_000
let lastCheck = 0

export const currencySymbol = (usage: Pick<UsageSettings, 'currency'>) => (usage.currency === 'USD' ? '$' : '¥')

// 显示用：小于 1 留 4 位小数，其余 2 位（金额本身是 core 按整数算好的字符串）
export function formatMoney(usage: Pick<UsageSettings, 'currency'>, value: string): string {
  const amount = Number(value)
  return `${currencySymbol(usage)}${amount.toFixed(amount !== 0 && amount < 1 ? 4 : 2)}`
}

export function monthRange(now: Date): { from: Date; to: Date; month: string } {
  const from = new Date(now.getFullYear(), now.getMonth(), 1)
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  return { from, to, month: `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}` }
}

// 预算用到的比例（0–1+）；没设预算、没填单价时是 null
export function budgetRatio(usage: UsageSettings, cost: string | undefined): number | null {
  if (!usage.monthlyBudget || cost === undefined) return null
  const budget = Number(usage.monthlyBudget)
  return budget > 0 ? Number(cost) / budget : null
}

export async function checkUsageBudget(force = false): Promise<void> {
  const usage = store.get().settings?.usage ?? DEFAULT_USAGE
  if (!usage.monthlyBudget || usage.prices.length === 0) return
  if (!force && Date.now() - lastCheck < CHECK_INTERVAL_MS) return
  lastCheck = Date.now()
  const { from, to, month } = monthRange(new Date())
  try {
    const summary = await window.diffra.usageSummary({ from: from.toISOString(), to: to.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
    const ratio = budgetRatio(usage, summary.totals.cost)
    if (ratio === null || ratio < 0.8) return
    const level = ratio >= 1 ? 100 : 80
    const notice = usage.budgetNotice
    if (notice && notice.month === month && notice.level >= level) return
    showToast(`本月用量费用 ${formatMoney(usage, summary.totals.cost!)}，${level === 100 ? '已经超过' : '到了'}每月预算 ${formatMoney(usage, usage.monthlyBudget)} 的 ${level === 100 ? '100%' : '80%'}`)
    const settings = await window.diffra.savePreferences({ usage: { ...usage, budgetNotice: { month, level } } })
    store.set((state) => ({ ...state, settings }))
  } catch (error) {
    console.error('[usage] 检查预算失败', errorMessage(error))
  }
}
