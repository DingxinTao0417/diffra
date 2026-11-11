import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { createAgent } from './agent.js'
import { ACP_MAX_MESSAGE_BYTES } from './protocol.js'

// 桌面端启动 core 时通过环境变量告诉它会话记录、用量记录和架构分析的数据放在哪
createAgent({
  sessionsDir: process.env.DIFFRA_SESSIONS_DIR || null,
  usageDir: process.env.DIFFRA_USAGE_DIR || null,
  architectureDir: process.env.DIFFRA_ARCHITECTURE_DIR || null,
}).connect(
  acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin), { maxMessageBytes: ACP_MAX_MESSAGE_BYTES }),
)
