import { invalid } from '../shared/errors.ts'

export interface Product {
  sku: string
  name: string
  priceCents: number
}

export class ProductCatalog {
  private readonly products = new Map<string, Product>()

  add(product: Product): void {
    this.products.set(product.sku, product)
  }

  find(sku: string): Product | null {
    return this.products.get(sku) ?? null
  }

  // 下单时用：商品不存在算请求有误
  require(sku: string): Product {
    const product = this.find(sku)
    if (!product) throw invalid(`没有这个商品：${sku}`)
    return product
  }
}
