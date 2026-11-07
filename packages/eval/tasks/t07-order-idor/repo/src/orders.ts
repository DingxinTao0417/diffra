export interface Order {
  id: string
  ownerId: string
  items: Array<{ sku: string; quantity: number }>
  totalCents: number
  shippingAddress: string
}

export class OrderStore {
  private readonly orders = new Map<string, Order>()

  add(order: Order): void {
    this.orders.set(order.id, order)
  }

  get(id: string): Order | null {
    return this.orders.get(id) ?? null
  }

  byOwner(ownerId: string): Order[] {
    return [...this.orders.values()].filter((order) => order.ownerId === ownerId)
  }

  all(): Order[] {
    return [...this.orders.values()]
  }
}
