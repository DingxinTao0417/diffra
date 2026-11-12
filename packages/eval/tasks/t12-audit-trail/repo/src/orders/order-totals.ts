import type { OrderLine } from './order.ts'

const SHIPPING_FEE_CENTS = 800
const FREE_SHIPPING_FROM_CENTS = 9900

// 商品小计满 99 元包邮，否则收 8 元运费
export function computeTotals(lines: OrderLine[]): { subtotalCents: number; shippingFeeCents: number; totalCents: number } {
  const subtotalCents = lines.reduce((sum, line) => sum + line.unitPriceCents * line.quantity, 0)
  const shippingFeeCents = subtotalCents >= FREE_SHIPPING_FROM_CENTS ? 0 : SHIPPING_FEE_CENTS
  return { subtotalCents, shippingFeeCents, totalCents: subtotalCents + shippingFeeCents }
}
