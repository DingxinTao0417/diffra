import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApp } from '../src/app.ts'

type User = { id: string; role: 'customer' | 'admin' }
const alice: User = { id: 'u_alice', role: 'customer' }
const bob: User = { id: 'u_bob', role: 'customer' }
const admin: User = { id: 'u_admin', role: 'admin' }

const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE
const START = Date.UTC(2026, 0, 5, 2, 0, 0)

// 只走接口：操作订单，再从审计查询接口读记录
function setup() {
  let now = START
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
  const place = (user: User): string => {
    const response = call(user, 'POST', '/orders', { items: [{ sku: 'MUG', quantity: 1 }] })
    assert.equal(response.status, 201, JSON.stringify(response.body))
    return (response.body as { id: string }).id
  }
  const pay = (user: User, id: string) => ok(user, 'POST', `/orders/${id}/pay`, { token: 'tok_ok' })
  // 推进时间，返回推进后的时刻
  const advance = (ms: number): number => {
    now += ms
    return now
  }
  // 每条记录要有订单号、原状态、新状态、时间，触发来源不能空；按发生的先后排
  const expectAudit = (orderId: string, expected: Array<{ from: string; to: string; at: number }>) => {
    const entries = (ok(admin, 'GET', `/admin/orders/${orderId}/audit`) as Array<Record<string, unknown>>).filter((entry) => entry.from != null)
    assert.deepEqual(
      entries.map((entry) => ({ orderId: entry.orderId, from: entry.from, to: entry.to, at: entry.at })),
      expected.map((entry) => ({ orderId, ...entry })),
    )
    for (const entry of entries) assert.ok(typeof entry.source === 'string' && entry.source !== '', `缺少触发来源：${JSON.stringify(entry)}`)
  }
  return { call, ok, place, pay, advance, expectAudit }
}

test('刚下的订单没有状态变化记录', () => {
  const { place, expectAudit } = setup()
  expectAudit(place(alice), [])
})

test('付款：待付款 → 已付款；拒付不记', () => {
  const { call, place, pay, advance, expectAudit } = setup()
  const id = place(alice)
  assert.equal(call(alice, 'POST', `/orders/${id}/pay`, { token: 'tok_declined' }).status, 402)
  expectAudit(id, [])
  const paidAt = advance(3 * MINUTE)
  pay(alice, id)
  expectAudit(id, [{ from: 'pending', to: 'paid', at: paidAt }])
})

test('买家取消待付款的订单', () => {
  const { ok, place, advance, expectAudit } = setup()
  const id = place(alice)
  const cancelledAt = advance(5 * MINUTE)
  ok(alice, 'POST', `/orders/${id}/cancel`)
  expectAudit(id, [{ from: 'pending', to: 'cancelled', at: cancelledAt }])
})

test('客服取消已付款的订单', () => {
  const { ok, place, pay, advance, expectAudit } = setup()
  const id = place(alice)
  pay(alice, id)
  const cancelledAt = advance(2 * DAY)
  ok(admin, 'POST', `/orders/${id}/cancel`)
  expectAudit(id, [
    { from: 'pending', to: 'paid', at: START },
    { from: 'paid', to: 'cancelled', at: cancelledAt },
  ])
})

test('发货、签收、退货一路都有记录', () => {
  const { ok, place, pay, advance, expectAudit } = setup()
  const id = place(alice)
  const paidAt = advance(MINUTE)
  pay(alice, id)
  const shippedAt = advance(DAY)
  ok(admin, 'POST', `/admin/orders/${id}/ship`, { carrier: 'YTO' })
  const deliveredAt = advance(2 * DAY)
  ok(admin, 'POST', `/admin/orders/${id}/deliver`)
  const returnedAt = advance(3 * DAY)
  ok(admin, 'POST', `/admin/orders/${id}/return`)
  expectAudit(id, [
    { from: 'pending', to: 'paid', at: paidAt },
    { from: 'paid', to: 'shipped', at: shippedAt },
    { from: 'shipped', to: 'delivered', at: deliveredAt },
    { from: 'delivered', to: 'returned', at: returnedAt },
  ])
})

