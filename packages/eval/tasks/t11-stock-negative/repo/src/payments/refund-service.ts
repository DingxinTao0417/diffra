import { conflict, invalid } from '../shared/errors.ts'
import type { EventBus } from '../shared/event-bus.ts'
import type { PaymentGateway } from './payment-gateway.ts'
import type { Payment, PaymentStore } from './payment-store.ts'

export interface RefundDeps {
  payments: PaymentStore
  gateway: PaymentGateway
  bus: EventBus
}

export class RefundService {
  private readonly deps: RefundDeps

  constructor(deps: RefundDeps) {
    this.deps = deps
  }

  // 客服退款：可以分几次退，amountCents 不传就把剩下的全退掉。订单在什么状态都能退，只看这笔付款还剩多少没退
  refund(orderId: string, amountCents?: number): Payment {
    const { payments, gateway, bus } = this.deps
    const payment = payments.find(orderId)
    if (!payment) throw conflict('订单还没付款')
    const remaining = payment.amountCents - payment.refundedCents
    if (remaining === 0) throw conflict('这笔付款已经全部退完')
    const amount = amountCents ?? remaining
    if (!Number.isInteger(amount) || amount <= 0 || amount > remaining) throw invalid('退款金额不对')
    gateway.refund(payment.gatewayRef, amount)
    payment.refundedCents += amount
    payment.status = payment.refundedCents === payment.amountCents ? 'refunded' : 'partially_refunded'
    payments.save(payment)
    bus.emit('payment.refunded', { orderId, amountCents: amount, fullyRefunded: payment.status === 'refunded' })
    return payment
  }
}
