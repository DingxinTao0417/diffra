import { Router } from 'express'
import type { AuthedRequest } from '../auth.ts'
import { findOrder, listOrders } from '../repositories/orders.ts'

export const ordersRouter = Router()

ordersRouter.get('/', async (req: AuthedRequest, res) => {
  res.json(await listOrders(req.user!.id))
})

ordersRouter.get('/:id', async (req: AuthedRequest, res) => {
  const order = await findOrder(req.params.id)
  if (!order) {
    res.status(404).json({ error: '订单不存在' })
    return
  }
  res.json(order)
})
