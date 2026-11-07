import { Router } from 'express'
import { findProduct, searchProducts } from '../repositories/products.ts'
import { thumbnail } from '../services/images.ts'

export const productsRouter = Router()

productsRouter.get('/search', async (req, res) => {
  const keyword = String(req.query.q ?? '')
  const sort = String(req.query.sort ?? 'name')
  res.json(await searchProducts(keyword, sort))
})

productsRouter.get('/:id', async (req, res) => {
  const product = await findProduct(req.params.id)
  if (!product) {
    res.status(404).json({ error: '商品不存在' })
    return
  }
  res.json(product)
})

productsRouter.get('/:id/thumbnail', async (req, res) => {
  const product = await findProduct(req.params.id)
  if (!product) {
    res.status(404).json({ error: '商品不存在' })
    return
  }
  const size = String(req.query.size ?? '200x200')
  res.sendFile(await thumbnail(product.id, size))
})
