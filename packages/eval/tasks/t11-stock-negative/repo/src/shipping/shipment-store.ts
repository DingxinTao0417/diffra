// 一个订单一次发完，按订单号存
export interface Shipment {
  orderId: string
  carrier: string
  trackingNo: string
  dispatchedAt: number
  deliveredAt: number | null
}

export class ShipmentStore {
  private readonly shipments = new Map<string, Shipment>()

  save(shipment: Shipment): void {
    this.shipments.set(shipment.orderId, shipment)
  }

  find(orderId: string): Shipment | null {
    return this.shipments.get(orderId) ?? null
  }
}
