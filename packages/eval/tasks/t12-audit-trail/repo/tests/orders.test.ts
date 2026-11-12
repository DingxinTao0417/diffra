import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computeTotals } from '../src/orders/order-totals.ts'
import { admin, alice, bob, setup } from './helpers.ts'

test('下单：算好金额，占住库存，发通知', () => {
  const { app, call, stockOf } = setup()
  const response = call(alice, 'POST', '/orders', { items: [{ sku: 'MUG', quantity: 2 }] })
  assert.equal(response.status, 201)
  const order = response.body as { id: string; status: string; subtotalCents: number; shippingFeeCents: number; totalCents: number }
  assert.equal(order.status, 'pending')
  assert.deepEqual([order.subtotalCents, order.shippingFeeCents, order.totalCents], [7800, 800, 8600])
  assert.deepEqual(stockOf('MUG'), { sku: 'MUG', onHand: 10, reserved: 2, available: 8 })
  assert.deepEqual(app.outbox.forCustomer(alice.id).map((message) => message.subject), ['订单已提交'])
})

test('满 99 元包邮', () => {
  assert.deepEqual(computeTotals([{ sku: 'TEE', quantity: 1, unitPriceCents: 12900 }]), { subtotalCents: 12900, shippingFeeCents: 0, totalCents: 12900 })
})

test('库存不够整单失败，一件都不占', () => {
  const { call, stockOf } = setup()
  const response = call(alice, 'POST', '/orders', { items: [{ sku: 'MUG', quantity: 1 }, { sku: 'TEE', quantity: 6 }] })
  assert.equal(response.status, 409)
  assert.deepEqual(stockOf('MUG'), { sku: 'MUG', onHand: 10, reserved: 0, available: 10 })
  assert.deepEqual(stockOf('TEE'), { sku: 'TEE', onHand: 5, reserved: 0, available: 5 })
})

test('请求不对返回 400', () => {
  const { call } = setup()
  assert.equal(call(alice, 'POST', '/orders', { items: [] }).status, 400)
  assert.equal(call(alice, 'POST', '/orders', { items: [{ sku: 'MUG', quantity: 0 }] }).status, 400)
  assert.equal(call(alice, 'POST', '/orders', { items: [{ sku: 'NOPE', quantity: 1 }] }).status, 400)
  assert.equal(call(null, 'POST', '/orders', { items: [{ sku: 'MUG', quantity: 1 }] }).status, 401)
})

test('付款后订单变成已付款；拒付时还是待付款', () => {
  const { call, place } = setup()
  const id = place(alice, [{ sku: 'MUG', quantity: 1 }])
  assert.equal(call(alice, 'POST', `/orders/${id}/pay`, { token: 'tok_declined' }).status, 402)
  assert.equal((call(alice, 'GET', `/orders/${id}`).body as { status: string }).status, 'pending')
  assert.equal(call(alice, 'POST', `/orders/${id}/pay`, { token: 'tok_ok' }).status, 200)
  assert.equal((call(alice, 'GET', `/orders/${id}`).body as { status: string }).status, 'paid')
})

test('买家取消还没付款的订单，库存放回', () => {
  const { call, place, stockOf } = setup()
  const id = place(alice, [{ sku: 'MUG', quantity: 3 }])
  const response = call(alice, 'POST', `/orders/${id}/cancel`)
  assert.equal(response.status, 200)
  assert.equal((response.body as { status: string }).status, 'cancelled')
  assert.deepEqual(stockOf('MUG'), { sku: 'MUG', onHand: 10, reserved: 0, available: 10 })
})

test('别人的订单看不到也取消不了，管理员可以', () => {
  const { call, place } = setup()
  const id = place(alice, [{ sku: 'MUG', quantity: 1 }])
  assert.equal(call(bob, 'GET', `/orders/${id}`).status, 404)
  assert.equal(call(bob, 'POST', `/orders/${id}/cancel`).status, 404)
  assert.equal(call(admin, 'GET', `/orders/${id}`).status, 200)
})
