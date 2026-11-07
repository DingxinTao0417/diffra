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
