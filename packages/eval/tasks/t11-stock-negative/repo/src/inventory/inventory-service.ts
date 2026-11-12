import type { Clock } from '../shared/clock.ts'
import { conflict } from '../shared/errors.ts'
import type { EventBus } from '../shared/event-bus.ts'
import type { MovementKind, StockMovements } from './stock-movements.ts'
import type { StockLevel, StockStore } from './stock-store.ts'

export interface StockLine {
  sku: string
  quantity: number
}

export interface InventoryDeps {
  stock: StockStore
  movements: StockMovements
  bus: EventBus
  clock: Clock
  // 可卖数量降到这个数及以下就发 stock.low
  lowStockThreshold: number
}

export class InventoryService {
  private readonly deps: InventoryDeps

  constructor(deps: InventoryDeps) {
    this.deps = deps
  }

  available(sku: string): number {
    const level = this.deps.stock.require(sku)
    return level.onHand - level.reserved
  }

  // 下单占库存：有一行不够就整单不占
  reserve(orderId: string, lines: StockLine[]): void {
    for (const line of lines) {
      if (this.available(line.sku) < line.quantity) throw conflict(`库存不足：${line.sku}`)
    }
    for (const line of lines) this.move('reserve', orderId, line, (level) => (level.reserved += line.quantity))
  }

  // 订单不发货了：把占用放回去
  release(orderId: string, lines: StockLine[]): void {
    for (const line of lines) this.move('release', orderId, line, (level) => (level.reserved -= line.quantity))
  }

  // 发货出库：实物减少，占用结清
  commit(orderId: string, lines: StockLine[]): void {
    for (const line of lines) {
      this.move('commit', orderId, line, (level) => {
        level.onHand -= line.quantity
        level.reserved -= line.quantity
      })
    }
  }

  // 退货入库
  restock(orderId: string, lines: StockLine[]): void {
    for (const line of lines) this.move('restock', orderId, line, (level) => (level.onHand += line.quantity))
  }

  private move(kind: MovementKind, orderId: string, line: StockLine, apply: (level: StockLevel) => void): void {
    const { stock, movements, bus, clock, lowStockThreshold } = this.deps
    const level = stock.require(line.sku)
    apply(level)
    movements.record({ kind, sku: line.sku, quantity: line.quantity, orderId, at: clock.now() })
    const available = level.onHand - level.reserved
    if (available <= lowStockThreshold) bus.emit('stock.low', { sku: line.sku, available })
  }
}
