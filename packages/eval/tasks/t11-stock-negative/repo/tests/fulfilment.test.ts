import assert from 'node:assert/strict'
import { test } from 'node:test'
import { admin, alice, DAY, MINUTE, setup } from './helpers.ts'

test('发货出库：实物减少，占用结清', () => {
  const { call, place, pay, stockOf } = setup()
  const id = place(alice, [{ sku: 'MUG', quantity: 3 }])
  assert.equal(call(admin, 'POST', `/admin/orders/${id}/ship`).status, 409)
  pay(alice, id)
  const response = call(admin, 'POST', `/admin/orders/${id}/ship`, { carrier: 'YTO' })
  assert.equal(response.status, 200)
  assert.equal((response.body as { trackingNo: string }).trackingNo, 'YTO-trk_1')
  assert.deepEqual(stockOf('MUG'), { sku: 'MUG', onHand: 7, reserved: 0, available: 7 })
  assert.equal(call(alice, 'POST', `/orders/${id}/cancel`).status, 409)
})

test('签收后 7 天内退货入库', () => {
  const { clock, call, place, pay, stockOf } = setup()
  const id = place(alice, [{ sku: 'MUG', quantity: 3 }])
  pay(alice, id)
  call(admin, 'POST', `/admin/orders/${id}/ship`)
  assert.equal(call(admin, 'POST', `/admin/orders/${id}/return`).status, 409)
  assert.equal(call(admin, 'POST', `/admin/orders/${id}/deliver`).status, 200)
  clock.advance(6 * DAY)
  const response = call(admin, 'POST', `/admin/orders/${id}/return`)
  assert.equal((response.body as { status: string }).status, 'returned')
  assert.deepEqual(stockOf('MUG'), { sku: 'MUG', onHand: 10, reserved: 0, available: 10 })
})

test('超过 7 天不能退货', () => {
  const { clock, call, place, pay } = setup()
  const id = place(alice, [{ sku: 'MUG', quantity: 1 }])
  pay(alice, id)
  call(admin, 'POST', `/admin/orders/${id}/ship`)
  call(admin, 'POST', `/admin/orders/${id}/deliver`)
  clock.advance(7 * DAY + 1)
  assert.equal(call(admin, 'POST', `/admin/orders/${id}/return`).status, 409)
})

test('超过 30 分钟没付款的订单自动取消，付了款的不动', () => {
  const { app, clock, call, place, pay, stockOf } = setup()
  const unpaid = place(alice, [{ sku: 'MUG', quantity: 2 }])
  const paid = place(alice, [{ sku: 'MUG', quantity: 1 }])
  pay(alice, paid)
  clock.advance(29 * MINUTE)
  assert.deepEqual(call(admin, 'POST', '/admin/jobs/expire-unpaid').body, { expired: 0 })
  clock.advance(MINUTE)
  assert.deepEqual(call(admin, 'POST', '/admin/jobs/expire-unpaid').body, { expired: 1 })
  assert.equal(app.orders.require(unpaid).status, 'cancelled')
  assert.equal(app.orders.require(paid).status, 'paid')
  assert.deepEqual(stockOf('MUG'), { sku: 'MUG', onHand: 10, reserved: 1, available: 9 })
  assert.equal(app.outbox.forCustomer(alice.id).at(-1)?.subject, '订单已取消')
})

test('库存偏低的商品出现在补货看板里', () => {
  const { call, place } = setup()
  place(alice, [{ sku: 'TEE', quantity: 3 }])
  const alerts = call(admin, 'GET', '/admin/low-stock').body as Array<{ sku: string; available: number }>
  assert.deepEqual(alerts.map(({ sku, available }) => ({ sku, available })), [{ sku: 'TEE', available: 2 }])
})
