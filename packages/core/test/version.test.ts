import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { CORE_VERSION } from '../src/version.js'

test('CORE_VERSION 与 package.json 的 version 一致', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  expect(CORE_VERSION).toBe(pkg.version)
})
