import type { OrderStore } from './orders.ts'

export interface CurrentUser {
  id: string
  role: 'customer' | 'admin'
}

export interface Request {
  method: string
  path: string
  // 登录中间件解析出的当前用户；没登录是 null
  user: CurrentUser | null
}

export interface Response {
  status: number
  body: unknown
}

export function createHandler(store: OrderStore) {
  return (request: Request): Response => {
    if (!request.user) return { status: 401, body: { error: '请先登录' } }
    if (request.method === 'GET' && request.path === '/orders') {
      const orders = request.user.role === 'admin' ? store.all() : store.byOwner(request.user.id)
      return { status: 200, body: orders.map(({ id, totalCents }) => ({ id, totalCents })) }
    }
    return { status: 404, body: { error: '接口不存在' } }
  }
}
