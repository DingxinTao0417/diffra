import type { OrderLifecycle } from '../orders/order-lifecycle.ts'
import type { PaymentStore } from '../payments/payment-store.ts'
import type { Clock } from '../shared/clock.ts'
import { conflict } from '../shared/errors.ts'
import type { EventBus } from '../shared/event-bus.ts'
import type { IdGenerator } from '../shared/id-generator.ts'
import type { Shipment, ShipmentStore } from './shipment-store.ts'

export interface ShippingDeps {
  lifecycle: OrderLifecycle
  payments: PaymentStore
  shipments: ShipmentStore
  bus: EventBus
  clock: Clock
  ids: IdGenerator
}

export class ShippingService {
  private readonly deps: ShippingDeps

  constructor(deps: ShippingDeps) {
    this.deps = deps
  }

  dispatch(orderId: string, carrier: string): Shipment {
    const { lifecycle, payments, shipments, bus, clock, ids } = this.deps
    // 钱已经全退了的订单不能再发货
    if (payments.find(orderId)?.status === 'refunded') throw conflict('已全额退款的订单不能发货')
    lifecycle.transition(orderId, 'shipped', 'shipping')
    const shipment: Shipment = { orderId, carrier, trackingNo: `${carrier}-${ids.next('trk')}`, dispatchedAt: clock.now(), deliveredAt: null }
    shipments.save(shipment)
    bus.emit('shipment.dispatched', { orderId, trackingNo: shipment.trackingNo })
    return shipment
  }

  confirmDelivery(orderId: string): Shipment {
    const { lifecycle, shipments, bus, clock } = this.deps
    const shipment = shipments.find(orderId)
    if (!shipment) throw conflict('订单还没发货')
    lifecycle.transition(orderId, 'delivered', 'shipping')
    shipment.deliveredAt = clock.now()
    shipments.save(shipment)
    bus.emit('shipment.delivered', { orderId })
    return shipment
  }
}
