import type { AuditLog, AuditSource } from '../audit/audit-log.ts'
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

// 改订单状态只能走这里：更新 updatedAt，状态真的变了就记一条审计。别处不要直接写 order.status
export class OrderLifecycle {
  private readonly orders: OrderStore
  private readonly clock: Clock
  private readonly audit: AuditLog

  constructor(orders: OrderStore, clock: Clock, audit: AuditLog) {
    this.orders = orders
    this.clock = clock
    this.audit = audit
  }

  // 正常流转：先校验这一步允不允许
  transition(orderId: string, to: OrderStatus, source: AuditSource): Order {
    const order = this.orders.require(orderId)
    if (!ALLOWED[order.status].includes(to)) throw conflict(`订单 ${order.id} 不能从 ${order.status} 变成 ${to}`)
    return this.apply(order, to, source)
  }

  // 客服手动改：不管流转规则
  force(orderId: string, to: OrderStatus, source: AuditSource): Order {
    return this.apply(this.orders.require(orderId), to, source)
  }

  private apply(order: Order, to: OrderStatus, source: AuditSource): Order {
    const from = order.status
    const at = this.clock.now()
    order.status = to
    order.updatedAt = at
    this.orders.save(order)
    if (from !== to) this.audit.record({ orderId: order.id, from, to, at, source })
    return order
  }
}
