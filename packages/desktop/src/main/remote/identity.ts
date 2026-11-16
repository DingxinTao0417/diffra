import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { deviceIdOf } from '@diffra/relay/protocol'
import { fingerprintOf, generateKeyPair, type KeyPair, keyPairOf } from '@diffra/remote'
import { safeStorage } from 'electron'
import { z } from 'zod'
import { readJsonFile, writeJsonFileAtomic } from '../json-file'
import { createLanCertificate, fingerprintOfPem, type LanCertificate } from './lan-tls'

// 本机的设备身份：Ed25519 登录中转，X25519 做加密通道的长期密钥；设备 ID 由两把公钥算出来。
// 私钥用 safeStorage（Windows 上是 DPAPI）加密后存在 remote/identity.json，系统加密不可用时不生成、不保存，和 API Key 一样

export interface DeviceIdentity {
  deviceId: string
  fingerprint: string
  signingKey: Buffer
  signingPrivate: KeyObject
  noise: KeyPair
}

const identitySchema = z.object({
  version: z.literal(1),
  // safeStorage 加密后的密文（base64），明文是 Ed25519 的 PKCS#8 和 X25519 的 32 字节私钥（base64）
  signing: z.string().min(1),
  noise: z.string().min(1),
})

const fileOf = (dir: string) => join(dir, 'identity.json')

export async function encryptionUnavailable(): Promise<string | null> {
  return (await safeStorage.isAsyncEncryptionAvailable()) ? null : '系统加密不可用，没法安全保存设备密钥，设备连接用不了'
}

export async function loadIdentity(dir: string): Promise<DeviceIdentity | null> {
  const content = await readJsonFile(fileOf(dir), identitySchema)
  if (content.state === 'missing') return null
  if (content.state === 'invalid') throw new Error(`设备身份文件无法解析：${fileOf(dir)}`)
  const decrypt = async (value: string) => Buffer.from((await safeStorage.decryptStringAsync(Buffer.from(value, 'base64'))).result, 'base64')
  const signingPrivate = createPrivateKey({ key: await decrypt(content.value.signing), format: 'der', type: 'pkcs8' })
  return identityOf(signingPrivate, keyPairOf(await decrypt(content.value.noise)))
}

export async function createIdentity(dir: string): Promise<DeviceIdentity> {
  const reason = await encryptionUnavailable()
  if (reason) throw new Error(reason)
  const signingPrivate = generateKeyPairSync('ed25519').privateKey
  const noise = generateKeyPair()
  const encrypt = async (value: Buffer) => (await safeStorage.encryptStringAsync(value.toString('base64'))).toString('base64')
  await writeJsonFileAtomic(fileOf(dir), {
    version: 1,
    signing: await encrypt(signingPrivate.export({ format: 'der', type: 'pkcs8' })),
    noise: await encrypt(Buffer.from(noise.privateKey)),
  })
  return identityOf(signingPrivate, noise)
}

export async function deleteIdentity(dir: string): Promise<void> {
  await rm(fileOf(dir), { force: true })
  await rm(certificateFileOf(dir), { force: true })
}

// 局域网版（v2）的 TLS 证书：私钥和设备密钥一样用 safeStorage 加密后存在 remote/tls.json；换设备密钥时一起换
const certificateSchema = z.object({ version: z.literal(1), cert: z.string().min(1), key: z.string().min(1) })
const certificateFileOf = (dir: string) => join(dir, 'tls.json')

export async function loadOrCreateCertificate(dir: string, identity: DeviceIdentity): Promise<LanCertificate> {
  const content = await readJsonFile(certificateFileOf(dir), certificateSchema)
  if (content.state === 'loaded') {
    const key = (await safeStorage.decryptStringAsync(Buffer.from(content.value.key, 'base64'))).result
    return { cert: content.value.cert, key, fingerprint: fingerprintOfPem(content.value.cert) }
  }
  if (content.state === 'invalid') throw new Error(`证书文件无法解析：${certificateFileOf(dir)}`)
  const certificate = createLanCertificate(`Diffra ${identity.deviceId.slice(0, 8)}`)
  await writeJsonFileAtomic(certificateFileOf(dir), { version: 1, cert: certificate.cert, key: (await safeStorage.encryptStringAsync(certificate.key)).toString('base64') })
  return certificate
}

function identityOf(signingPrivate: KeyObject, noise: KeyPair): DeviceIdentity {
  const signingKey = createPublicKey(signingPrivate).export({ format: 'der', type: 'spki' }).subarray(-32)
  const id = deviceIdOf(signingKey, noise.publicKey)
  return { deviceId: id.toString('hex'), fingerprint: fingerprintOf(id), signingKey: Buffer.from(signingKey), signingPrivate, noise }
}
