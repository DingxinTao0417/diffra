import type { FrameKind } from '@diffra/relay/protocol'
import type { RemoteRelayStatus } from '../../shared/remote'

// 设备之间收发帧的那一层：v1 经中转（relay-client.ts，已下线），v2 在局域网里直连（lan-transport.ts）。
// 配对、加密通道、同步都只用这里的几样：发帧、谁在线、会合点（配对用）、状态

export interface TransportEvents {
  status(status: RemoteRelayStatus): void
  presence(deviceId: string, online: boolean): void
  frame(kind: FrameKind, from: string, payload: Buffer): void
  undeliverable(to: string): void
  rendezvous(id: string, opened: boolean): void
}

export interface RemoteTransport {
  readonly state: RemoteRelayStatus
  isOnline(deviceId: string): boolean
  start(): void
  stop(): void
  // 整份替换：会和哪些设备互通
  setAllow(peers: string[]): void
  openRendezvous(id: string, expiresAt: number): void
  closeRendezvous(id: string): void
  // 发不出去返回 false（没连上、积压太多）
  send(kind: FrameKind, to: string, payload: Uint8Array): boolean
  waitOnline(timeoutMs: number): Promise<void>
}
