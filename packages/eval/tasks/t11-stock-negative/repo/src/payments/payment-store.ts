export type PaymentStatus = 'captured' | 'partially_refunded' | 'refunded'

// 一个订单最多一笔付款，按订单号存
export interface Payment {
  orderId: string
  amountCents: number
  refundedCents: number
  status: PaymentStatus
  gatewayRef: string
  capturedAt: number
}

export class PaymentStore {
  private readonly payments = new Map<string, Payment>()

  save(payment: Payment): void {
    this.payments.set(payment.orderId, payment)
  }

  find(orderId: string): Payment | null {
    return this.payments.get(orderId) ?? null
  }
}
