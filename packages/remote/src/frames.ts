import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { NOISE_MAX_PAYLOAD } from './noise.js'

// 一条应用消息（JSON）切成若干片，每片单独加密成一条 Noise 传输消息。片头 1 字节：
// 最低位表示最后一片，次低位表示整条消息先压缩过。Noise 保证顺序和完整，一条消息的片连着发，不和别的消息交错。
// 只压缩快照分页这类大消息：先压缩再加密会泄露长度，服务器又要能往内容里注入东西、反复观察才利用得上（见 docs/decisions.md「设备连接」）

const FINAL = 0b01
const DEFLATED = 0b10
// 片头之外再留 1 字节：桌面端在每条加密后的片前面加 1 字节通道种类，中转帧再加 1 字节类型和 16 字节 ID，合起来不能超过中转的单帧上限（1 + 16 + 65535）。
// 不留时整片的帧多 1 字节，中转直接断开发送方整条连接（第 387 步）
const CHUNK_DATA = NOISE_MAX_PAYLOAD - 2
// 一条消息拼起来（压缩的按压缩后算）和解压后最多多大；超过就断开
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024
export const MAX_INFLATED_BYTES = 32 * 1024 * 1024

export class FrameError extends Error {}

export function encodeMessage(value: unknown, options: { compress?: boolean } = {}): Uint8Array[] {
  const json = Buffer.from(JSON.stringify(value), 'utf8')
  const data = options.compress ? deflateRawSync(json) : json
  if (data.length > MAX_MESSAGE_BYTES) throw new FrameError('消息太大，要分页发')
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset === 0 || offset < data.length; offset += CHUNK_DATA) {
    const piece = data.subarray(offset, offset + CHUNK_DATA)
    const flags = (offset + CHUNK_DATA >= data.length ? FINAL : 0) | (options.compress ? DEFLATED : 0)
    chunks.push(Buffer.concat([Buffer.from([flags]), piece]))
  }
  return chunks
}

// 收片拼消息：拼齐一条就返回解析出的 JSON（还没校验），没拼齐返回 undefined。格式不对直接抛错，调用方断开连接
export class MessageAssembler {
  private parts: Buffer[] = []
  private size = 0
  private deflated: boolean | null = null

  push(chunk: Uint8Array): unknown {
    if (chunk.length === 0) throw new FrameError('空的分片')
    const flags = chunk[0]!
    if (flags & ~(FINAL | DEFLATED)) throw new FrameError('不认识的分片标记')
    const deflated = (flags & DEFLATED) !== 0
    if (this.deflated !== null && this.deflated !== deflated) throw new FrameError('同一条消息的分片标记不一致')
    this.deflated = deflated
    this.size += chunk.length - 1
    if (this.size > MAX_MESSAGE_BYTES) throw new FrameError('消息太大')
    this.parts.push(Buffer.from(chunk.subarray(1)))
    if (!(flags & FINAL)) return undefined
    const data = Buffer.concat(this.parts)
    this.parts = []
    this.size = 0
    this.deflated = null
    let json: Buffer
    try {
      json = deflated ? inflateRawSync(data, { maxOutputLength: MAX_INFLATED_BYTES }) : data
    } catch (error) {
      throw new FrameError('消息解压失败或解压后太大', { cause: error })
    }
    try {
      return JSON.parse(json.toString('utf8')) as unknown
    } catch (error) {
      throw new FrameError('消息不是合法的 JSON', { cause: error })
    }
  }
}
