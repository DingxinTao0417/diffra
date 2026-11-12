import { expireUnpaidOrders, type ExpireDeps } from '../jobs/expire-unpaid-orders.ts'
import type { RefundService } from '../payments/refund-service.ts'
import type { ReturnService } from '../returns/return-service.ts'
import { invalid } from '../shared/errors.ts'
import type { ShippingService } from '../shipping/shipping-service.ts'
import { requireAdmin, type Router } from './router.ts'

export interface AdminOrderRouteDeps {
  refundService: RefundService
  shippingService: ShippingService
  returnService: ReturnService
  expire: ExpireDeps
}

// 客服和仓库用的后台接口，都要管理员权限
export function registerAdminOrderRoutes(router: Router, { refundService, shippingService, returnService, expire }: AdminOrderRouteDeps): void {
  router.add('POST', /^\/admin\/orders\/([^/]+)\/refund$/, ({ user, id, body }) => {
    requireAdmin(user)
    if (body.amountCents !== undefined && typeof body.amountCents !== 'number') throw invalid('amountCents 应该是整数分')
    return { status: 200, body: refundService.refund(id, body.amountCents) }
  })

  router.add('POST', /^\/admin\/orders\/([^/]+)\/ship$/, ({ user, id, body }) => {
    requireAdmin(user)
    const carrier = typeof body.carrier === 'string' && body.carrier !== '' ? body.carrier : 'SF'
    return { status: 200, body: shippingService.dispatch(id, carrier) }
  })

  router.add('POST', /^\/admin\/orders\/([^/]+)\/deliver$/, ({ user, id }) => {
    requireAdmin(user)
    return { status: 200, body: shippingService.confirmDelivery(id) }
  })

  router.add('POST', /^\/admin\/orders\/([^/]+)\/return$/, ({ user, id }) => {
    requireAdmin(user)
    return { status: 200, body: returnService.receive(id) }
  })

  // 线上由调度器每分钟调一次
  router.add('POST', /^\/admin\/jobs\/expire-unpaid$/, ({ user }) => {
    requireAdmin(user)
    return { status: 200, body: { expired: expireUnpaidOrders(expire) } }
  })
}
