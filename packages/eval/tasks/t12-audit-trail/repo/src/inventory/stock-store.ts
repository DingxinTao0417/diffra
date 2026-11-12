import { notFound } from '../shared/errors.ts'

// onHand 是仓库里的实物数量，reserved 是已下单还没发货占着的；能卖的是 onHand - reserved
export interface StockLevel {
  sku: string
  onHand: number
  reserved: number
}

export class StockStore {
  private readonly levels = new Map<string, StockLevel>()

  set(sku: string, onHand: number): void {
    this.levels.set(sku, { sku, onHand, reserved: 0 })
  }

  require(sku: string): StockLevel {
    const level = this.levels.get(sku)
    if (!level) throw notFound(`没有这个商品的库存：${sku}`)
    return level
  }
}
