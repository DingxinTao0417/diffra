import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, type KeyObject } from 'node:crypto'

// Noise 协议框架（revision 34）里设备连接用到的部分：DH 是 25519，加密是 AES-256-GCM，哈希是 SHA-256。
// Electron 45 的 BoringSSL 没有 ChaCha20-Poly1305，所以选 AESGCM 套件（见 docs/decisions.md「设备连接」）。
// 握手只有两种：配对用 XXpsk3（连接端握手后核对对方长期公钥，凭邀请里的密钥证明自己拿到了邀请），日常用 KK（两边都已知道对方长期公钥）

export type NoisePattern = 'KK' | 'XXpsk3'

const DH_LEN = 32
const HASH_LEN = 32
const TAG_LEN = 16
const PSK_LEN = 32
// Noise 规定一条消息最多 65535 字节
export const NOISE_MAX_MESSAGE = 65_535
export const NOISE_MAX_PAYLOAD = NOISE_MAX_MESSAGE - TAG_LEN
const EMPTY = Buffer.alloc(0)
// 原始 32 字节的 X25519 密钥套上这两个 DER 头就是 PKCS#8 私钥、SPKI 公钥
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex')

type Token = 'e' | 's' | 'ee' | 'es' | 'se' | 'ss' | 'psk'

// preStatic：两边的长期公钥都是预先知道的（先混入发起方的，再混入应答方的）
const PATTERNS: Record<NoisePattern, { preStatic: boolean; messages: Token[][] }> = {
  KK: { preStatic: true, messages: [['e', 'es', 'ss'], ['e', 'ee', 'se']] },
  XXpsk3: { preStatic: false, messages: [['e'], ['e', 'ee', 's', 'es'], ['s', 'se', 'psk']] },
}

export class NoiseError extends Error {}

export interface KeyPair {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

export function generateKeyPair(): KeyPair {
  const { privateKey } = generateKeyPairSync('x25519')
  return keyPairOf(privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-DH_LEN))
}

export function keyPairOf(privateKey: Uint8Array): KeyPair {
  if (privateKey.length !== DH_LEN) throw new NoiseError('X25519 私钥要 32 字节')
  const publicKey = createPublicKey(privateKeyObject(privateKey)).export({ format: 'der', type: 'spki' }).subarray(-DH_LEN)
  return { privateKey: Buffer.from(privateKey), publicKey: Buffer.from(publicKey) }
}

function privateKeyObject(privateKey: Uint8Array): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_X25519, privateKey]), format: 'der', type: 'pkcs8' })
}

function dh(privateKey: Uint8Array, publicKey: Uint8Array): Buffer {
  let shared: Buffer
  try {
    shared = diffieHellman({ privateKey: privateKeyObject(privateKey), publicKey: createPublicKey({ key: Buffer.concat([SPKI_X25519, publicKey]), format: 'der', type: 'spki' }) })
  } catch (error) {
    throw new NoiseError('密钥交换失败', { cause: error })
  }
  // 对方给的是低阶点时结果全是 0，等于没有密钥
  if (shared.every((byte) => byte === 0)) throw new NoiseError('对方的公钥无效')
  return shared
}

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest()
const hmac = (key: Uint8Array, data: Uint8Array) => createHmac('sha256', key).update(data).digest()

// 规范里的 HKDF（只到第三个输出）
function hkdf(chainingKey: Uint8Array, input: Uint8Array): [Buffer, Buffer, Buffer] {
  const tempKey = hmac(chainingKey, input)
  const first = hmac(tempKey, Buffer.from([1]))
  const second = hmac(tempKey, Buffer.concat([first, Buffer.from([2])]))
  return [first, second, hmac(tempKey, Buffer.concat([second, Buffer.from([3])]))]
}

class CipherState {
  private key: Buffer | null = null
  private nonce = 0

  initializeKey(key: Buffer | null): void {
    this.key = key
    this.nonce = 0
  }

  hasKey(): boolean {
    return this.key !== null
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Buffer {
    if (!this.key) return Buffer.from(plaintext)
    const cipher = createCipheriv('aes-256-gcm', this.key, this.nonceBytes())
    cipher.setAAD(ad)
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
    this.nonce++
    return ciphertext
  }

  // 认证失败时计数不加，由调用方作废整条连接
  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Buffer {
    if (!this.key) return Buffer.from(ciphertext)
    if (ciphertext.length < TAG_LEN) throw new NoiseError('消息不完整')
    const decipher = createDecipheriv('aes-256-gcm', this.key, this.nonceBytes())
    decipher.setAAD(ad)
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_LEN))
    let plaintext: Buffer
    try {
      plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_LEN)), decipher.final()])
    } catch (error) {
      throw new NoiseError('解密失败：消息被改过、顺序不对或密钥不对', { cause: error })
    }
    this.nonce++
    return plaintext
  }

  // 96 位：前 32 位是 0，后面是计数的大端 64 位。计数到 2^53 前早该重新握手了
  private nonceBytes(): Buffer {
    if (this.nonce >= Number.MAX_SAFE_INTEGER) throw new NoiseError('这条连接的消息数用完了，要重新握手')
    const bytes = Buffer.alloc(12)
    bytes.writeBigUInt64BE(BigInt(this.nonce), 4)
    return bytes
  }
}

