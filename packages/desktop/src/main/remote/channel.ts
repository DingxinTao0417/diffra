import { encodeMessage, MessageAssembler, type Transport } from '@diffra/remote'

// 两台设备之间直发帧的第一个字节：配对时被连接端的回信、会话通道的握手和数据。
// 会话通道按方向各一条：A 看 B 的会话（A 是连接端，B 是被连接端）和 B 看 A 的互不相干，两台设备可以同时互相看
export const DIRECT = { pairing: 0, open: 1, accept: 2, toHost: 3, toGuest: 4 } as const

export function withKind(kind: number, payload: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from([kind]), payload])
}

// 握手之后的加密通道：一条消息切片、每片加密成一条 Noise 消息，经中转发出去（发法由调用方给）。
// 收到的片解密后拼回消息，返回解析出的 JSON（还没校验），没拼齐返回 undefined。解密、拼装出错就抛错，调用方丢掉这条通道
export class SecureChannel {
  private readonly assembler = new MessageAssembler()

  constructor(
    private readonly transport: Transport,
    private readonly sendFrame: (payload: Uint8Array) => boolean,
  ) {}

  // 大的（快照分页）压缩后再发
  send(message: unknown, options: { compress?: boolean } = {}): boolean {
    for (const chunk of encodeMessage(message, options)) if (!this.sendFrame(this.transport.encrypt(chunk))) return false
    return true
  }

  receive(payload: Uint8Array): unknown {
    return this.assembler.push(this.transport.decrypt(payload))
  }
}
