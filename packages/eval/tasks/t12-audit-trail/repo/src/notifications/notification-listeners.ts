import type { Order } from '../orders/order.ts'
import type { OrderStore } from '../orders/order-store.ts'
import type { Clock } from '../shared/clock.ts'
import type { EventBus } from '../shared/event-bus.ts'
import type { Outbox } from './outbox.ts'
import { templates, type Template } from './templates.ts'

export function registerNotificationListeners(bus: EventBus, orders: OrderStore, outbox: Outbox, clock: Clock): void {
  const notify = (orderId: string, build: (order: Order) => Template) => {
    const order = orders.require(orderId)
    outbox.push({ customerId: order.customerId, ...build(order), at: clock.now() })
  }

  bus.on('order.placed', ({ orderId }) => notify(orderId, (order) => templates.orderPlaced(order)))
  bus.on('payment.captured', ({ orderId, amountCents }) => notify(orderId, (order) => templates.paymentCaptured(order, amountCents)))
  bus.on('order.cancelled', ({ orderId, reason }) => notify(orderId, (order) => templates.orderCancelled(order, reason)))
  bus.on('payment.refunded', ({ orderId, amountCents, fullyRefunded }) => notify(orderId, (order) => templates.refunded(order, amountCents, fullyRefunded)))
  bus.on('shipment.dispatched', ({ orderId, trackingNo }) => notify(orderId, (order) => templates.dispatched(order, trackingNo)))
  bus.on('shipment.delivered', ({ orderId }) => notify(orderId, (order) => templates.delivered(order)))
}
