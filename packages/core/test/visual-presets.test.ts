import { describe, expect, test } from 'vitest'
import type { SessionUpdate } from '../src/protocol.js'
import type { StepToolCall, TurnIO } from '../src/session/loop.js'
import { formulaProblem, presetCode, runShowVisual } from '../src/session/visual.js'

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

  // 第 688 步
  test('参数沙盘：公式只认数字、参数名、x 和 Math 函数，少乘号、括号不配、不认识的名字都说清楚', async () => {
    const names = new Set(['users', 'price', 'x'])
    expect(formulaProblem('users * price * x + max(0, users - 1000) ^ 2', names)).toBeNull()
    expect(formulaProblem('round(sqrt(users) * PI) >= 3 ? 1 : 0', names)).toBeNull()
    expect(formulaProblem('2x', names)).toBe('is missing an operator between "2" and "x" (write * for multiplication)')
    expect(formulaProblem('(users)(price)', names)).toContain('missing an operator')
    expect(formulaProblem('users * (price', names)).toBe('has an unmatched "("')
    expect(formulaProblem('users)', names)).toBe('has an unmatched ")"')
    expect(formulaProblem('window.alert(1)', names)).toContain('unknown name "window"')
    expect(formulaProblem('users["a"]', names)).toContain('unsupported character "["')
    expect(formulaProblem('users = 1', names)).toContain('unsupported character "="')

    const data = {
      params: [
        { id: 'users', label: '日活', min: 1000, max: 100000, step: 1000, value: 20000, unit: '人' },
        { id: 'price', label: '单价', min: 0.01, max: 0.1, value: 0.02, unit: '元' },
      ],
      x: { from: 1, to: 12, label: '月' },
      chart: { type: 'line', series: [{ name: '累计成本', formula: 'users * price * x' }] },
      outputs: [{ label: '年成本', formula: 'users * price * 12', unit: '元' }],
    }
    const { updates, io } = recording()
    await runShowVisual(call({ title: '成本', preset: 'sandbox', data }), io)
    expect((updates[0] as { _meta?: { diffra?: { visual?: { code: string } } } })._meta?.diffra?.visual?.code).toContain('diffra.preset("sandbox"')

    for (const [broken, message] of [
      [{ ...data, outputs: [{ label: '年成本', formula: 'users * x' }] }, 'outputs.0.formula: the formula uses an unknown name "x"'],
      [{ ...data, x: undefined }, 'x: a chart needs x'],
      [{ ...data, x: { from: 0, to: 1000 } }, 'x.step: at most 200 points'],
      [{ ...data, params: [{ ...data.params[0], value: 0 }] }, 'params.0.value: value must be between min and max'],
      [{ ...data, params: [{ ...data.params[0], id: 'max' }] }, 'params.0.id: "max" is reserved'],
      [{ params: data.params }, 'chart: give a chart, outputs, or both'],
    ] as const) {
      const recorder = recording()
      const outcome = await runShowVisual(call({ title: '成本', preset: 'sandbox', data: broken }), recorder.io)
      expect((outcome.result.output as { value: string }).value).toContain(message)
    }
  })

  test('只给代码照旧', async () => {
    const { updates, io } = recording()
    await runShowVisual(call({ title: '图', code: '<svg></svg>' }), io)
    expect((updates[0] as { _meta?: { diffra?: { visual?: { code: string } } } })._meta?.diffra?.visual?.code).toBe('<svg></svg>')
  })
})
