export interface CartItem {
  sku: string
  unitPriceCents: number
  quantity: number
}

// 满减券：小计达到门槛才能用；折扣券：percentOff 为 10 表示减 10%
export type Coupon = { kind: 'threshold'; thresholdCents: number; offCents: number } | { kind: 'percent'; percentOff: number }

export interface CheckoutResult {
  subtotalCents: number
  discountCents: number
  totalCents: number
}

export function subtotal(items: CartItem[]): number {
  return items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0)
}

function assertValidItem(item: CartItem): void {
  if (!Number.isInteger(item.quantity) || item.quantity <= 0) throw new RangeError(`商品 ${item.sku} 的数量必须是正整数`)
  if (!Number.isInteger(item.unitPriceCents) || item.unitPriceCents < 0) throw new RangeError(`商品 ${item.sku} 的单价必须是非负整数`)
}

export function checkout(items: CartItem[], coupons: Coupon[]): CheckoutResult {
  items.forEach(assertValidItem)
  const subtotalCents = subtotal(items)
  const thresholdOff = Math.max(0, ...coupons.flatMap((coupon) => (coupon.kind === 'threshold' && subtotalCents >= coupon.thresholdCents ? [coupon.offCents] : [])))
  const afterThreshold = Math.max(0, subtotalCents - thresholdOff)
  const percentOff = Math.max(0, ...coupons.flatMap((coupon) => (coupon.kind === 'percent' ? [coupon.percentOff] : [])))
  const totalCents = afterThreshold - Math.floor((afterThreshold * percentOff) / 100)
  return { subtotalCents, discountCents: subtotalCents - totalCents, totalCents }
}
