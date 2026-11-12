import type { AuditLog } from '../audit/audit-log.ts'
import type { OrderStatus } from '../orders/order.ts'
import type { OrderLifecycle } from '../orders/order-lifecycle.ts'
import type { OrderStore } from '../orders/order-store.ts'
import { invalid } from '../shared/errors.ts'
import { requireAdmin, type Router } from './router.ts'

export interface AdminSupportRouteDeps {
  orders: OrderStore
  lifecycle: OrderLifecycle
  audit: AuditLog
}

const STATUSES: OrderStatus[] = ['pending', 'paid', 'shipped', 'delivered', 'returned', 'cancelled']

export function registerAdminSupportRoutes(router: Router, { orders, lifecycle, audit }: AdminSupportRouteDeps): void {
  // 客服兜底用：订单状态和实际情况对不上时手动改过来。只改状态，不管流转规则，也不动库存、退款和通知
  router.add('POST', /^\/admin\/orders\/([^/]+)\/status$/, ({ user, id, body }) => {
    requireAdmin(user)
    orders.require(id)
    const status = STATUSES.find((candidate) => candidate === body.status)
    if (!status) throw invalid('没有这个状态')
    return { status: 200, body: lifecycle.force(id, status, 'admin') }
  })

  router.add('GET', /^\/admin\/orders\/([^/]+)\/audit$/, ({ user, id }) => {
    requireAdmin(user)
    orders.require(id)
    return { status: 200, body: audit.forOrder(id) }
  })
}
