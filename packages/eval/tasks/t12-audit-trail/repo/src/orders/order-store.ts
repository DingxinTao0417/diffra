import { notFound } from '../shared/errors.ts'
import type { Order, OrderStatus } from './order.ts'

export class OrderStore {
  private readonly orders = new Map<string, Order>()

  save(order: Order): void {
    this.orders.set(order.id, order)
  }

  find(id: string): Order | null {
    return this.orders.get(id) ?? null
  }

  require(id: string): Order {
    const order = this.find(id)
    if (!order) throw notFound('订单不存在')
    return order
  }

  byStatus(status: OrderStatus): Order[] {
    return [...this.orders.values()].filter((order) => order.status === status)
  }

  byCustomer(customerId: string): Order[] {
    return [...this.orders.values()].filter((order) => order.customerId === customerId)
  }
}
