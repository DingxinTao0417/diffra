export type MovementKind = 'reserve' | 'release' | 'commit' | 'restock'

export interface StockMovement {
  kind: MovementKind
  sku: string
  quantity: number
  orderId: string
  at: number
}

// 库存流水：每次变动记一条，只追加，对账用
export class StockMovements {
  private readonly entries: StockMovement[] = []

  record(movement: StockMovement): void {
    this.entries.push(movement)
  }

  forSku(sku: string): StockMovement[] {
    return this.entries.filter((entry) => entry.sku === sku)
  }

  forOrder(orderId: string): StockMovement[] {
    return this.entries.filter((entry) => entry.orderId === orderId)
  }
}
