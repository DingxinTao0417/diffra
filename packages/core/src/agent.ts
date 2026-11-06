import * as acp from '@agentclientprotocol/sdk'
import { CORE_VERSION } from './version.js'

export const AGENT_NAME = 'diffra-core'

export function createAgent(): acp.AgentApp {
  return acp.agent({ name: AGENT_NAME }).onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {},
    agentInfo: { name: AGENT_NAME, version: CORE_VERSION },
  }))
}
