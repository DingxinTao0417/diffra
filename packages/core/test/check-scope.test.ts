import { describe, expect, test } from 'vitest'
import { isDocsOnly, shouldRunFinishCheck } from '../src/session/check-scope.js'

describe('完成检查范围', () => {
  test('只有文档才跳过；代码、配置、测试、文档目录里的代码都要跑', () => {
    expect(isDocsOnly(['README.md', 'docs/guide.mdx', 'CHANGELOG.md'])).toBe(true)
    expect(isDocsOnly(['docs/a.md', 'src/a.ts'])).toBe(false)
    expect(isDocsOnly(['docs/a.ts'])).toBe(false)
    expect(isDocsOnly(['docs/a.txt'])).toBe(true)
    expect(isDocsOnly(['package.json'])).toBe(false)
    expect(isDocsOnly(['notes.txt'])).toBe(false)
    expect(isDocsOnly([])).toBe(false)
  })

  test('没改动不跑；读不到路径按保守处理照常跑', () => {
    expect(shouldRunFinishCheck('none', null)).toBe(false)
    expect(shouldRunFinishCheck('edited', ['README.md'])).toBe(false)
    expect(shouldRunFinishCheck('edited', ['src/a.ts'])).toBe(true)
    expect(shouldRunFinishCheck('edited', null)).toBe(true)
    expect(shouldRunFinishCheck('edited', [])).toBe(true)
    expect(shouldRunFinishCheck('unknown', [])).toBe(true)
  })
})
