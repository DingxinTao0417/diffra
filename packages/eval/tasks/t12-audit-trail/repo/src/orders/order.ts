export type OrderStatus = 'pending' | 'paid' | 'shipped' | 'delivered' | 'returned' | 'cancelled'

export interface OrderLine {
  sku: string
  quantity: number
  unitPriceCents: number
}

// 金额都是整数分
export interface Order {
  id: string
  customerId: string
  lines: OrderLine[]
  subtotalCents: number
  shippingFeeCents: number
  totalCents: number
  status: OrderStatus
  createdAt: number
  updatedAt: number
}

// 订单模块用到的库存能力，由库存模块实现
export interface StockPort {
  reserve(orderId: string, lines: OrderLine[]): void
  release(orderId: string, lines: OrderLine[]): void
}
