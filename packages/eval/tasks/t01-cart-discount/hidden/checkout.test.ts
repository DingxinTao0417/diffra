import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkout } from '../src/cart.ts'

// 小计 10050
const items = [
  { sku: 'book', unitPriceCents: 4500, quantity: 2 },
  { sku: 'pen', unitPriceCents: 1050, quantity: 1 },
]

test('没有券时应付等于小计', () => {
  assert.deepEqual(checkout(items, []), { subtotalCents: 10050, discountCents: 0, totalCents: 10050 })
})

test('满减券达到门槛才生效，等于门槛也算', () => {
  assert.deepEqual(checkout(items, [{ kind: 'threshold', thresholdCents: 10000, offCents: 1500 }]), { subtotalCents: 10050, discountCents: 1500, totalCents: 8550 })
  assert.equal(checkout(items, [{ kind: 'threshold', thresholdCents: 10050, offCents: 1500 }]).totalCents, 8550)
  assert.equal(checkout(items, [{ kind: 'threshold', thresholdCents: 10051, offCents: 1500 }]).totalCents, 10050)
})

test('多张满减券只用能用的里面优惠最多的一张', () => {
  const coupons = [
    { kind: 'threshold' as const, thresholdCents: 10000, offCents: 1500 },
    { kind: 'threshold' as const, thresholdCents: 5000, offCents: 2000 },
    { kind: 'threshold' as const, thresholdCents: 20000, offCents: 5000 },
  ]
  assert.equal(checkout(items, coupons).totalCents, 8050)
})

test('折扣券在满减后的金额上打折，省下的金额向下取整到分', () => {
  const result = checkout(items, [
    { kind: 'threshold', thresholdCents: 10000, offCents: 1500 },
    { kind: 'percent', percentOff: 15 },
  ])
  // 8550 * 15% = 1282.5，向下取整为 1282
  assert.deepEqual(result, { subtotalCents: 10050, discountCents: 2782, totalCents: 7268 })
})

test('多张折扣券只用折扣最大的一张', () => {
  const result = checkout(items, [
    { kind: 'percent', percentOff: 10 },
    { kind: 'percent', percentOff: 25 },
  ])
  // 10050 * 25% = 2512.5，向下取整为 2512
  assert.deepEqual(result, { subtotalCents: 10050, discountCents: 2512, totalCents: 7538 })
})

test('应付金额最低为 0', () => {
  const result = checkout(items, [
    { kind: 'threshold', thresholdCents: 100, offCents: 20000 },
    { kind: 'percent', percentOff: 50 },
  ])
  assert.deepEqual(result, { subtotalCents: 10050, discountCents: 10050, totalCents: 0 })
})

test('数量或单价不合法时抛 RangeError', () => {
  const invalid = [
    { sku: 'x', unitPriceCents: 100, quantity: 0 },
    { sku: 'x', unitPriceCents: 100, quantity: -1 },
    { sku: 'x', unitPriceCents: 100, quantity: 1.5 },
    { sku: 'x', unitPriceCents: -1, quantity: 1 },
    { sku: 'x', unitPriceCents: 19.99, quantity: 1 },
  ]
  for (const item of invalid) {
    assert.throws(() => checkout([item], []), RangeError, JSON.stringify(item))
  }
})
