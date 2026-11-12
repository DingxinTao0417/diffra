import type { EventBus } from '../shared/event-bus.ts'
import type { CancelReason } from '../shared/events.ts'
import type { Order, StockPort } from './order.ts'
import type { OrderLifecycle } from './order-lifecycle.ts'

export interface CancelOrderDeps {
  lifecycle: OrderLifecycle
  stock: StockPort
  bus: EventBus
}

export class CancelOrder {
  private readonly deps: CancelOrderDeps

  constructor(deps: CancelOrderDeps) {
    this.deps = deps
  }

  // 发货前都能取消。付过的钱不在这里退，由客服在后台退款
  execute(orderId: string, reason: CancelReason): Order {
    const { lifecycle, stock, bus } = this.deps
    const order = lifecycle.transition(orderId, 'cancelled')
    stock.release(order.id, order.lines)
    bus.emit('order.cancelled', { orderId: order.id, reason })
    return order
  }
}
