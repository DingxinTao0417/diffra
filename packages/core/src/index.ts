import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { createAgent } from './agent.js'

// 桌面端启动 core 时通过环境变量告诉它会话记录和用量记录放在哪
createAgent({ sessionsDir: process.env.DIFFRA_SESSIONS_DIR || null, usageDir: process.env.DIFFRA_USAGE_DIR || null }).connect(
  acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
)
