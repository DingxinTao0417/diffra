import * as acp from '@agentclientprotocol/sdk'
import { z } from 'zod'
import { listModels, testModel } from './models/operations.js'
import { EXT_METHODS, PROTOCOLS } from './models/types.js'
import { CORE_VERSION } from './version.js'

export const AGENT_NAME = 'diffra-core'

const endpointSchema = z.object({
  protocol: z.enum(PROTOCOLS),
  baseUrl: z.url({ protocol: /^https?$/ }),
  apiKey: z.string().min(1),
})

export function createAgent(): acp.AgentApp {
  return acp
    .agent({ name: AGENT_NAME })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {},
      agentInfo: { name: AGENT_NAME, version: CORE_VERSION },
    }))
    .onRequest(EXT_METHODS.listModels, z.object({ endpoint: endpointSchema }), ({ params }) =>
      listModels(params.endpoint),
    )
    .onRequest(
      EXT_METHODS.testModel,
      z.object({ endpoint: endpointSchema, modelId: z.string().min(1) }),
      ({ params }) => testModel(params.endpoint, params.modelId),
    )
}
