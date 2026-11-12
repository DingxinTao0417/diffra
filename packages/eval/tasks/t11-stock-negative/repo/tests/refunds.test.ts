import assert from 'node:assert/strict'
import { test } from 'node:test'
import { admin, alice, setup } from './helpers.ts'

test('没发货就全额退款：库存放回，这单不能再发货', () => {
  const { call, place, pay, stockOf } = setup()
  const id = place(alice, [{ sku: 'MUG', quantity: 3 }])
  pay(alice, id)
  const response = call(admin, 'POST', `/admin/orders/${id}/refund`)
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { orderId: id, amountCents: 11700, refundedCents: 11700, status: 'refunded', gatewayRef: 'ch_1', capturedAt: Date.UTC(2026, 0, 5, 2, 0, 0) })
  assert.deepEqual(stockOf('MUG'), { sku: 'MUG', onHand: 10, reserved: 0, available: 10 })
  assert.equal(call(admin, 'POST', `/admin/orders/${id}/ship`).status, 409)
})

test('部分退款不动库存', () => {
  const { call, place, pay, stockOf } = setup()
  const id = place(alice, [{ sku: 'MUG', quantity: 3 }])
  pay(alice, id)
  const response = call(admin, 'POST', `/admin/orders/${id}/refund`, { amountCents: 3900 })
  assert.equal((response.body as { status: string }).status, 'partially_refunded')
  assert.deepEqual(stockOf('MUG'), { sku: 'MUG', onHand: 10, reserved: 3, available: 7 })
})

test('退款金额不能超过还没退的部分，没付款的订单不能退', () => {
  const { call, place, pay } = setup()
  const id = place(alice, [{ sku: 'MUG', quantity: 3 }])
  assert.equal(call(admin, 'POST', `/admin/orders/${id}/refund`).status, 409)
  pay(alice, id)
  assert.equal(call(admin, 'POST', `/admin/orders/${id}/refund`, { amountCents: 11701 }).status, 400)
  assert.equal(call(alice, 'POST', `/admin/orders/${id}/refund`).status, 403)
})

test('退款会通知买家', () => {
  const { app, call, place, pay } = setup()
  const id = place(alice, [{ sku: 'TEE', quantity: 1 }])
  pay(alice, id)
  call(admin, 'POST', `/admin/orders/${id}/refund`, { amountCents: 2900 })
  const last = app.outbox.forCustomer(alice.id).at(-1)
  assert.equal(last?.subject, '已部分退款')
  assert.match(last?.body ?? '', /¥29\.00/)
})
