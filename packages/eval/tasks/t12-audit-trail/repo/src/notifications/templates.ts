import type { Order } from '../orders/order.ts'
import type { CancelReason } from '../shared/events.ts'

export interface Template {
  subject: string
  body: string
}

const yuan = (cents: number) => `¥${(cents / 100).toFixed(2)}`

const CANCEL_REASONS: Record<CancelReason, string> = {
  customer: '已按你的要求取消',
  admin: '已由客服取消',
  expired: '超过 30 分钟没有付款，已自动取消',
}

export const templates = {
  orderPlaced: (order: Order): Template => ({ subject: '订单已提交', body: `订单 ${order.id} 应付 ${yuan(order.totalCents)}，请在 30 分钟内付款。` }),
  paymentCaptured: (order: Order, amountCents: number): Template => ({ subject: '付款成功', body: `订单 ${order.id} 已收到 ${yuan(amountCents)}，我们会尽快发货。` }),
  orderCancelled: (order: Order, reason: CancelReason): Template => ({ subject: '订单已取消', body: `订单 ${order.id} ${CANCEL_REASONS[reason]}。` }),
  refunded: (order: Order, amountCents: number, fullyRefunded: boolean): Template => ({
    subject: fullyRefunded ? '已全额退款' : '已部分退款',
    body: `订单 ${order.id} 退款 ${yuan(amountCents)}，1–3 个工作日原路退回。`,
  }),
  dispatched: (order: Order, trackingNo: string): Template => ({ subject: '已发货', body: `订单 ${order.id} 已发出，运单号 ${trackingNo}。` }),
  delivered: (order: Order): Template => ({ subject: '已签收', body: `订单 ${order.id} 已签收，7 天内可以申请退货。` }),
}
