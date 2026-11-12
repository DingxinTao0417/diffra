import { AppError, forbidden } from '../shared/errors.ts'

export interface CurrentUser {
  id: string
  role: 'customer' | 'admin'
}

export interface Request {
  method: string
  path: string
  body?: unknown
  // 登录中间件解析出的当前用户；没登录是 null
  user: CurrentUser | null
}

export interface Response {
  status: number
  body: unknown
}

// id 是路径里的第一个参数（订单号、商品编号），没有就是空串
export type RouteHandler = (context: { user: CurrentUser; id: string; body: Record<string, unknown> }) => Response

export class Router {
  private readonly routes: Array<{ method: string; pattern: RegExp; handler: RouteHandler }> = []

  add(method: string, pattern: RegExp, handler: RouteHandler): void {
    this.routes.push({ method, pattern, handler })
  }

  handle(request: Request): Response {
    if (!request.user) return { status: 401, body: { error: '请先登录' } }
    for (const route of this.routes) {
      const match = route.method === request.method ? route.pattern.exec(request.path) : null
      if (!match) continue
      const body = typeof request.body === 'object' && request.body !== null ? (request.body as Record<string, unknown>) : {}
      try {
        return route.handler({ user: request.user, id: decodeURIComponent(match[1] ?? ''), body })
      } catch (error) {
        if (error instanceof AppError) return { status: error.status, body: { error: error.message, code: error.code } }
        throw error
      }
    }
    return { status: 404, body: { error: '接口不存在' } }
  }
}

export function requireAdmin(user: CurrentUser): void {
  if (user.role !== 'admin') throw forbidden('需要管理员权限')
}
