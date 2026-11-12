import type { Clock } from '../shared/clock.ts'
import type { EventBus } from '../shared/event-bus.ts'

export interface LowStockAlert {
  sku: string
  available: number
  at: number
}

// 给补货看板用：记下库存偏低的商品，同一个商品只留最新一条
export class LowStockMonitor {
  private readonly alerts = new Map<string, LowStockAlert>()

  constructor(bus: EventBus, clock: Clock) {
    bus.on('stock.low', ({ sku, available }) => {
      this.alerts.set(sku, { sku, available, at: clock.now() })
    })
  }

  list(): LowStockAlert[] {
    return [...this.alerts.values()]
  }
}
