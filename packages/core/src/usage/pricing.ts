import type { UsagePrice, UsageRecord } from '../protocol.js'

// 用量的费用（v2 · M11）：单价由用户按模型填（每百万 token 多少钱，币种一个，界面上选），不内置——各家价格常变，内置的会错。
// 金额按整数算：单价换成「每百万 token 多少微元」（×10^6），乘 token 数累加，最后除一次，不用浮点
export const PRICE_PATTERN = /^\d{1,7}(\.\d{1,6})?$/
const MICRO = 1_000_000n

export function priceMicros(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.')
  return BigInt(whole) * MICRO + BigInt(fraction.padEnd(6, '0').slice(0, 6) || '0')
}

interface PriceMicros {
  input: bigint
  cachedInput: bigint
  cacheWrite: bigint
  output: bigint
}

// 先按供应商加模型找，找不到再按模型找（供应商没记下的旧记录）
export class PriceBook {
  private readonly byKey = new Map<string, PriceMicros>()

  constructor(prices: readonly UsagePrice[]) {
    for (const price of prices) {
      const input = priceMicros(price.input)
      const entry = {
        input,
        cachedInput: price.cachedInput ? priceMicros(price.cachedInput) : input,
        cacheWrite: price.cacheWrite ? priceMicros(price.cacheWrite) : input,
        output: priceMicros(price.output),
      }
      this.byKey.set(`${price.providerId ?? ''}\u0000${price.modelId}`, entry)
      if (!this.byKey.has(`*\u0000${price.modelId}`)) this.byKey.set(`*\u0000${price.modelId}`, entry)
    }
  }

  get empty(): boolean {
    return this.byKey.size === 0
  }

  // 一次调用的费用，单位是「微元 × 百万」（还没除以百万 token）；没有单价或供应商没返回用量时是 null
  cost(record: UsageRecord): bigint | null {
    const price = this.byKey.get(`${record.providerId ?? ''}\u0000${record.modelId}`) ?? this.byKey.get(`*\u0000${record.modelId}`)
    if (!price || (record.input === null && record.output === null)) return null
    const input = BigInt(record.input ?? 0)
    const cacheRead = BigInt(record.cacheRead ?? 0)
    const cacheWrite = BigInt(record.cacheWrite ?? 0)
    // 输入里含缓存命中和写缓存的部分，各按各的价；剩下的按普通输入价
    const plain = input - cacheRead - cacheWrite > 0n ? input - cacheRead - cacheWrite : 0n
    return plain * price.input + cacheRead * price.cachedInput + cacheWrite * price.cacheWrite + BigInt(record.output ?? 0) * price.output
  }
}

// 累加出来的「微元 × 百万」→ 金额字符串（保留 6 位小数，四舍五入）
export function formatCost(scaled: bigint): string {
  const micros = (scaled + MICRO / 2n) / MICRO
  const whole = micros / MICRO
  const fraction = (micros % MICRO).toString().padStart(6, '0')
  return `${whole}.${fraction}`
}
