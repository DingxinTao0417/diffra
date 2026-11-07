import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Router } from 'express'

const run = promisify(execFile)

export const healthRouter = Router()

healthRouter.get('/', async (_req, res) => {
  const { stdout } = await run('git', ['rev-parse', '--short', 'HEAD'], { timeout: 5000 })
  res.json({ ok: true, version: stdout.trim() })
})
