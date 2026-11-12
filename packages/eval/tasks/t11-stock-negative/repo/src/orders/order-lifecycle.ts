import type { Clock } from '../shared/clock.ts'
import { conflict } from '../shared/errors.ts'
import type { Order, OrderStatus } from './order.ts'
import type { OrderStore } from './order-store.ts'

const ALLOWED: Record<OrderStatus, OrderStatus[]> = {
  pending: ['paid', 'cancelled'],
  paid: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: ['returned'],
  returned: [],
  cancelled: [],
}

// 改订单状态走这里：校验这一步流转允不允许，顺便更新 updatedAt
export class OrderLifecycle {
  private readonly orders: OrderStore
  private readonly clock: Clock

  constructor(orders: OrderStore, clock: Clock) {
    this.orders = orders
    this.clock = clock
  }

  transition(orderId: string, to: OrderStatus): Order {
    const order = this.orders.require(orderId)
    if (!ALLOWED[order.status].includes(to)) throw conflict(`订单 ${order.id} 不能从 ${order.status} 变成 ${to}`)
    order.status = to
    order.updatedAt = this.clock.now()
    this.orders.save(order)
    return order
  }
}
