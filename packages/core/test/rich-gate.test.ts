import { describe, expect, test } from 'vitest'
import { parseRichBlock, RICH_BLOCK_KINDS, RICH_BLOCK_VERSION, RICH_LIMITS } from '../src/rich/blocks.js'
import { RICH_SAMPLES, sampleSource } from './fixtures/rich-samples.js'

// 第 684 步：每种内置富块的质量门槛——样例能画；数据不对、太长、版本比这里新都回退成代码并写明原因；不写版本（旧会话）照常画
describe('富块质量门槛', () => {
  for (const kind of RICH_BLOCK_KINDS) {
    test(`${kind}`, () => {
      expect(parseRichBlock(kind, sampleSource(kind))).toMatchObject({ ok: true, kind })

      const invalid = RICH_SAMPLES[kind].invalid
      if (invalid !== null) {
        const result = parseRichBlock(kind, invalid)
        expect(result.ok, invalid).toBe(false)
        expect(!result.ok && result.error.length > 0).toBe(true)
      }

      expect(parseRichBlock(kind, 'x'.repeat(RICH_LIMITS.chars + 1))).toEqual({ ok: false, kind, error: `内容太长（超过 ${RICH_LIMITS.chars} 字）` })

      // 更新的 Diffra 写的块（json 是任意 JSON，不认版本；log 是原文）
      const valid = RICH_SAMPLES[kind].valid
      if (kind !== 'json' && typeof valid === 'object' && valid !== null && !Array.isArray(valid)) {
        const newer = parseRichBlock(kind, JSON.stringify({ ...valid, v: RICH_BLOCK_VERSION + 1 }))
        expect(newer).toEqual({ ok: false, kind, error: `这是第 ${RICH_BLOCK_VERSION + 1} 版的 ${kind} 块，当前版本只认到第 ${RICH_BLOCK_VERSION} 版` })
        expect(parseRichBlock(kind, JSON.stringify({ ...valid, v: RICH_BLOCK_VERSION }))).toMatchObject({ ok: true })
      }
    })
  }
})
