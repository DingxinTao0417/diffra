import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { deviceIdOf } from '@diffra/relay/protocol'
import { fingerprintOf, generateKeyPair, type KeyPair, keyPairOf } from '@diffra/remote'
import { safeStorage } from 'electron'
import { z } from 'zod'
import { readJsonFile, writeJsonFileAtomic } from '../json-file'

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

export function deleteIdentity(dir: string): Promise<void> {
  return rm(fileOf(dir), { force: true })
}

function identityOf(signingPrivate: KeyObject, noise: KeyPair): DeviceIdentity {
  const signingKey = createPublicKey(signingPrivate).export({ format: 'der', type: 'spki' }).subarray(-32)
  const id = deviceIdOf(signingKey, noise.publicKey)
  return { deviceId: id.toString('hex'), fingerprint: fingerprintOf(id), signingKey: Buffer.from(signingKey), signingPrivate, noise }
}
