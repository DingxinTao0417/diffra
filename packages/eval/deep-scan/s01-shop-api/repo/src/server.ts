import express from 'express'
import { requireLogin } from './auth.ts'
import { avatarRouter } from './routes/avatar.ts'
import { healthRouter } from './routes/health.ts'
import { ordersRouter } from './routes/orders.ts'
import { productsRouter } from './routes/products.ts'

const app = express()
app.use(express.json({ limit: '100kb' }))

app.use('/health', healthRouter)
app.use('/products', productsRouter)
app.use('/orders', requireLogin, ordersRouter)
app.use('/avatar', requireLogin, avatarRouter)

app.listen(Number(process.env.PORT ?? 3000))
