import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { projectSecretValues, redactSecretValues, secretValuesOf } from '../src/security/secret-values.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'diffra-secret-values-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('命令输出里的密钥值（第 625 步）', () => {
  test('从 .env 取名字像密钥的值和像随机串的长值，localhost、端口这种不取', () => {
    const values = secretValuesOf(
      '.env',
      [
        '# 注释',
        'DB_HOST=localhost',
        'PORT=3000',
        'DB_PASSWORD="hunter2-very-secret"',
        "export STRIPE_KEY='sk_live_51Habc'",
        'WEBHOOK_URL=https://hooks.example.com/abc123def456ghi789 # 回调',
        'SHORT_TOKEN=abc',
      ].join('\n'),
    )
    expect(values).toEqual([
      { value: 'hunter2-very-secret', label: 'value of DB_PASSWORD in .env' },
      { value: 'sk_live_51Habc', label: 'value of STRIPE_KEY in .env' },
      { value: 'https://hooks.example.com/abc123def456ghi789', label: 'value of WEBHOOK_URL in .env' },
    ])
  })

  test('.netrc 的 password、私钥正文也取', () => {
    expect(secretValuesOf('.netrc', 'machine api.example.com login me password s3cr3t-pw')).toEqual([{ value: 's3cr3t-pw', label: 'password in .netrc' }])
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----'
    expect(secretValuesOf('id.pem', pem)).toEqual([{ value: 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', label: 'private key in id.pem' }])
  })

  test('扫项目里的受保护文件（跳过 node_modules），命令输出里出现就换成占位', async () => {
    writeFileSync(join(root, '.env'), 'API_TOKEN=tok_1234567890abcdef\nDEBUG=true\n')
    mkdirSync(join(root, 'config'))
    writeFileSync(join(root, 'config', '.env.local'), 'DB_PASSWORD=pw-local-123\n')
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'pkg', '.env'), 'OTHER_SECRET=should-not-be-read\n')
    const values = await projectSecretValues(root, 1)
    expect(values.map((item) => item.label).sort()).toEqual(['value of API_TOKEN in .env', 'value of DB_PASSWORD in config/.env.local'])
    const output = 'Exit code: 0\n---ENV---\nAPI_TOKEN=tok_1234567890abcdef\nDEBUG=true\nconnecting with pw-local-123'
    expect(redactSecretValues(output, values)).toBe(
      'Exit code: 0\n---ENV---\nAPI_TOKEN=[hidden by Diffra: value of API_TOKEN in .env]\nDEBUG=true\nconnecting with [hidden by Diffra: value of DB_PASSWORD in config/.env.local]',
    )
  })

  test('结果缓存一会儿；过了缓存时间重新扫，新加的密钥文件也算上', async () => {
    expect(await projectSecretValues(root, 1000)).toEqual([])
    writeFileSync(join(root, '.env'), 'SECRET_KEY=new-secret-value\n')
    expect(await projectSecretValues(root, 2000)).toEqual([])
    expect(await projectSecretValues(root, 1000 + 15_001)).toEqual([{ value: 'new-secret-value', label: 'value of SECRET_KEY in .env' }])
  })
})
