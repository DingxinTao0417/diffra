import type { UserService } from './user-service.ts'

export interface Request {
  method: string
  path: string
  query: Record<string, string | undefined>
}

export interface Response {
  status: number
  body: unknown
}

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export function createHandler(service: UserService) {
  return (request: Request): Response => {
    const byId = /^\/users\/([^/]+)$/.exec(request.path)
    if (request.method === 'GET' && byId) {
      const user = service.getUser(decodeURIComponent(byId[1] ?? ''))
      return user ? { status: 200, body: user } : { status: 404, body: { error: '用户不存在' } }
    }
    if (request.method === 'GET' && request.path === '/users') {
      const email = request.query.email?.trim() ?? ''
      if (!EMAIL_PATTERN.test(email)) return { status: 400, body: { error: '邮箱格式不对' } }
      const user = service.findUserByEmail(email)
      return user ? { status: 200, body: user } : { status: 404, body: { error: '用户不存在' } }
    }
    return { status: 404, body: { error: '接口不存在' } }
  }
}