class SymmetricState {
  readonly cipher = new CipherState()
  private chainingKey: Buffer
  hash: Buffer

  constructor(protocolName: string) {
    const name = Buffer.from(protocolName, 'ascii')
    this.hash = name.length <= HASH_LEN ? Buffer.concat([name, Buffer.alloc(HASH_LEN - name.length)]) : sha256(name)
    this.chainingKey = this.hash
  }

  mixKey(input: Uint8Array): void {
    const [chainingKey, key] = hkdf(this.chainingKey, input)
    this.chainingKey = chainingKey
    this.cipher.initializeKey(key)
  }

  mixHash(data: Uint8Array): void {
    this.hash = sha256(Buffer.concat([this.hash, data]))
  }

  mixKeyAndHash(input: Uint8Array): void {
    const [chainingKey, hash, key] = hkdf(this.chainingKey, input)
    this.chainingKey = chainingKey
    this.mixHash(hash)
    this.cipher.initializeKey(key)
  }

  encryptAndHash(plaintext: Uint8Array): Buffer {
    const ciphertext = this.cipher.encryptWithAd(this.hash, plaintext)
    this.mixHash(ciphertext)
    return ciphertext
  }

  decryptAndHash(ciphertext: Uint8Array): Buffer {
    const plaintext = this.cipher.decryptWithAd(this.hash, ciphertext)
    this.mixHash(ciphertext)
    return plaintext
  }

  split(): [CipherState, CipherState] {
    const [first, second] = hkdf(this.chainingKey, EMPTY)
    const sending = new CipherState()
    const receiving = new CipherState()
    sending.initializeKey(first)
    receiving.initializeKey(second)
    return [sending, receiving]
  }
}

export interface HandshakeOptions {
  pattern: NoisePattern
  initiator: boolean
  // 两边要一致，不一致握手失败；协议版本写在这里防降级
  prologue: Uint8Array
  staticKey: KeyPair
  // KK 两边都要给对方的长期公钥；XXpsk3 在握手里拿到，用 remoteStatic() 读
  remoteStatic?: Uint8Array
  // XXpsk3 两边都要给，32 字节
  psk?: Uint8Array
  // 只给测试向量用：固定的临时密钥
  ephemeral?: KeyPair
}

// 一次握手：按模式轮流 writeMessage、readMessage，最后 split() 拿到传输层。中途出错就整个作废
export class Handshake {
  private readonly state: SymmetricState
  private readonly messages: Token[][]
  private readonly psk: Buffer | null
  private index = 0
  private failed = false
  private ephemeral: KeyPair | null = null
  private remoteEphemeral: Buffer | null = null
  private remoteStaticKey: Buffer | null

  constructor(private readonly options: HandshakeOptions) {
    const pattern = PATTERNS[options.pattern]
    this.messages = pattern.messages
    const pskMode = pattern.messages.some((tokens) => tokens.includes('psk'))
    if (pattern.preStatic && options.remoteStatic?.length !== DH_LEN) throw new NoiseError(`${options.pattern} 握手要先知道对方的长期公钥`)
    if (pskMode && options.psk?.length !== PSK_LEN) throw new NoiseError(`${options.pattern} 握手要 32 字节的预共享密钥`)
    this.psk = pskMode && options.psk ? Buffer.from(options.psk) : null
    this.remoteStaticKey = pattern.preStatic && options.remoteStatic ? Buffer.from(options.remoteStatic) : null
    this.state = new SymmetricState(`Noise_${options.pattern}_25519_AESGCM_SHA256`)
    this.state.mixHash(options.prologue)
    if (pattern.preStatic && this.remoteStaticKey) {
      const own = options.staticKey.publicKey
      this.state.mixHash(options.initiator ? own : this.remoteStaticKey)
      this.state.mixHash(options.initiator ? this.remoteStaticKey : own)
    }
  }

  get finished(): boolean {
    return this.index >= this.messages.length
  }

  // 现在该不该由自己发
  get myTurn(): boolean {
    return !this.finished && (this.index % 2 === 0) === this.options.initiator
  }

  remoteStatic(): Uint8Array | null {
    return this.remoteStaticKey
  }

