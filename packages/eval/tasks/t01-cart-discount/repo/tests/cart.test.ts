import assert from 'node:assert/strict'
import { test } from 'node:test'
import { subtotal } from '../src/cart.ts'

test('小计是单价乘数量之和', () => {
  assert.equal(
    subtotal([
      { sku: 'book', unitPriceCents: 1999, quantity: 2 },
      { sku: 'pen', unitPriceCents: 500, quantity: 1 },
    ]),
    4498,
  )
})

test('空购物车小计为 0', () => {
  assert.equal(subtotal([]), 0)
})
