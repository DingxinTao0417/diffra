import { describe, expect, test } from 'vitest'
import type { SessionUpdate } from '../src/protocol.js'
import type { StepToolCall, TurnIO } from '../src/session/loop.js'
import { presetCode, runShowVisual } from '../src/session/visual.js'

const call = (input: unknown): StepToolCall => ({ toolCallId: 'v1', toolName: 'show_visual', input }) as StepToolCall

function recording() {
  const updates: SessionUpdate[] = []
  return { updates, io: { update: async (update: SessionUpdate) => void updates.push(update) } as unknown as TurnIO }
}

// 第 667 步：show_visual 的预设：模型给数据，core 校验后生成调用工具箱的代码
describe('可视化预设', () => {
  test('数据按 JSON 嵌进脚本，< 换成 \\u003c，数据里的 </script> 跑不出去', () => {
    const code = presetCode('cards', { items: [{ label: '</script><script>alert(1)</script>', value: 1 }] })
    expect(code.startsWith('<script>diffra.preset("cards", ')).toBe(true)
    expect(code.endsWith(')</script>')).toBe(true)
    expect(code.slice(8, -9)).not.toContain('<')
    expect(code).toContain('\\u003c/script>')
  })

  test('合法的预设生成代码，记下预设名', async () => {
    const { updates, io } = recording()
    const outcome = await runShowVisual(call({ title: '方案', preset: 'compare', data: { options: [{ name: 'A' }, { name: 'B', recommended: true }] } }), io)
    expect(JSON.stringify(outcome.result)).toContain('preset compare')
    const visual = (updates[0] as { _meta?: { diffra?: { visual?: { title: string; code: string; preset?: string } } } })._meta?.diffra?.visual
    expect(visual).toMatchObject({ title: '方案', preset: 'compare' })
    expect(visual?.code).toContain('diffra.preset("compare"')
  })

  test('数据不合预设的形状、预设和代码都给了、都没给：报错，不画', async () => {
    for (const input of [
      { title: '坏', preset: 'flow', data: { nodes: [{ id: 'a', label: 'A' }], edges: [] } },
      { title: '坏', preset: 'chart', data: { type: 'pie3d', data: [] } },
      { title: '坏', preset: 'cards', data: { items: [] }, code: '<b>x</b>' },
      { title: '坏' },
    ]) {
      const { updates, io } = recording()
      const outcome = await runShowVisual(call(input), io)
      expect(JSON.stringify(outcome.result), JSON.stringify(input)).toContain('Invalid arguments')
      expect(updates[0]).toMatchObject({ status: 'failed' })
    }
  })

  test('只给代码照旧', async () => {
    const { updates, io } = recording()
    await runShowVisual(call({ title: '图', code: '<svg></svg>' }), io)
    expect((updates[0] as { _meta?: { diffra?: { visual?: { code: string } } } })._meta?.diffra?.visual?.code).toBe('<svg></svg>')
  })
})
