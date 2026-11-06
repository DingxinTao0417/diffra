import { join } from 'node:path'
import { safeStorage } from 'electron'
import { z } from 'zod'
import { readJsonFile, WriteQueue, writeJsonFileAtomic } from './json-file'

const secretsSchema = z.object({
  version: z.literal(1),
  // providerId → safeStorage 加密后的密文（base64）
  keys: z.record(z.string(), z.string()),
})

// 用 safeStorage 的异步接口：同步接口在 Electron 45 已废弃。
// 旧接口加密的数据，新接口可以直接解密。
export class SecretStore {
  private keys: Record<string, string> = {}
  private readonly queue = new WriteQueue()
  loadError: string | null = null

  private constructor(private readonly file: string) {}

  static async open(userDataDir: string): Promise<SecretStore> {
    const store = new SecretStore(join(userDataDir, 'secrets.json'))
    const content = await readJsonFile(store.file, secretsSchema)
    if (content.state === 'loaded') store.keys = content.value.keys
    if (content.state === 'invalid') {
      console.error('[secrets] 密钥文件解析失败', content.error)
      store.loadError = `密钥文件无法解析，为避免覆盖已暂停保存：${store.file}`
    }
    return store
  }

  async get(providerId: string): Promise<string | null> {
    const encrypted = this.keys[providerId]
    if (!encrypted) return null
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(encrypted, 'base64'))
    // 系统的加密密钥轮换过时重新加密；失败不影响这次读取，下次读取会再试
    if (shouldReEncrypt) {
      await this.set(providerId, result).catch((error: unknown) => console.error('[secrets] 重新加密失败', error))
    }
    return result
  }

  // 界面只显示末 4 位；太短的密钥不显示任何字符
  async hint(providerId: string): Promise<string | null> {
    if (!this.keys[providerId]) return null
    try {
      const key = (await this.get(providerId)) ?? ''
      return key.length >= 12 ? `…${key.slice(-4)}` : '已设置'
    } catch (error) {
      console.error('[secrets] 密钥解密失败', error)
      return '无法解密，请重新填写'
    }
  }

  set(providerId: string, apiKey: string): Promise<void> {
    return this.write(async (keys) => {
      // 系统加密不可用时宁可失败，也不退回明文存储
      if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('系统加密不可用，无法安全保存密钥')
      const encrypted = await safeStorage.encryptStringAsync(apiKey)
      return { ...keys, [providerId]: encrypted.toString('base64') }
    })
  }

  delete(providerId: string): Promise<void> {
    if (!(providerId in this.keys)) return Promise.resolve()
    return this.write(async (keys) => Object.fromEntries(Object.entries(keys).filter(([id]) => id !== providerId)))
  }

  private write(change: (keys: Record<string, string>) => Promise<Record<string, string>>): Promise<void> {
    return this.queue.run(async () => {
      if (this.loadError) throw new Error(this.loadError)
      const next = await change(this.keys)
      await writeJsonFileAtomic(this.file, { version: 1, keys: next })
      this.keys = next
    })
  }
}
