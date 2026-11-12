import assert from 'node:assert/strict'
import { test } from 'node:test'
import { admin, alice, setup } from './helpers.ts'

test('客服可以手动把订单改成任意状态，不管流转规则', () => {
  const { call, place } = setup()
  const id = place(alice, [{ sku: 'MUG', quantity: 1 }])
  const response = call(admin, 'POST', `/admin/orders/${id}/status`, { status: 'delivered' })
  assert.equal(response.status, 200)
  assert.equal((response.body as { status: string }).status, 'delivered')
  assert.equal((call(alice, 'GET', `/orders/${id}`).body as { status: string }).status, 'delivered')
})

test('手动改状态要管理员权限，状态名不对返回 400', () => {
  const { call, place } = setup()
  const id = place(alice, [{ sku: 'MUG', quantity: 1 }])
  assert.equal(call(alice, 'POST', `/admin/orders/${id}/status`, { status: 'paid' }).status, 403)
  assert.equal(call(admin, 'POST', `/admin/orders/${id}/status`, { status: 'refunded' }).status, 400)
  assert.equal(call(admin, 'POST', '/admin/orders/ord_404/status', { status: 'paid' }).status, 404)
})

test('审计查询接口：刚下的订单还没有状态变化', () => {
  const { call, place } = setup()
  const id = place(alice, [{ sku: 'MUG', quantity: 1 }])
  assert.deepEqual(call(admin, 'GET', `/admin/orders/${id}/audit`), { status: 200, body: [] })
  assert.equal(call(alice, 'GET', `/admin/orders/${id}/audit`).status, 403)
  assert.equal(call(admin, 'GET', '/admin/orders/ord_404/audit').status, 404)
})
