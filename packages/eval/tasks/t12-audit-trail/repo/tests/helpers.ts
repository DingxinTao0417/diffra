import assert from 'node:assert/strict'
import { createApp } from '../src/app.ts'
import type { CurrentUser } from '../src/http/router.ts'
import { createManualClock } from '../src/shared/clock.ts'

export const alice: CurrentUser = { id: 'u_alice', role: 'customer' }
export const bob: CurrentUser = { id: 'u_bob', role: 'customer' }
export const admin: CurrentUser = { id: 'u_admin', role: 'admin' }

export const MINUTE = 60 * 1000
export const DAY = 24 * 60 * MINUTE

// 一套全新的应用：马克杯 39 元、库存 10；T 恤 129 元、库存 5
export function setup() {
  const clock = createManualClock(Date.UTC(2026, 0, 5, 2, 0, 0))
  const app = createApp({
    clock,
    products: [
      { sku: 'MUG', name: '马克杯', priceCents: 3900, stock: 10 },
      { sku: 'TEE', name: 'T 恤', priceCents: 12900, stock: 5 },
    ],
  })
  const call = (user: CurrentUser | null, method: string, path: string, body?: unknown) => app.handle({ method, path, body, user })
  const stockOf = (sku: string) => call(admin, 'GET', `/admin/stock/${sku}`).body
  const place = (user: CurrentUser, items: Array<{ sku: string; quantity: number }>): string => {
    const response = call(user, 'POST', '/orders', { items })
    assert.equal(response.status, 201)
    return (response.body as { id: string }).id
  }
  const pay = (user: CurrentUser, orderId: string): void => {
    assert.equal(call(user, 'POST', `/orders/${orderId}/pay`, { token: 'tok_ok' }).status, 200)
  }
  return { app, clock, call, stockOf, place, pay }
}
