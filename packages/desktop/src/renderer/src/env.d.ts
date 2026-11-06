import type { DiffraApi } from '../../shared/ipc'

declare global {
  interface Window {
    diffra: DiffraApi
  }
}
