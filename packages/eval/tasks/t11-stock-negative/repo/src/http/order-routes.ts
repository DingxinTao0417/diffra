import type { CancelOrder } from '../orders/cancel-order.ts'
import type { Order } from '../orders/order.ts'
import type { OrderStore } from '../orders/order-store.ts'
import type { OrderItemInput, PlaceOrder } from '../orders/place-order.ts'
import type { PaymentService } from '../payments/payment-service.ts'
import { invalid, notFound } from '../shared/errors.ts'
import type { CurrentUser, Router } from './router.ts'

export interface OrderRouteDeps {
  orders: OrderStore
  placeOrder: PlaceOrder
  cancelOrder: CancelOrder
  paymentService: PaymentService
}

function parseItems(value: unknown): OrderItemInput[] {
  if (!Array.isArray(value)) throw invalid('items 应该是数组')
  return value.map((item: unknown) => {
    const { sku, quantity } = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {}
    if (typeof sku !== 'string' || typeof quantity !== 'number') throw invalid('每一项要有 sku 和 quantity')
    return { sku, quantity }
  })
}

export function registerOrderRoutes(router: Router, { orders, placeOrder, cancelOrder, paymentService }: OrderRouteDeps): void {
  // 买家只能看、付、取消自己的订单，别人的订单当作不存在；管理员不受限
  const accessibleOrder = (user: CurrentUser, id: string): Order => {
    const order = orders.require(id)
    if (user.role !== 'admin' && order.customerId !== user.id) throw notFound('订单不存在')
    return order
  }

  router.add('POST', /^\/orders$/, ({ user, body }) => ({ status: 201, body: placeOrder.execute(user.id, parseItems(body.items)) }))

  router.add('GET', /^\/orders$/, ({ user }) => ({ status: 200, body: orders.byCustomer(user.id) }))

  router.add('GET', /^\/orders\/([^/]+)$/, ({ user, id }) => ({ status: 200, body: accessibleOrder(user, id) }))

  router.add('POST', /^\/orders\/([^/]+)\/pay$/, ({ user, id, body }) => {
    const order = accessibleOrder(user, id)
    if (typeof body.token !== 'string' || body.token === '') throw invalid('缺少支付凭证')
    paymentService.capture(order.id, body.token)
    return { status: 200, body: order }
  })

  router.add('POST', /^\/orders\/([^/]+)\/cancel$/, ({ user, id }) => {
    const order = accessibleOrder(user, id)
    return { status: 200, body: cancelOrder.execute(order.id, user.role === 'admin' ? 'admin' : 'customer') }
  })
}
