import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHandler } from '../src/handlers.ts'
import { OrderStore } from '../src/orders.ts'

function setup() {
  const store = new OrderStore()
  store.add({ id: 'o1', ownerId: 'alice', items: [{ sku: 'book', quantity: 1 }], totalCents: 4500, shippingAddress: '上海市某路 1 号' })
  store.add({ id: 'o2', ownerId: 'bob', items: [{ sku: 'pen', quantity: 3 }], totalCents: 1200, shippingAddress: '北京市某路 2 号' })
  return createHandler(store)
}

test('订单列表只有自己的订单', () => {
  const response = setup()({ method: 'GET', path: '/orders', user: { id: 'alice', role: 'customer' } })
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, [{ id: 'o1', totalCents: 4500 }])
})

test('没登录返回 401', () => {
  assert.equal(setup()({ method: 'GET', path: '/orders', user: null }).status, 401)
})
