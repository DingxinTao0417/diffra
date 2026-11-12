import type { LowStockMonitor } from '../inventory/low-stock-monitor.ts'
import type { StockMovements } from '../inventory/stock-movements.ts'
import type { StockStore } from '../inventory/stock-store.ts'
import { requireAdmin, type Router } from './router.ts'

export interface AdminStockRouteDeps {
  stock: StockStore
  movements: StockMovements
  lowStock: LowStockMonitor
}

export function registerAdminStockRoutes(router: Router, { stock, movements, lowStock }: AdminStockRouteDeps): void {
  router.add('GET', /^\/admin\/stock\/([^/]+)$/, ({ user, id }) => {
    requireAdmin(user)
    const level = stock.require(id)
    return { status: 200, body: { sku: level.sku, onHand: level.onHand, reserved: level.reserved, available: level.onHand - level.reserved } }
  })

  router.add('GET', /^\/admin\/stock\/([^/]+)\/movements$/, ({ user, id }) => {
    requireAdmin(user)
    stock.require(id)
    return { status: 200, body: movements.forSku(id) }
  })

  router.add('GET', /^\/admin\/low-stock$/, ({ user }) => {
    requireAdmin(user)
    return { status: 200, body: lowStock.list() }
  })
}
