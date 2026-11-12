import type { OrderStatus } from '../orders/order.ts'

// 触发来源：是谁让订单状态变的
// customer 买家自己操作，admin 客服在后台操作，payment 付款结果，shipping 发货和签收，returns 退货入库，system 定时任务
export type AuditSource = 'customer' | 'admin' | 'payment' | 'shipping' | 'returns' | 'system'

// 一条记录对应一次订单状态变化。下单时的初始状态不算变化，不记；状态没变的操作也不记
export interface AuditEntry {
  orderId: string
  from: OrderStatus
  to: OrderStatus
  // 状态变化的时间，用应用的 clock
  at: number
  source: AuditSource
}

// 订单状态的审计记录，只追加。后台的审计查询接口读这里
export class AuditLog {
  private readonly entries: AuditEntry[] = []

  record(entry: AuditEntry): void {
    this.entries.push(entry)
  }

  list(): AuditEntry[] {
    return [...this.entries]
  }

  forOrder(orderId: string): AuditEntry[] {
    return this.entries.filter((entry) => entry.orderId === orderId)
  }
}
