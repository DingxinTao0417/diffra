import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chargeOrder } from '../src/payment.ts'

const order = { id: 'order-42', userId: 'user-7', amountCents: 9900 }

function recordingLogger() {
  const errors: Array<{ message: string; context?: Record<string, unknown> }> = []
  const logger = {
    info: () => {},
    error: (message: string, context?: Record<string, unknown>) => {
      errors.push({ message, context })
    },
  }
  return { logger, errors }
}

const isOriginal = (value: unknown, failure: Error) => value === failure || (value instanceof Error && value.cause === failure)

test('支付成功不记错误日志', async () => {
  const { logger, errors } = recordingLogger()
  assert.equal(await chargeOrder({ charge: async () => ({ transactionId: 'tx-1' }) }, logger, order), 'tx-1')
  assert.equal(errors.length, 0)
})

test('支付失败时把原始错误抛给调用方，不吞掉', async () => {
  const failure = new Error('gateway timeout')
  const { logger } = recordingLogger()
  await assert.rejects(
    chargeOrder({ charge: async () => Promise.reject(failure) }, logger, order),
    (error: unknown) => isOriginal(error, failure),
  )
})

test('支付失败记 error 日志，带订单号和原始错误对象', async () => {
  const failure = new Error('gateway timeout')
  const { logger, errors } = recordingLogger()
  await chargeOrder({ charge: async () => Promise.reject(failure) }, logger, order).catch(() => null)
  assert.ok(errors.length >= 1, '没有记 error 日志')
  const complete = errors.some(({ message, context }) => {
    const values = Object.values(context ?? {})
    const hasOrderId = message.includes(order.id) || values.includes(order.id)
    return hasOrderId && values.some((value) => isOriginal(value, failure))
  })
  assert.ok(complete, `日志里要有订单号和原始错误对象：${JSON.stringify(errors.map(({ message, context }) => ({ message, keys: Object.keys(context ?? {}) })))}`)
})
