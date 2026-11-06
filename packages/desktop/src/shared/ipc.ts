export const IPC_CHANNELS = {
  coreStatus: 'core:status',
} as const

export type CoreStatus =
  | { state: 'connected'; agentName: string; agentVersion: string; protocolVersion: number }
  | { state: 'failed'; error: string }

export interface DiffraApi {
  getCoreStatus(): Promise<CoreStatus>
}
