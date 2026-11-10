import { describe, expect, test } from 'vitest'
import type { StoredTurn, ToolCallContent } from '../src/protocol.js'
import { compactEdit, compactTurns } from '../src/session/edit-diff.js'
// 界面按顺序重放压缩过的改动卡片，还原每次改动前后的全文；和 core 的压缩放在一起测
import { replayEdits } from '../../desktop/src/renderer/src/features/session/edit-replay.js'

const lines = (count: number, prefix = '行') => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n')

type Item = { kind: 'tool'; id: string; title: string; toolKind: null; status: 'completed'; content: ToolCallContent[] }
const item = (id: string, content: ToolCallContent): Item => ({ kind: 'tool', id, title: id, toolKind: null, status: 'completed', content: [content] })

describe('改动卡片只带变化的那段', () => {
  test('只留改动和前后 3 行，记下起始行号；一轮里第一次改带整份 base，接着改不带', () => {
    const known = new Map<string, string>()
    const v1 = lines(200)
    const v2 = v1.replace('行 100\n', '行 100（改）\n')
    const first = compactEdit(known, { path: 'a.md', oldText: v1, newText: v2 })
    expect(first.oldText).toBe(['行 97', '行 98', '行 99', '行 100', '行 101', '行 102', '行 103'].join('\n'))
    expect(first.newText).toBe(['行 97', '行 98', '行 99', '行 100（改）', '行 101', '行 102', '行 103'].join('\n'))
    expect(first._meta).toEqual({ diffra: { edit: { startLine: 97, oldLines: 7, newLines: 7, base: v1 } } })

    const v3 = v2.replace('行 150\n', '')
    const second = compactEdit(known, { path: 'a.md', oldText: v2, newText: v3 })
    expect(second._meta).toEqual({ diffra: { edit: { startLine: 147, oldLines: 7, newLines: 6 } } })

    // 两次改动之间文件被别处改过：再带一次整份 base
    const outside = v3.replace('行 1\n', '行 1（别处改的）\n')
    const third = compactEdit(known, { path: 'a.md', oldText: outside, newText: outside.replace('行 200', '行 200（改）') })
    expect((third._meta?.diffra as { edit: { base?: string } }).edit.base).toBe(outside)
  })

  test('新建文件整份都是新增，不带 base', () => {
    const created = compactEdit(new Map(), { path: 'new.ts', oldText: null, newText: 'a\nb\n' })
    expect(created).toMatchObject({ oldText: null, newText: 'a\nb\n', _meta: { diffra: { edit: { startLine: 1, oldLines: 0, newLines: 3 } } } })
  })

  test('界面按顺序重放能还原每次改动前后的全文：改中间、头、尾，删到空，插空行，新建，被别处改过', () => {
    const known = new Map<string, string>()
    const steps: Array<{ path: string; oldText: string | null; newText: string }> = []
    const push = (path: string, oldText: string | null, newText: string) => steps.push({ path, oldText, newText })
    let a = lines(50)
    const edits = [
      (text: string) => text.replace('行 25', '行 25（改）'),
      (text: string) => `开头\n${text}`,
      (text: string) => `${text}\n结尾\n`,
      (text: string) => text.replace('行 10\n行 11\n', ''),
      (text: string) => text.replace('行 30\n', '行 30\n\n\n'),
      () => '',
      () => '重新写\n',
    ]
    for (const edit of edits) {
      const next = edit(a)
      push('a.md', a, next)
      a = next
    }
    push('b.ts', null, 'export const b = 1\n')
    push('b.ts', 'export const b = 1\n', 'export const b = 2\n')
    // 别处改过 b.ts 以后再改
    push('b.ts', '// 别人加的\nexport const b = 2\n', '// 别人加的\nexport const b = 3\n')

    const items = steps.map((step, index) => item(`t${index}`, compactEdit(known, step)))
    const replayed = replayEdits(items)
    steps.forEach((step, index) => {
      expect(replayed.get(`t${index}\n${step.path}`)).toEqual({ before: step.oldText, after: step.newText })
    })
  })

  test('旧记录的整份卡片在发给界面前压缩，记录本身不动；压缩后重放结果一样', () => {
    const v1 = lines(300)
    const v2 = v1.replace('行 200', '行 200（改）')
    const v3 = v2.replace('行 10\n', '')
    const update = (id: string, oldText: string, newText: string) => ({ sessionUpdate: 'tool_call_update' as const, toolCallId: id, status: 'completed' as const, content: [{ type: 'diff' as const, path: 'a.md', oldText, newText }] })
    const turn: StoredTurn = { id: 'turn', kind: 'prompt', prompt: '改', startedAt: '', endedAt: '', stopReason: 'end_turn', updates: [update('e1', v1, v2), update('e2', v2, v3)], skills: [], images: [] }
    const [compact] = compactTurns([turn])
    expect(turn.updates[0]).toEqual(update('e1', v1, v2))
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(turn).length / 2)
    const items = compact!.updates.map((entry) => item((entry as { toolCallId: string }).toolCallId, ((entry as { content: ToolCallContent[] }).content)[0]!))
    const replayed = replayEdits(items)
    expect(replayed.get('e1\na.md')).toEqual({ before: v1, after: v2 })
    expect(replayed.get('e2\na.md')).toEqual({ before: v2, after: v3 })
  })
})
