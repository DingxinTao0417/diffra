import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chargeOrder } from '../src/payment.ts'

test('支付成功返回交易号并记日志', async () => {
  const infos: unknown[] = []
  const logger = { info: (message: string, context?: Record<string, unknown>) => infos.push({ message, context }), error: () => {} }
  const transactionId = await chargeOrder({ charge: async () => ({ transactionId: 'tx-1' }) }, logger, { id: 'order-1', userId: 'user-1', amountCents: 100 })
  assert.equal(transactionId, 'tx-1')
  assert.deepEqual(infos, [{ message: '支付成功', context: { orderId: 'order-1', transactionId: 'tx-1' } }])
})
