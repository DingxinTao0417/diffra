import type { OrderStore } from '../orders/order-store.ts'
import type { EventBus } from '../shared/event-bus.ts'
import type { InventoryService } from './inventory-service.ts'

export function registerInventoryListeners(bus: EventBus, inventory: InventoryService, orders: OrderStore): void {
  // 钱全退了、货还没发的订单不会再发货，占用的库存放回去；已经发出去的走退货入库
  bus.on('payment.refunded', ({ orderId, fullyRefunded }) => {
    if (!fullyRefunded) return
    const order = orders.require(orderId)
    if (order.status === 'shipped' || order.status === 'delivered' || order.status === 'returned') return
    inventory.release(order.id, order.lines)
  })

  bus.on('shipment.dispatched', ({ orderId }) => {
    const order = orders.require(orderId)
    inventory.commit(order.id, order.lines)
  })

  bus.on('return.received', ({ orderId }) => {
    const order = orders.require(orderId)
    inventory.restock(order.id, order.lines)
  })
}
