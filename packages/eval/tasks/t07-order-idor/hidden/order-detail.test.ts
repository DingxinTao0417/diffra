import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHandler } from '../src/handlers.ts'
import { OrderStore } from '../src/orders.ts'

const ALICE_ADDRESS = '上海市徐汇区某路 1 号'

function setup() {
  const store = new OrderStore()
  store.add({ id: 'o1', ownerId: 'alice', items: [{ sku: 'book', quantity: 1 }], totalCents: 4500, shippingAddress: ALICE_ADDRESS })
  store.add({ id: 'o2', ownerId: 'bob', items: [{ sku: 'pen', quantity: 3 }], totalCents: 1200, shippingAddress: '北京市海淀区某路 2 号' })
  return createHandler(store)
}

const alice = { id: 'alice', role: 'customer' as const }
const bob = { id: 'bob', role: 'customer' as const }

test('自己的订单返回 200 和全部字段', () => {
  const response = setup()({ method: 'GET', path: '/orders/o1', user: alice })
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { id: 'o1', ownerId: 'alice', items: [{ sku: 'book', quantity: 1 }], totalCents: 4500, shippingAddress: ALICE_ADDRESS })
})

test('别人的订单看不到', () => {
  const response = setup()({ method: 'GET', path: '/orders/o1', user: bob })
  assert.ok(response.status === 403 || response.status === 404, `状态码是 ${response.status}`)
  assert.ok(!JSON.stringify(response.body).includes(ALICE_ADDRESS), '响应里带了别人的收货地址')
})

test('没登录返回 401', () => {
  assert.equal(setup()({ method: 'GET', path: '/orders/o1', user: null }).status, 401)
})

test('订单不存在返回 404', () => {
  assert.equal(setup()({ method: 'GET', path: '/orders/o999', user: alice }).status, 404)
})

test('订单列表不受影响', () => {
  const response = setup()({ method: 'GET', path: '/orders', user: bob })
  assert.deepEqual(response.body, [{ id: 'o2', totalCents: 1200 }])
})
