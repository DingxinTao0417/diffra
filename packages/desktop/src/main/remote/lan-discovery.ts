import { createSocket, type Socket } from 'node:dgram'
import { z } from 'zod'
import { isPrivateAddress } from './lan-tls.ts'

// 局域网设备连接（v2 · M6）的发现：开着「允许连接本机」的设备每 3 秒在局域网里报一次自己（UDP 组播加广播，一条 JSON），
// 别的设备收到就列出来；12 秒没再听到就当它走了。只认私有地址发来的。这只是「谁在」：报的内容谁都能冒充，
// 真正认人靠配对时核对、记住的证书指纹（见 lan-transport.ts）。不引 Electron，scripts/lan.test.ts 直接测

export const DISCOVERY_PORT = 47913
const MULTICAST_GROUP = '239.255.77.77'
const ANNOUNCE_MS = 3000
const EXPIRE_MS = 12_000
const MAX_DEVICES = 64
const MAX_PACKET_BYTES = 1024

const announcementSchema = z.object({
  t: z.literal('diffra-lan'),
  v: z.literal(1),
  id: z.string().regex(/^[0-9a-f]{32}$/),
  name: z.string().trim().min(1).max(60),
  port: z.number().int().min(1).max(65535),
  tls: z.string().regex(/^[0-9a-f]{64}$/),
  // 正在等配对（本机的人生成了配对码）
  pairing: z.boolean(),
})

export type Announcement = Omit<z.infer<typeof announcementSchema>, 't' | 'v'>

export interface DiscoveredDevice extends Announcement {
  address: string
  seenAt: number
}

export interface LanDiscoveryOptions {
  port: number
  // 监听的地址：平时 0.0.0.0；测试用 127.0.0.1，不惊动防火墙
  bind: string
  // 除了组播、广播再单独发给这些地址（测试里同一台机器上的两个实例各听一个端口）
  targets: Array<{ address: string; port: number }>
  // 测试时不发组播、广播
  broadcast: boolean
  self(): string | null
  // 这时候要报什么；null 是不报（没开「允许连接本机」）
  announcement(): Announcement | null
  changed(): void
}

export class LanDiscovery {
  private socket: Socket | null = null
  private timer: NodeJS.Timeout | null = null
  private readonly devices = new Map<string, DiscoveredDevice>()
  private readonly options: LanDiscoveryOptions

  constructor(options: LanDiscoveryOptions) {
    this.options = options
  }

  start(): void {
    if (this.socket) return
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    this.socket = socket
    socket.on('error', (error) => console.error('[lan] 发现服务出错', error))
    socket.on('message', (message, info) => this.receive(message, info.address))
    socket.bind(this.options.port, this.options.bind, () => {
      if (this.options.broadcast) {
        socket.setBroadcast(true)
        try {
          socket.addMembership(MULTICAST_GROUP)
        } catch (error) {
          console.warn('[lan] 加不进组播组，只用广播', error)
        }
      }
      this.announce()
    })
    this.timer = setInterval(() => {
      this.announce()
      this.expire()
    }, ANNOUNCE_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.socket?.close()
    this.socket = null
    this.devices.clear()
  }

  // 现在就报一次（打开总开关、生成配对码之后，不用等下一轮）
  announce(): void {
    const socket = this.socket
    const announcement = this.options.announcement()
    if (!socket || !announcement) return
    const packet = Buffer.from(JSON.stringify({ t: 'diffra-lan', v: 1, ...announcement }), 'utf8')
    const send = (address: string, port: number) => socket.send(packet, port, address, (error) => error && console.warn(`[lan] 发给 ${address}:${port} 失败`, error.message))
    try {
      if (this.options.broadcast) {
        send(MULTICAST_GROUP, this.options.port)
        send('255.255.255.255', this.options.port)
      }
      for (const target of this.options.targets) send(target.address, target.port)
    } catch (error) {
      console.warn('[lan] 发不出发现消息', error)
    }
  }

  private receive(message: Buffer, address: string): void {
    if (message.length > MAX_PACKET_BYTES || !isPrivateAddress(address)) return
    let parsed: z.infer<typeof announcementSchema>
    try {
      parsed = announcementSchema.parse(JSON.parse(message.toString('utf8')))
    } catch {
      return
    }
    if (parsed.id === this.options.self()) return
    if (!this.devices.has(parsed.id) && this.devices.size >= MAX_DEVICES) return
    const previous = this.devices.get(parsed.id)
    const { t: _t, v: _v, ...announcement } = parsed
    const next: DiscoveredDevice = { ...announcement, address, seenAt: Date.now() }
    this.devices.set(parsed.id, next)
    if (!previous || previous.address !== next.address || previous.port !== next.port || previous.name !== next.name || previous.pairing !== next.pairing || previous.tls !== next.tls) this.options.changed()
  }

  private expire(): void {
    let changed = false
    for (const [id, device] of this.devices) {
      if (Date.now() - device.seenAt <= EXPIRE_MS) continue
      this.devices.delete(id)
      changed = true
    }
    if (changed) this.options.changed()
  }

  list(): DiscoveredDevice[] {
    return [...this.devices.values()].filter((device) => Date.now() - device.seenAt <= EXPIRE_MS)
  }

  get(id: string): DiscoveredDevice | null {
    const device = this.devices.get(id)
    return device && Date.now() - device.seenAt <= EXPIRE_MS ? device : null
  }
}