test('超时没付款被自动取消', () => {
  const { ok, place, pay, advance, expectAudit } = setup()
  const unpaid = place(alice)
  const paid = place(bob)
  pay(bob, paid)
  const expiredAt = advance(31 * MINUTE)
  assert.deepEqual(ok(admin, 'POST', '/admin/jobs/expire-unpaid'), { expired: 1 })
  advance(MINUTE)
  assert.deepEqual(ok(admin, 'POST', '/admin/jobs/expire-unpaid'), { expired: 0 })
  expectAudit(unpaid, [{ from: 'pending', to: 'cancelled', at: expiredAt }])
  expectAudit(paid, [{ from: 'pending', to: 'paid', at: START }])
})

test('客服手动改状态', () => {
  const { ok, place, pay, advance, expectAudit } = setup()
  const id = place(alice)
  pay(alice, id)
  const firstAt = advance(DAY)
  ok(admin, 'POST', `/admin/orders/${id}/status`, { status: 'pending' })
  const secondAt = advance(MINUTE)
  ok(admin, 'POST', `/admin/orders/${id}/status`, { status: 'delivered' })
  expectAudit(id, [
    { from: 'pending', to: 'paid', at: START },
    { from: 'paid', to: 'pending', at: firstAt },
    { from: 'pending', to: 'delivered', at: secondAt },
  ])
})

test('手动改过状态以后，正常流转接着记', () => {
  const { ok, place, advance, expectAudit } = setup()
  const id = place(alice)
  ok(admin, 'POST', `/admin/orders/${id}/status`, { status: 'paid' })
  const shippedAt = advance(DAY)
  ok(admin, 'POST', `/admin/orders/${id}/ship`)
  expectAudit(id, [
    { from: 'pending', to: 'paid', at: START },
    { from: 'paid', to: 'shipped', at: shippedAt },
  ])
})

test('没改成状态的操作不留记录', () => {
  const { call, ok, place, pay, advance, expectAudit } = setup()
  const id = place(alice)
  assert.equal(call(admin, 'POST', `/admin/orders/${id}/ship`).status, 409)
  assert.equal(call(admin, 'POST', `/admin/orders/${id}/deliver`).status, 409)
  assert.equal(call(admin, 'POST', `/admin/orders/${id}/return`).status, 409)
  assert.equal(call(admin, 'POST', `/admin/orders/${id}/status`, { status: 'refunded' }).status, 400)
  assert.equal(call(bob, 'POST', `/orders/${id}/cancel`).status, 404)
  expectAudit(id, [])
  pay(alice, id)
  advance(MINUTE)
  // 退款只动钱，不改订单状态
  ok(admin, 'POST', `/admin/orders/${id}/refund`, { amountCents: 1000 })
  assert.equal(call(alice, 'POST', `/orders/${id}/pay`, { token: 'tok_ok' }).status, 409)
  const shippedAt = advance(MINUTE)
  ok(admin, 'POST', `/admin/orders/${id}/ship`)
  assert.equal(call(alice, 'POST', `/orders/${id}/cancel`).status, 409)
  expectAudit(id, [
    { from: 'pending', to: 'paid', at: START },
    { from: 'paid', to: 'shipped', at: shippedAt },
  ])
})

test('每个订单只看得到自己的记录', () => {
  const { ok, place, pay, advance, expectAudit } = setup()
  const first = place(alice)
  const second = place(bob)
  pay(alice, first)
  const cancelledAt = advance(MINUTE)
  ok(bob, 'POST', `/orders/${second}/cancel`)
  expectAudit(first, [{ from: 'pending', to: 'paid', at: START }])
  expectAudit(second, [{ from: 'pending', to: 'cancelled', at: cancelledAt }])
})
