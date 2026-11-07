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
  let result: { transactionId: string }
  try {
    result = await gateway.charge({ orderId: order.id, amountCents: order.amountCents })
  } catch (error) {
    logger.error('支付失败', { orderId: order.id, userId: order.userId, amountCents: order.amountCents, error })
    throw error
  }
  logger.info('支付成功', { orderId: order.id, transactionId: result.transactionId })
  return result.transactionId
}
