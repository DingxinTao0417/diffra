import { Router } from 'express'
import type { AuthedRequest } from '../auth.ts'
import { saveAvatar } from '../services/avatar.ts'

export const avatarRouter = Router()

// 用户填一张图片的网址作为头像
avatarRouter.post('/from-url', async (req: AuthedRequest, res) => {
  const url = String(req.body.url ?? '')
  res.json({ avatar: await saveAvatar(req.user!.id, url) })
})
