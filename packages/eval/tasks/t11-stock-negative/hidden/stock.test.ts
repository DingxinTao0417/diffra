import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApp } from '../src/app.ts'

type User = { id: string; role: 'customer' | 'admin' }
const alice: User = { id: 'u_alice', role: 'customer' }
const bob: User = { id: 'u_bob', role: 'customer' }
const admin: User = { id: 'u_admin', role: 'admin' }

const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE

// 只走接口，不碰内部模块：马克杯库存 10，T 恤库存 5
function setup() {
  let now = Date.UTC(2026, 0, 5, 2, 0, 0)
  const app = createApp({
    clock: { now: () => now },
    products: [
      { sku: 'MUG', name: '马克杯', priceCents: 3900, stock: 10 },
      { sku: 'TEE', name: 'T 恤', priceCents: 12900, stock: 5 },
    ],
  })
  const call = (user: User, method: string, path: string, body?: unknown) => app.handle({ method, path, body, user })
  const ok = (user: User, method: string, path: string, body?: unknown) => {
    const response = call(user, method, path, body)
    assert.equal(response.status, 200, `${method} ${path} 应该成功：${JSON.stringify(response.body)}`)
    return response.body
  }
  const stock = (sku: string) => {
    const { onHand, reserved, available } = ok(admin, 'GET', `/admin/stock/${sku}`) as Record<string, number>
    return { onHand, reserved, available }
  }
  const place = (user: User, sku: string, quantity: number): string => {
    const response = call(user, 'POST', '/orders', { items: [{ sku, quantity }] })
    assert.equal(response.status, 201, JSON.stringify(response.body))
    return (response.body as { id: string }).id
  }
  const placePaid = (user: User, sku: string, quantity: number): string => {
    const id = place(user, sku, quantity)
    ok(user, 'POST', `/orders/${id}/pay`, { token: 'tok_ok' })
    return id
  }
  const advance = (ms: number) => {
    now += ms
  }
  return { call, ok, stock, place, placePaid, advance }
}

test('只取消：没付款的和付了款的都放回一次', () => {
  const { ok, stock, place, placePaid } = setup()
  const unpaid = place(alice, 'MUG', 3)
  const paid = placePaid(bob, 'MUG', 2)
  assert.deepEqual(stock('MUG'), { onHand: 10, reserved: 5, available: 5 })
  ok(alice, 'POST', `/orders/${unpaid}/cancel`)
  assert.deepEqual(stock('MUG'), { onHand: 10, reserved: 2, available: 8 })
  ok(bob, 'POST', `/orders/${paid}/cancel`)
  assert.deepEqual(stock('MUG'), { onHand: 10, reserved: 0, available: 10 })
})

test('只全额退款（还没发货）：放回一次', () => {
  const { ok, stock, placePaid } = setup()
  const id = placePaid(alice, 'MUG', 3)
  ok(admin, 'POST', `/admin/orders/${id}/refund`)
  assert.deepEqual(stock('MUG'), { onHand: 10, reserved: 0, available: 10 })
})

test('先取消再全额退款：只放回一次，钱照样能退', () => {
  const { ok, stock, placePaid } = setup()
  const id = placePaid(alice, 'MUG', 3)
  ok(alice, 'POST', `/orders/${id}/cancel`)
  assert.deepEqual(stock('MUG'), { onHand: 10, reserved: 0, available: 10 })
  const payment = ok(admin, 'POST', `/admin/orders/${id}/refund`) as { status: string; refundedCents: number }
  assert.equal(payment.status, 'refunded')
  assert.equal(payment.refundedCents, 11700)
  assert.deepEqual(stock('MUG'), { onHand: 10, reserved: 0, available: 10 })
})

test('先全额退款再取消：只放回一次', () => {
  const { call, ok, stock, placePaid } = setup()
  const id = placePaid(alice, 'MUG', 3)
  ok(admin, 'POST', `/admin/orders/${id}/refund`)
  assert.deepEqual(stock('MUG'), { onHand: 10, reserved: 0, available: 10 })
  // 取消成不成功不在这里判，只看库存
  call(admin, 'POST', `/orders/${id}/cancel`)
  assert.deepEqual(stock('MUG'), { onHand: 10, reserved: 0, available: 10 })
})

test('部分退款不放库存；分几次退完放回一次，之后再取消也不再变', () => {
  const { call, ok, stock, placePaid } = setup()
  const id = placePaid(alice, 'MUG', 3)
  ok(admin, 'POST', `/admin/orders/${id}/refund`, { amountCents: 3900 })
  assert.deepEqual(stock('MUG'), { onHand: 10, reserved: 3, available: 7 })
  ok(admin, 'POST', `/admin/orders/${id}/refund`, { amountCents: 3900 })
  assert.deepEqual(stock('MUG'), { onHand: 10, reserved: 3, available: 7 })
  ok(admin, 'POST', `/admin/orders/${id}/refund`)
  assert.deepEqual(stock('MUG'), { onHand: 10, reserved: 0, available: 10 })
  call(alice, 'POST', `/orders/${id}/cancel`)
  assert.deepEqual(stock('MUG'), { onHand: 10, reserved: 0, available: 10 })
})

