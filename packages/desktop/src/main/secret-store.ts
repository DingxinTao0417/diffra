import { join } from 'node:path'
import { safeStorage } from 'electron'
import { z } from 'zod'
import { readJsonFile, WriteQueue, writeJsonFileAtomic } from './json-file'

const secretsSchema = z.object({
  version: z.literal(1),
  // providerId → safeStorage 加密后的密文（base64）
  keys: z.record(z.string(), z.string()),
})

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

  get(providerId: string): string | null {
    const encrypted = this.keys[providerId]
    if (!encrypted) return null
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  }

  // 界面只显示末 4 位；太短的密钥不显示任何字符
  hint(providerId: string): string | null {
    if (!this.keys[providerId]) return null
    try {
      const key = this.get(providerId) ?? ''
      return key.length >= 12 ? `…${key.slice(-4)}` : '已设置'
    } catch (error) {
      console.error('[secrets] 密钥解密失败', error)
      return '无法解密，请重新填写'
    }
  }

  set(providerId: string, apiKey: string): Promise<void> {
    return this.write((keys) => {
      // 系统加密不可用时宁可失败，也不退回明文存储
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用，无法安全保存密钥')
      return { ...keys, [providerId]: safeStorage.encryptString(apiKey).toString('base64') }
    })
  }

  delete(providerId: string): Promise<void> {
    if (!(providerId in this.keys)) return Promise.resolve()
    return this.write((keys) => Object.fromEntries(Object.entries(keys).filter(([id]) => id !== providerId)))
  }

  private write(change: (keys: Record<string, string>) => Record<string, string>): Promise<void> {
    return this.queue.run(async () => {
      if (this.loadError) throw new Error(this.loadError)
      const next = change(this.keys)
      await writeJsonFileAtomic(this.file, { version: 1, keys: next })
      this.keys = next
    })
  }
}
