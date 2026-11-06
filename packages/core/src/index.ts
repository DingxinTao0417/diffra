import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { createAgent } from './agent.js'

createAgent().connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
