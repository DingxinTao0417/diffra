import type { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import { config } from './config.ts'

export interface AuthedRequest extends Request {
  user?: { id: string; role: 'customer' | 'admin' }
}

export function requireLogin(req: AuthedRequest, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.replace(/^Bearer /, '')
  if (!token) {
    res.status(401).json({ error: '请先登录' })
    return
  }
  try {
    req.user = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as AuthedRequest['user']
    next()
  } catch {
    res.status(401).json({ error: '登录已过期' })
  }
}
