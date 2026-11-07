import type { Logger } from './logger.ts'

export interface Order {
  id: string
  userId: string
  amountCents: number
}

export interface PaymentGateway {
  charge(request: { orderId: string; amountCents: number }): Promise<{ transactionId: string }>
}

export async function chargeOrder(gateway: PaymentGateway, logger: Logger, order: Order): Promise<string> {
  const result = await gateway.charge({ orderId: order.id, amountCents: order.amountCents })
  logger.info('支付成功', { orderId: order.id, transactionId: result.transactionId })
  return result.transactionId
}
