import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { listUploads } from '../src/uploads.ts'

const root = mkdtempSync(join(tmpdir(), 'uploads-test-'))
after(() => rmSync(root, { recursive: true, force: true }))

test('只列出第一层的文件', async () => {
  mkdirSync(join(root, 'nested'))
  writeFileSync(join(root, 'b.txt'), 'b')
  writeFileSync(join(root, 'a.txt'), 'a')
  assert.deepEqual(await listUploads(root), ['a.txt', 'b.txt'])
})