  handshakeHash(): Uint8Array {
    return this.state.hash
  }

  writeMessage(payload: Uint8Array = EMPTY): Uint8Array {
    this.check(true)
    return this.guard(() => {
      const parts: Buffer[] = []
      for (const token of this.messages[this.index]!) {
        if (token === 'e') {
          this.ephemeral = this.options.ephemeral ?? generateKeyPair()
          parts.push(Buffer.from(this.ephemeral.publicKey))
          this.mixEphemeral(this.ephemeral.publicKey)
        } else if (token === 's') parts.push(this.state.encryptAndHash(this.options.staticKey.publicKey))
        else if (token === 'psk') this.mixPsk()
        else this.state.mixKey(this.dhFor(token))
      }
      parts.push(this.state.encryptAndHash(payload))
      const message = Buffer.concat(parts)
      if (message.length > NOISE_MAX_MESSAGE) throw new NoiseError('握手消息太长')
      this.index++
      return message
    })
  }

  readMessage(message: Uint8Array): Uint8Array {
    this.check(false)
    return this.guard(() => {
      if (message.length > NOISE_MAX_MESSAGE) throw new NoiseError('握手消息太长')
      let offset = 0
      const take = (length: number) => {
        if (message.length - offset < length) throw new NoiseError('握手消息不完整')
        offset += length
        return message.subarray(offset - length, offset)
      }
      for (const token of this.messages[this.index]!) {
        if (token === 'e') {
          this.remoteEphemeral = Buffer.from(take(DH_LEN))
          this.mixEphemeral(this.remoteEphemeral)
        } else if (token === 's') this.remoteStaticKey = this.state.decryptAndHash(take(DH_LEN + (this.state.cipher.hasKey() ? TAG_LEN : 0)))
        else if (token === 'psk') this.mixPsk()
        else this.state.mixKey(this.dhFor(token))
      }
      const payload = this.state.decryptAndHash(message.subarray(offset))
      this.index++
      return payload
    })
  }

  // 发起方用前一个，应答方用后一个
  split(): Transport {
    if (this.failed || !this.finished) throw new NoiseError('握手还没完成')
    const [first, second] = this.state.split()
    return this.options.initiator ? new Transport(first, second) : new Transport(second, first)
  }

  private mixEphemeral(publicKey: Uint8Array): void {
    this.state.mixHash(publicKey)
    // 带预共享密钥的模式里，临时公钥还要混进密钥
    if (this.psk) this.state.mixKey(publicKey)
  }

  private mixPsk(): void {
    if (!this.psk) throw new NoiseError('没有预共享密钥')
    this.state.mixKeyAndHash(this.psk)
  }

  private dhFor(token: Exclude<Token, 'e' | 's' | 'psk'>): Buffer {
    const initiator = this.options.initiator
    const own = token === 'ee' || (token === 'es' && initiator) || (token === 'se' && !initiator) ? this.ephemeral?.privateKey : this.options.staticKey.privateKey
    const remote = token === 'ee' || (token === 'se' && initiator) || (token === 'es' && !initiator) ? this.remoteEphemeral : this.remoteStaticKey
    if (!own || !remote) throw new NoiseError('握手顺序不对')
    return dh(own, remote)
  }

  private check(writing: boolean): void {
    if (this.failed) throw new NoiseError('握手已经失败')
    if (this.finished) throw new NoiseError('握手已经完成')
    if (this.myTurn !== writing) throw new NoiseError(writing ? '现在该对方发' : '现在该自己发')
  }

  private guard<T>(run: () => T): T {
    try {
      return run()
    } catch (error) {
      this.failed = true
      throw error instanceof NoiseError ? error : new NoiseError('握手失败', { cause: error })
    }
  }
}

// 握手之后的加密通道：两个方向各自计数，消息丢了、重放、乱序、被改都会解密失败，之后整条通道作废
export class Transport {
  private broken = false

  constructor(
    private readonly sending: CipherState,
    private readonly receiving: CipherState,
  ) {}

  encrypt(plaintext: Uint8Array): Uint8Array {
    if (this.broken) throw new NoiseError('加密通道已经作废')
    if (plaintext.length > NOISE_MAX_PAYLOAD) throw new NoiseError('消息太长，要先分片')
    return this.sending.encryptWithAd(EMPTY, plaintext)
  }

  decrypt(ciphertext: Uint8Array): Uint8Array {
    if (this.broken) throw new NoiseError('加密通道已经作废')
    try {
      if (ciphertext.length > NOISE_MAX_MESSAGE) throw new NoiseError('消息太长')
      return this.receiving.decryptWithAd(EMPTY, ciphertext)
    } catch (error) {
      this.broken = true
      throw error
    }
  }
}
