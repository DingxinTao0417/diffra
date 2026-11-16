import { createWriteStream } from 'node:fs'
import { once } from 'node:events'
import type { UsagePrice } from '../protocol.js'
import type { UsageLog } from './log.js'
import { formatCost, PriceBook } from './pricing.js'

// 把 [from, to) 之间的记录导出成 CSV（v2 · M11）：一行一次调用，边读边写；有单价时多一列费用。
// 开头加 BOM，Excel 打开不乱码；时刻是 UTC，另给一列按用户时区的日期
const BOM = String.fromCharCode(0xfeff)
const HEADER = ['时刻(UTC)', '日期', '任务', '项目', '供应商', '模型', '角色', '输入', '缓存读', '缓存写', '输出', '推理', '费用']

const cell = (value: string | number | null) => {
  const text = value === null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export async function exportUsageCsv(log: UsageLog, query: { from: Date; to: Date; timeZone: string; prices: readonly UsagePrice[] }, path: string): Promise<{ rows: number; skippedLines: number }> {
  const prices = new PriceBook(query.prices)
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: query.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const out = createWriteStream(path, 'utf8')
  const write = async (line: string) => {
    if (!out.write(`${line}\r\n`)) await once(out, 'drain')
  }
  let rows = 0
  try {
    await write(`${BOM}${HEADER.join(',')}`)
    const { skippedLines } = await log.scan(query.from, query.to, async (record) => {
      const cost = prices.empty ? null : prices.cost(record)
      await write(
        [record.at, day.format(new Date(record.at)), record.sessionId, record.cwd, record.providerName ?? record.providerId ?? '', record.modelId, record.role, record.input, record.cacheRead, record.cacheWrite, record.output, record.reasoning, cost === null ? null : formatCost(cost)]
          .map(cell)
          .join(','),
      )
      rows++
    })
    out.end()
    await once(out, 'finish')
    return { rows, skippedLines }
  } catch (error) {
    out.destroy()
    throw error
  }
}
