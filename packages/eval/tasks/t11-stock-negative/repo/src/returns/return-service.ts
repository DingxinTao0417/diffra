import type { Order } from '../orders/order.ts'
import type { OrderLifecycle } from '../orders/order-lifecycle.ts'
import type { ShipmentStore } from '../shipping/shipment-store.ts'
import type { Clock } from '../shared/clock.ts'
import { conflict } from '../shared/errors.ts'
import type { EventBus } from '../shared/event-bus.ts'

const RETURN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export interface ReturnDeps {
  lifecycle: OrderLifecycle
  shipments: ShipmentStore
  bus: EventBus
  clock: Clock
}

export class ReturnService {
  private readonly deps: ReturnDeps

  constructor(deps: ReturnDeps) {
    this.deps = deps
  }

  // 仓库收到退回来的货：签收后 7 天内可以退，整单退。这里只管货，钱由客服另外退
  receive(orderId: string): Order {
    const { lifecycle, shipments, bus, clock } = this.deps
    const shipment = shipments.find(orderId)
    if (!shipment || shipment.deliveredAt === null) throw conflict('订单还没签收，不能退货')
    if (clock.now() - shipment.deliveredAt > RETURN_WINDOW_MS) throw conflict('已经超过 7 天退货期')
    const order = lifecycle.transition(orderId, 'returned')
    bus.emit('return.received', { orderId })
    return order
  }
}
