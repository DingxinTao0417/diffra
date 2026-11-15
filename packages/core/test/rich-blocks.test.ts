import { describe, expect, test } from 'vitest'
import { isRichBlockKind, parseRichBlock, RICH_BLOCK_KINDS, RICH_LIMITS } from '../src/rich/blocks.js'
import { buildSystemPrompt } from '../src/session/prompt.js'
import { NO_RULES } from './loop-helpers.js'

const json = (value: unknown) => JSON.stringify(value)

describe('回答里的结构化富块（第 650 步）', () => {
  test('注册表认得的种类', () => {
    expect(RICH_BLOCK_KINDS).toEqual(['chart', 'metrics', 'table', 'timeline', 'steps', 'compare', 'filetree', 'keyvalue', 'todos', 'annotate', 'json', 'log'])
    expect(isRichBlockKind('chart')).toBe(true)
    expect(isRichBlockKind('ts')).toBe(false)
    expect(isRichBlockKind('toString')).toBe(false)
  })

  test('chart：单系列简写统一成类目加系列；多系列按 x 对齐', () => {
    const single = parseRichBlock('chart', json({ type: 'bar', title: '构建耗时', unit: 's', data: [{ label: '安装', value: 12 }, { label: '构建', value: 30.5 }] }))
    expect(single).toEqual({ ok: true, kind: 'chart', data: { type: 'bar', title: '构建耗时', unit: 's', xLabel: undefined, yLabel: undefined, horizontal: false, stacked: false, categories: ['安装', '构建'], series: [{ name: '构建耗时', data: [12, 30.5] }] } })
    const multi = parseRichBlock('chart', json({ type: 'line', x: ['周一', '周二'], series: [{ name: 'A', data: [1, 2] }, { name: 'B', data: [3, null] }] }))
    expect(multi.ok && multi.data.type === 'line' && multi.data.series).toEqual([{ name: 'A', data: [1, 2] }, { name: 'B', data: [3, null] }])
  })

  test('chart：饼、散点、热力各自的形状和校验', () => {
    const pie = parseRichBlock('chart', json({ type: 'pie', data: [{ name: '通过', value: 8 }, { name: '失败', value: 2 }] }))
    expect(pie.ok && pie.data).toEqual({ type: 'pie', title: undefined, unit: undefined, slices: [{ name: '通过', value: 8 }, { name: '失败', value: 2 }] })
    expect(parseRichBlock('chart', json({ type: 'pie', data: [{ name: 'a', value: -1 }] }))).toMatchObject({ ok: false, error: '饼图不能有负数' })
    const scatter = parseRichBlock('chart', json({ type: 'scatter', series: [{ name: '请求', data: [[1, 2], [3, 4]] }] }))
    expect(scatter.ok && scatter.data.type === 'scatter' && scatter.data.series[0]!.points).toEqual([[1, 2], [3, 4]])
    const heat = parseRichBlock('chart', json({ type: 'heatmap', x: ['a', 'b'], y: ['1'], data: [[1, 2]] }))
    expect(heat.ok && heat.data).toMatchObject({ type: 'heatmap', x: ['a', 'b'], y: ['1'], values: [[1, 2]] })
    expect(parseRichBlock('chart', json({ type: 'heatmap', x: ['a', 'b'], y: ['1'], data: [[1]] }))).toMatchObject({ ok: false, error: '热力图每一行的个数要和 x 一样多' })
  })

  test('非法数据给出原因：不是 JSON、类型不对、系列和类目对不上、超上限', () => {
    expect(parseRichBlock('chart', '{ type: bar')).toMatchObject({ ok: false, error: expect.stringContaining('不是合法的 JSON') })
    expect(parseRichBlock('chart', json({ type: 'donut', data: [] }))).toMatchObject({ ok: false, error: expect.stringContaining('type') })
    expect(parseRichBlock('chart', json({ type: 'bar', x: ['a'], series: [{ name: 'A', data: [1, 2] }] }))).toMatchObject({ ok: false, error: '每个系列的 data 个数要和 x 一样多' })
    const many = Array.from({ length: RICH_LIMITS.chartPoints + 1 }, (_, index) => ({ label: `p${index}`, value: index }))
    expect(parseRichBlock('chart', json({ type: 'line', data: many }))).toMatchObject({ ok: false, error: `图表超过 ${RICH_LIMITS.chartPoints} 个点` })
    expect(parseRichBlock('table', 'x'.repeat(RICH_LIMITS.chars + 1))).toMatchObject({ ok: false, error: expect.stringContaining('内容太长') })
  })

  test('版本比当前新的块回退，写了当前版本或不写的照常', () => {
    expect(parseRichBlock('metrics', json({ v: 2, items: [{ label: 'a', value: 1 }] }))).toMatchObject({ ok: false, error: '这是第 2 版的 metrics 块，当前版本只认到第 1 版' })
    expect(parseRichBlock('metrics', json({ v: 1, items: [{ label: 'a', value: 1 }] })).ok).toBe(true)
    // json 块的内容是用户数据，里面的 v 不是版本
    expect(parseRichBlock('json', json({ v: 9 }))).toEqual({ ok: true, kind: 'json', data: { value: { v: 9 } } })
  })

  test('metrics：没写 trend 时按 delta 的正负推出来', () => {
    const result = parseRichBlock('metrics', json([{ label: '耗时', value: '12s', delta: '-8%', better: 'down' }, { label: '用例', value: 120, delta: 5 }, { label: '失败', value: 0 }]))
    expect(result.ok && result.data.items.map((item) => item.trend)).toEqual(['down', 'up', undefined])
  })

  test('table：对象行按列名取值；全是数字的列右对齐', () => {
    const result = parseRichBlock('table', json({ columns: ['名字', { key: 'size', label: '体积' }], rows: [{ 名字: 'a.js', size: 120 }, ['b.js', 30]] }))
    expect(result.ok && result.data).toEqual({
      title: undefined,
      columns: [
        { key: '名字', label: '名字', align: 'left', numeric: false },
        { key: 'size', label: '体积', align: 'right', numeric: true },
      ],
      rows: [['a.js', 120], ['b.js', 30]],
    })
  })

  test('steps：current 推出完成、进行中、待做；单个字符串也能当一步', () => {
    const result = parseRichBlock('steps', json({ current: 2, items: ['装依赖', { title: '跑测试', command: 'pnpm test' }, '发版'] }))
    expect(result.ok && result.data.items.map((item) => [item.title, item.status])).toEqual([['装依赖', 'done'], ['跑测试', 'active'], ['发版', 'pending']])
  })

  test('compare 最多推荐一个；filetree 统一路径分隔符；keyvalue 支持对象简写', () => {
    expect(parseRichBlock('compare', json({ options: [{ name: 'A', recommended: true }, { name: 'B', recommended: true }] }))).toMatchObject({ ok: false, error: '只能推荐一个方案' })
    const tree = parseRichBlock('filetree', json(['src\\a.ts', { path: './src/b.ts', status: 'added' }]))
    expect(tree.ok && tree.data.items).toEqual([{ path: 'src/a.ts' }, { path: 'src/b.ts', status: 'added' }])
    const kv = parseRichBlock('keyvalue', json({ 端口: 3000, 模式: 'dev' }))
    expect(kv.ok && kv.data.items).toEqual([{ key: '端口', value: 3000 }, { key: '模式', value: 'dev' }])
  })

  test('系统提示词的回答格式指南列出了每种块（json 是普通代码围栏，不单列）；子智能体的提示词里没有', async () => {
    const options = { checks: { afterEdit: null, beforeFinish: null }, readOnlyPaths: [], rules: NO_RULES }
    const main = await buildSystemPrompt(null, options, [])
    expect(main).toContain('## Formatting your answer')
    for (const kind of RICH_BLOCK_KINDS.filter((kind) => kind !== 'json')) expect(main).toMatch(new RegExp(`\\b${kind}:`))
    const worker = await buildSystemPrompt(null, options, [], { skills: [], frontend: null, worker: true })
    expect(worker).not.toContain('## Formatting your answer')
  })

  test('todos：字符串和对象都行，优先级只认 0–3', () => {
    const result = parseRichBlock('todos', json(['写测试', { text: '换密钥', note: '旧的泄露过', priority: 0 }]))
    expect(result.ok && result.data.items).toEqual([{ text: '写测试' }, { text: '换密钥', note: '旧的泄露过', priority: 0 }])
    expect(parseRichBlock('todos', json([{ text: 'x', priority: 5 }])).ok).toBe(false)
  })

  // 第 685 步
  test('annotate：写了 size 按像素换成比例，没写就是 0–1；超出图片、箭头没终点、框没宽高、网络图片都不认', () => {
    const pixels = parseRichBlock('annotate', json({ image: 'shots/a.png', size: [200, 100], marks: [{ shape: 'box', x: 20, y: 10, w: 100, h: 50, note: ' 这里 ' }, { shape: 'arrow', x: 0, y: 0, x2: 200, y2: 100 }] }))
    expect(pixels.ok && pixels.data).toEqual({
      image: 'shots/a.png',
      title: undefined,
      marks: [
        { shape: 'box', x: 0.1, y: 0.1, w: 0.5, h: 0.5, note: '这里' },
        { shape: 'arrow', x: 0, y: 0, x2: 1, y2: 1, note: undefined },
      ],
    })
    const fractions = parseRichBlock('annotate', json({ image: '@图片1', marks: [{ shape: 'pin', x: 0.5, y: 0.25 }] }))
    expect(fractions.ok && fractions.data.marks).toEqual([{ shape: 'pin', x: 0.5, y: 0.25, note: undefined }])

    const errorOf = (value: unknown) => {
      const result = parseRichBlock('annotate', json(value))
      return result.ok ? null : result.error
    }
    expect(errorOf({ image: 'a.png', marks: [{ shape: 'pin', x: 300, y: 0.5 }] })).toBe('marks.0.x：超出了图片范围（没写 size 时坐标是 0–1 的比例）')
    expect(errorOf({ image: 'a.png', size: [100, 100], marks: [{ shape: 'box', x: 50, y: 50, w: 80, h: 10 }] })).toBe('marks.0.w：超出了图片范围')
    expect(errorOf({ image: 'a.png', marks: [{ shape: 'arrow', x: 0.1, y: 0.1 }] })).toBe('marks.0：箭头要写 x2、y2（指向的位置）')
    expect(errorOf({ image: 'a.png', marks: [{ shape: 'circle', x: 0.1, y: 0.1, w: 0 }] })).toBe('marks.0：圈要写正的 w、h（宽和高）')
    expect(errorOf({ image: 'http://x.test/a.png', marks: [{ shape: 'pin', x: 0, y: 0 }] })).toContain('网络图片不加载')
    expect(errorOf({ image: 'a.png', marks: Array.from({ length: RICH_LIMITS.annotateMarks + 1 }, () => ({ shape: 'pin', x: 0, y: 0 })) })).not.toBeNull()
  })

  test('log：认出级别和源码位置，超过上限的行截掉并记下条数', () => {
    const result = parseRichBlock('log', ['INFO 启动', 'WARN 慢查询', "Error: boom\n    at run (src/app.ts:12:5)", 'File "main.py", line 8, in <module>'].join('\n'))
    expect(result.ok && result.data.lines.map((line) => [line.level, line.source])).toEqual([
      ['info', null],
      ['warn', null],
      ['error', null],
      [null, { path: 'src/app.ts', line: 12 }],
      [null, { path: 'main.py', line: 8 }],
    ])
    const long = parseRichBlock('log', Array.from({ length: RICH_LIMITS.logLines + 3 }, (_, index) => `line ${index}`).join('\n'))
    expect(long.ok && [long.data.lines.length, long.data.truncated]).toEqual([RICH_LIMITS.logLines, 3])
  })
})
