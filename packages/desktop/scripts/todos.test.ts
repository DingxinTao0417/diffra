// 待办的重复和嵌套标签（src/shared/todos.ts）：node --test scripts/todos.test.ts
// 按纽约时区算，能测到夏令时切换（2026-03-08 凌晨 2 点跳到 3 点）时钟点不变
process.env.TZ = 'America/New_York'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeTodoLists, mergeTombstones, nextOccurrence, normalizeTodoTags, repeatLabel, syncableTodo, tagMatches, tagTree, type Todo, type TodoRepeat } from '../src/shared/todos.ts'

const local = (text: string) => new Date(text).getTime()
const localText = (iso: string) => {
  const date = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
const repeat = (every: TodoRepeat['every'], start: string, interval = 1): TodoRepeat => ({ every, interval, start: new Date(start).toISOString() })

test('重复：每天、隔两天、每周、每个工作日，取晚于给定时刻的下一次；钟点跨夏令时不变', () => {
  assert.equal(localText(nextOccurrence(repeat('day', '2026-03-01T09:00:00'), local('2026-03-01T09:00:00'))), '2026-03-02 09:00')
  assert.equal(localText(nextOccurrence(repeat('day', '2026-03-01T09:00:00'), local('2026-03-10T12:00:00'))), '2026-03-11 09:00')
  // 跨过 3 月 8 日的夏令时：还是 9 点
  assert.equal(localText(nextOccurrence(repeat('day', '2026-03-06T09:00:00'), local('2026-03-08T08:00:00'))), '2026-03-08 09:00')
  assert.equal(localText(nextOccurrence(repeat('day', '2026-03-01T09:00:00', 2), local('2026-03-04T10:00:00'))), '2026-03-05 09:00')
  assert.equal(localText(nextOccurrence(repeat('week', '2026-03-02T20:00:00'), local('2026-03-02T20:00:00'))), '2026-03-09 20:00')
  // 周五之后的下一个工作日是周一
  assert.equal(localText(nextOccurrence(repeat('weekday', '2026-03-06T09:00:00'), local('2026-03-06T09:30:00'))), '2026-03-09 09:00')
  // 一年后再算也对（不从第一次一个个试）
  assert.equal(localText(nextOccurrence(repeat('day', '2025-01-01T07:30:00'), local('2026-06-15T07:00:00'))), '2026-06-15 07:30')
})

test('重复：每月按第一次的日子算，31 号在小月落到月底、下个月回到 31 号；隔几个月', () => {
  const monthly = repeat('month', '2026-01-31T09:00:00')
  assert.equal(localText(nextOccurrence(monthly, local('2026-01-31T10:00:00'))), '2026-02-28 09:00')
  assert.equal(localText(nextOccurrence(monthly, local('2026-02-28T10:00:00'))), '2026-03-31 09:00')
  assert.equal(localText(nextOccurrence(monthly, local('2026-04-01T00:00:00'))), '2026-04-30 09:00')
  assert.equal(localText(nextOccurrence(repeat('month', '2026-01-15T09:00:00', 3), local('2026-01-20T00:00:00'))), '2026-04-15 09:00')
  assert.equal(repeatLabel(repeat('month', '2026-01-15T09:00:00', 3)), '每 3 个月')
  assert.equal(repeatLabel(repeat('weekday', '2026-01-15T09:00:00')), '每个工作日')
})

test('重复：闰年的 2 月——31 号、30 号、29 号开始的每月在闰年落到 29 日、平年落到 28 日；隔 12 个月的 2 月 29 日平年落到 28 日、下一个闰年回到 29 日', () => {
  for (const start of ['2027-12-31T09:00:00', '2027-12-30T09:00:00', '2028-01-29T09:00:00']) {
    assert.equal(localText(nextOccurrence(repeat('month', start), local('2028-02-01T00:00:00'))), '2028-02-29 09:00')
  }
  assert.equal(localText(nextOccurrence(repeat('month', '2026-12-29T09:00:00'), local('2027-02-01T00:00:00'))), '2027-02-28 09:00')
  const leapDay = repeat('month', '2028-02-29T09:00:00', 12)
  assert.equal(localText(nextOccurrence(leapDay, local('2028-02-29T10:00:00'))), '2029-02-28 09:00')
  assert.equal(localText(nextOccurrence(leapDay, local('2031-03-01T00:00:00'))), '2032-02-29 09:00')
  // 每天、每周跨过闰日不跳天
  assert.equal(localText(nextOccurrence(repeat('day', '2028-02-27T09:00:00'), local('2028-02-28T10:00:00'))), '2028-02-29 09:00')
  assert.equal(localText(nextOccurrence(repeat('week', '2028-02-22T09:00:00'), local('2028-02-23T00:00:00'))), '2028-02-29 09:00')
})

test('嵌套标签：按 / 分层，每层去空白；按上一层筛选时下面各层都算；标签树补出各层上级', () => {
  assert.deepEqual(normalizeTodoTags([' 工作 / 项目A ', '工作//', '#生活/购物，工作/项目a']), ['工作/项目A', '工作', '生活/购物'])
  assert.equal(tagMatches('工作/项目A', '工作'), true)
  assert.equal(tagMatches('工作/项目A', '工作/项目a'), true)
  assert.equal(tagMatches('工作区', '工作'), false)
  assert.equal(tagMatches('生活', '工作'), false)
  assert.deepEqual(tagTree(['工作/项目A/前端', '生活', '工作/项目B']), [
    { tag: '工作', label: '工作', depth: 0 },
    { tag: '工作/项目A', label: '项目A', depth: 1 },
    { tag: '工作/项目A/前端', label: '前端', depth: 2 },
    { tag: '工作/项目B', label: '项目B', depth: 1 },
    { tag: '生活', label: '生活', depth: 0 },
  ])
})

const todo = (id: string, text: string, updatedAt: string | null, extra: Partial<Todo> = {}): Todo => ({
  id,
  text,
  project: null,
  tags: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  done: false,
  sentTo: null,
  ...(updatedAt ? { updatedAt } : {}),
  ...extra,
})

test('同步合并：同一条取改得晚的（一样新留前一份），两边各自新加的都留；墓碑晚于最后一次改动才删', () => {
  const local = [todo('a', '本机改过', '2026-02-02T00:00:00.000Z'), todo('b', '本机旧的', null), todo('c', '要被删', '2026-02-01T00:00:00.000Z')]
  const remote = [todo('a', '对方旧的', '2026-02-01T00:00:00.000Z'), todo('b', '对方改过', '2026-02-03T00:00:00.000Z'), todo('d', '对方新加', null), todo('c', '对方改过要删的', '2026-02-05T00:00:00.000Z')]
  const tombstones = [{ id: 'c', at: '2026-02-04T00:00:00.000Z' }]
  // c 在删了以后又被对方改过：改动晚于墓碑，留着
  assert.deepEqual(
    mergeTodoLists(local, remote, tombstones).map((item) => `${item.id}:${item.text}`),
    ['a:本机改过', 'b:对方改过', 'c:对方改过要删的', 'd:对方新加'],
  )
  assert.deepEqual(
    mergeTodoLists(local, remote, [{ id: 'c', at: '2026-02-06T00:00:00.000Z' }]).map((item) => item.id),
    ['a', 'b', 'd'],
  )
  assert.deepEqual(mergeTodoLists([todo('x', '前', '2026-02-01T00:00:00.000Z')], [todo('x', '后', '2026-02-01T00:00:00.000Z')], []).map((item) => item.text), ['前'])
})

test('墓碑：同一条留最晚的，超过 90 天的扔掉，按时间从新到旧；定时发给任务的待办不同步', () => {
  const now = Date.parse('2026-06-01T00:00:00.000Z')
  assert.deepEqual(
    mergeTombstones([{ id: 'a', at: '2026-05-01T00:00:00.000Z' }, { id: 'old', at: '2026-01-01T00:00:00.000Z' }], [{ id: 'a', at: '2026-05-20T00:00:00.000Z' }, { id: 'b', at: '2026-05-10T00:00:00.000Z' }], now),
    [{ id: 'a', at: '2026-05-20T00:00:00.000Z' }, { id: 'b', at: '2026-05-10T00:00:00.000Z' }],
  )
  assert.equal(syncableTodo({ schedule: { at: '2026-01-01T00:00:00.000Z', action: { kind: 'remind' }, result: null } }), true)
  assert.equal(syncableTodo({ schedule: { at: '2026-01-01T00:00:00.000Z', action: { kind: 'send', text: 'x', target: { kind: 'new', project: null, design: false } }, result: null } }), false)
  assert.equal(syncableTodo({}), true)
})
