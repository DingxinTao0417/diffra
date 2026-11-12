export type CancelReason = 'customer' | 'admin' | 'expired'

// 总线上的所有事件和各自带的数据
export interface AppEvents {
  'order.placed': { orderId: string }
  'order.cancelled': { orderId: string; reason: CancelReason }
  'payment.captured': { orderId: string; amountCents: number }
  'payment.refunded': { orderId: string; amountCents: number; fullyRefunded: boolean }
  'shipment.dispatched': { orderId: string; trackingNo: string }
  'shipment.delivered': { orderId: string }
  'return.received': { orderId: string }
  'stock.low': { sku: string; available: number }
}