test('部分退款后取消，再把剩下的退完：只放回一次', () => {
  const { ok, stock, placePaid } = setup()
  const id = placePaid(alice, 'MUG', 3)
  ok(admin, 'POST', `/admin/orders/${id}/refund`, { amountCents: 5000 })
  ok(alice, 'POST', `/orders/${id}/cancel`)
  assert.deepEqual(stock('MUG'), { onHand: 10, reserved: 0, available: 10 })
  ok(admin, 'POST', `/admin/orders/${id}/refund`)
  assert.deepEqual(stock('MUG'), { onHand: 10, reserved: 0, available: 10 })
})

test('同一个商品别的订单还占着库存时，数字也要对', () => {
  const { call, ok, stock, placePaid } = setup()
  const first = placePaid(alice, 'MUG', 3)
  const second = placePaid(bob, 'MUG', 4)
  assert.deepEqual(stock('MUG'), { onHand: 10, reserved: 7, available: 3 })
  ok(alice, 'POST', `/orders/${first}/cancel`)
  ok(admin, 'POST', `/admin/orders/${first}/refund`)
  assert.deepEqual(stock('MUG'), { onHand: 10, reserved: 4, available: 6 })
  ok(admin, 'POST', `/admin/orders/${second}/refund`)
  call(admin, 'POST', `/orders/${second}/cancel`)
  assert.deepEqual(stock('MUG'), { onHand: 10, reserved: 0, available: 10 })
})

test('取消并退款之后不会超卖', () => {
  const { call, ok, stock, place, placePaid } = setup()
  const id = placePaid(alice, 'TEE', 4)
  ok(alice, 'POST', `/orders/${id}/cancel`)
  ok(admin, 'POST', `/admin/orders/${id}/refund`)
  place(bob, 'TEE', 5)
  assert.equal(call(alice, 'POST', '/orders', { items: [{ sku: 'TEE', quantity: 1 }] }).status, 409)
  assert.deepEqual(stock('TEE'), { onHand: 5, reserved: 5, available: 0 })
})

test('一个订单里有几种商品，每种都只放回一次', () => {
  const { call, ok, stock } = setup()
  const response = call(alice, 'POST', '/orders', { items: [{ sku: 'MUG', quantity: 2 }, { sku: 'TEE', quantity: 1 }] })
  assert.equal(response.status, 201)
  const id = (response.body as { id: string }).id
  ok(alice, 'POST', `/orders/${id}/pay`, { token: 'tok_ok' })
  ok(admin, 'POST', `/admin/orders/${id}/refund`)
  call(alice, 'POST', `/orders/${id}/cancel`)
  assert.deepEqual(stock('MUG'), { onHand: 10, reserved: 0, available: 10 })
  assert.deepEqual(stock('TEE'), { onHand: 5, reserved: 0, available: 5 })
})

test('发货以后的退款和退货不受影响', () => {
  const { ok, stock, placePaid } = setup()
  const id = placePaid(alice, 'MUG', 3)
  ok(admin, 'POST', `/admin/orders/${id}/ship`)
  assert.deepEqual(stock('MUG'), { onHand: 7, reserved: 0, available: 7 })
  ok(admin, 'POST', `/admin/orders/${id}/refund`)
  assert.deepEqual(stock('MUG'), { onHand: 7, reserved: 0, available: 7 })
  ok(admin, 'POST', `/admin/orders/${id}/deliver`)
  ok(admin, 'POST', `/admin/orders/${id}/return`)
  assert.deepEqual(stock('MUG'), { onHand: 10, reserved: 0, available: 10 })
})

test('超时没付款自动取消：放回一次，再跑一遍任务不会重复放', () => {
  const { ok, stock, place, advance } = setup()
  place(alice, 'MUG', 4)
  advance(31 * MINUTE)
  assert.deepEqual(ok(admin, 'POST', '/admin/jobs/expire-unpaid'), { expired: 1 })
  assert.deepEqual(ok(admin, 'POST', '/admin/jobs/expire-unpaid'), { expired: 0 })
  assert.deepEqual(stock('MUG'), { onHand: 10, reserved: 0, available: 10 })
})

test('正常卖出去的订单照常占库存、出库', () => {
  const { ok, stock, placePaid, advance } = setup()
  const shipped = placePaid(alice, 'MUG', 2)
  placePaid(bob, 'MUG', 1)
  ok(admin, 'POST', `/admin/orders/${shipped}/ship`)
  advance(2 * DAY)
  ok(admin, 'POST', `/admin/orders/${shipped}/deliver`)
  assert.deepEqual(stock('MUG'), { onHand: 8, reserved: 1, available: 7 })
})
