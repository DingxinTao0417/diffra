import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { downloadFile } from '../src/uploads.ts'

const root = mkdtempSync(join(tmpdir(), 'eval-download-'))
const uploads = join(root, 'uploads')
mkdirSync(join(uploads, '2024'), { recursive: true })
mkdirSync(join(root, 'uploads-evil'))
writeFileSync(join(uploads, 'a.txt'), 'hello')
writeFileSync(join(uploads, '2024', 'report.txt'), 'report')
writeFileSync(join(root, 'secret.txt'), 'TOP-SECRET')
writeFileSync(join(root, 'uploads-evil', 'x.txt'), 'EVIL-SECRET')
after(() => rmSync(root, { recursive: true, force: true }))

async function attempt(filename: string): Promise<unknown> {
  try {
    return await downloadFile(uploads, filename)
  } catch {
    return 'rejected'
  }
}

test('读上传目录里的文件，包括子目录', async () => {
  assert.equal(String(await downloadFile(uploads, 'a.txt')), 'hello')
  assert.equal(String(await downloadFile(uploads, '2024/report.txt')), 'report')
})

test('文件不存在返回 null', async () => {
  assert.equal(await downloadFile(uploads, 'missing.txt'), null)
  assert.equal(await downloadFile(uploads, '2024/missing.txt'), null)
})

test('读不到上传目录外面的文件', async () => {
  const attacks = ['../secret.txt', '..\\secret.txt', '2024/../../secret.txt', join(root, 'secret.txt'), '../uploads-evil/x.txt']
  for (const filename of attacks) {
    const result = await attempt(filename)
    assert.ok(result === null || result === 'rejected', `${filename} 读到了 ${String(result)}`)
  }
})
