import type { ProductCatalog } from '../catalog/product-catalog.ts'
import type { Clock } from '../shared/clock.ts'
import { invalid } from '../shared/errors.ts'
import type { EventBus } from '../shared/event-bus.ts'
import type { IdGenerator } from '../shared/id-generator.ts'
import type { Order, StockPort } from './order.ts'
import type { OrderStore } from './order-store.ts'
import { computeTotals } from './order-totals.ts'

export interface OrderItemInput {
  sku: string
  quantity: number
}

export interface PlaceOrderDeps {
  orders: OrderStore
  catalog: ProductCatalog
  stock: StockPort
  bus: EventBus
  clock: Clock
  ids: IdGenerator
}

const MAX_QUANTITY_PER_LINE = 99

export class PlaceOrder {
  private readonly deps: PlaceOrderDeps

  constructor(deps: PlaceOrderDeps) {
    this.deps = deps
  }

  // 价格以下单时的商品价格为准；库存占不上就整单失败，不留订单
  execute(customerId: string, items: OrderItemInput[]): Order {
    const { orders, catalog, stock, bus, clock, ids } = this.deps
    if (items.length === 0) throw invalid('订单里没有商品')
    if (new Set(items.map((item) => item.sku)).size !== items.length) throw invalid('同一个商品请合并成一行')
    const lines = items.map((item) => {
      if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QUANTITY_PER_LINE) throw invalid(`数量不对：${item.sku}`)
      return { sku: item.sku, quantity: item.quantity, unitPriceCents: catalog.require(item.sku).priceCents }
    })
    const id = ids.next('ord')
    stock.reserve(id, lines)
    const now = clock.now()
    const order: Order = { id, customerId, lines, ...computeTotals(lines), status: 'pending', createdAt: now, updatedAt: now }
    orders.save(order)
    bus.emit('order.placed', { orderId: id })
    return order
  }
}
