import type { StockPort } from '../orders/order.ts'
import type { OrderLifecycle } from '../orders/order-lifecycle.ts'
import type { OrderStore } from '../orders/order-store.ts'
import type { Clock } from '../shared/clock.ts'
import type { EventBus } from '../shared/event-bus.ts'

const PAYMENT_WINDOW_MS = 30 * 60 * 1000

export interface ExpireDeps {
  orders: OrderStore
  lifecycle: OrderLifecycle
  stock: StockPort
  bus: EventBus
  clock: Clock
}

// 定时任务：下单超过 30 分钟还没付款的订单自动取消，库存放回。返回这次取消了几单
export function expireUnpaidOrders({ orders, lifecycle, stock, bus, clock }: ExpireDeps): number {
  const now = clock.now()
  let expired = 0
  for (const order of orders.byStatus('pending')) {
    if (now - order.createdAt < PAYMENT_WINDOW_MS) continue
    lifecycle.transition(order.id, 'cancelled', 'system')
    stock.release(order.id, order.lines)
    bus.emit('order.cancelled', { orderId: order.id, reason: 'expired' })
    expired += 1
  }
  return expired
}
