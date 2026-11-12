import { ProductCatalog, type Product } from './catalog/product-catalog.ts'
import { registerAdminOrderRoutes } from './http/admin-order-routes.ts'
import { registerAdminStockRoutes } from './http/admin-stock-routes.ts'
import { registerOrderRoutes } from './http/order-routes.ts'
import { Router, type Request, type Response } from './http/router.ts'
import { registerInventoryListeners } from './inventory/inventory-listeners.ts'
import { InventoryService } from './inventory/inventory-service.ts'
import { LowStockMonitor } from './inventory/low-stock-monitor.ts'
import { StockMovements } from './inventory/stock-movements.ts'
import { StockStore } from './inventory/stock-store.ts'
import { registerNotificationListeners } from './notifications/notification-listeners.ts'
import { Outbox } from './notifications/outbox.ts'
import { CancelOrder } from './orders/cancel-order.ts'
import { OrderLifecycle } from './orders/order-lifecycle.ts'
import { OrderStore } from './orders/order-store.ts'
import { PlaceOrder } from './orders/place-order.ts'
import { FakeGateway, type PaymentGateway } from './payments/payment-gateway.ts'
import { PaymentService } from './payments/payment-service.ts'
import { PaymentStore } from './payments/payment-store.ts'
import { RefundService } from './payments/refund-service.ts'
import { ReturnService } from './returns/return-service.ts'
import { systemClock, type Clock } from './shared/clock.ts'
import { EventBus } from './shared/event-bus.ts'
import { IdGenerator } from './shared/id-generator.ts'
import { ShipmentStore } from './shipping/shipment-store.ts'
import { ShippingService } from './shipping/shipping-service.ts'

export interface AppOptions {
  // 上架的商品和各自的初始库存
  products: Array<Product & { stock: number }>
  clock?: Clock
  gateway?: PaymentGateway
  lowStockThreshold?: number
}

// 把各模块装起来。数据都在内存里，每次调用是一套全新的
export function createApp(options: AppOptions) {
  const clock = options.clock ?? systemClock
  const bus = new EventBus()
  const ids = new IdGenerator()
  const catalog = new ProductCatalog()
  const stock = new StockStore()
  for (const { stock: onHand, ...product } of options.products) {
    catalog.add(product)
    stock.set(product.sku, onHand)
  }
  const movements = new StockMovements()
  const orders = new OrderStore()
  const payments = new PaymentStore()
  const shipments = new ShipmentStore()
  const outbox = new Outbox()
  const gateway = options.gateway ?? new FakeGateway()

  const inventory = new InventoryService({ stock, movements, bus, clock, lowStockThreshold: options.lowStockThreshold ?? 2 })
  const lowStock = new LowStockMonitor(bus, clock)
  const lifecycle = new OrderLifecycle(orders, clock)
  const placeOrder = new PlaceOrder({ orders, catalog, stock: inventory, bus, clock, ids })
  const cancelOrder = new CancelOrder({ lifecycle, stock: inventory, bus })
  const paymentService = new PaymentService({ orders, payments, gateway, lifecycle, bus, clock })
  const refundService = new RefundService({ payments, gateway, bus })
  const shippingService = new ShippingService({ lifecycle, payments, shipments, bus, clock, ids })
  const returnService = new ReturnService({ lifecycle, shipments, bus, clock })

  registerInventoryListeners(bus, inventory, orders)
  registerNotificationListeners(bus, orders, outbox, clock)

  const router = new Router()
  registerOrderRoutes(router, { orders, placeOrder, cancelOrder, paymentService })
  registerAdminOrderRoutes(router, { refundService, shippingService, returnService, expire: { orders, stock: inventory, bus, clock } })
  registerAdminStockRoutes(router, { stock, movements, lowStock })

  return { handle: (request: Request): Response => router.handle(request), bus, clock, orders, payments, inventory, outbox }
}
