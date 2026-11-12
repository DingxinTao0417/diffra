import type { OrderLifecycle } from '../orders/order-lifecycle.ts'
import type { OrderStore } from '../orders/order-store.ts'
import type { Clock } from '../shared/clock.ts'
import { AppError, conflict } from '../shared/errors.ts'
import type { EventBus } from '../shared/event-bus.ts'
import type { PaymentGateway } from './payment-gateway.ts'
import type { Payment, PaymentStore } from './payment-store.ts'

export interface PaymentDeps {
  orders: OrderStore
  payments: PaymentStore
  gateway: PaymentGateway
  lifecycle: OrderLifecycle
  bus: EventBus
  clock: Clock
}

export class PaymentService {
  private readonly deps: PaymentDeps

  constructor(deps: PaymentDeps) {
    this.deps = deps
  }

  // 按订单应付金额扣款，扣成功订单才算已付款
  capture(orderId: string, token: string): Payment {
    const { orders, payments, gateway, lifecycle, bus, clock } = this.deps
    const order = orders.require(orderId)
    if (order.status !== 'pending') throw conflict('订单不是待付款状态')
    const result = gateway.charge(token, order.totalCents)
    if (!result.ok) throw new AppError(402, 'payment_declined', result.reason)
    const payment: Payment = { orderId, amountCents: order.totalCents, refundedCents: 0, status: 'captured', gatewayRef: result.ref, capturedAt: clock.now() }
    payments.save(payment)
    lifecycle.transition(orderId, 'paid')
    bus.emit('payment.captured', { orderId, amountCents: payment.amountCents })
    return payment
  }
}
