import { afterEach, describe, expect, test, vi } from 'vitest'
import type { CollaborationState, CollaborationTask, CollaborationWorker } from '../src/collaboration-types.js'
import { collaborationStateSchema, createTeamTask, newCollaborationState, recoverCollaborationState, taskViews, updateTeamTask } from '../src/session/collaboration-board.js'

function worker(id: string, status: CollaborationWorker['status'] = 'queued'): CollaborationWorker {
  return {
    id,
    name: id,
    color: '#2563EB',
    task: '实现任务',
    role: 'implementer',
    typeName: null,
    readOnly: false,
    context: 'fresh',
    files: [],
    nodes: [],
    cardId: `card-${id}`,
    turnId: 'turn-1',
    status,
    activation: 0,
    messages: [],
    summary: null,
    issues: null,
    verdict: null,
    checks: [],
    startedAt: null,
    endedAt: null,
    tokens: 0,
    edited: [],
    worktree: null,
    resultRevision: 0,
    notifiedRevision: 0,
  }
}

function team(): CollaborationState {
  const state = newCollaborationState()
  state.workers.push(worker('worker-1'), worker('worker-2'))
  return state
}

function create(state: CollaborationState, fields: Record<string, unknown> = {}): CollaborationTask {
  return createTeamTask(state, 'lead', { subject: '实现共享任务板', description: '完成任务与测试', ...fields })
}

function update(state: CollaborationState, task: CollaborationTask, action: string, fields: Record<string, unknown> = {}, caller = 'lead'): CollaborationTask {
  return updateTeamTask(state, caller, { taskId: task.id, expectedRevision: task.revision, action, ...fields })
}

function expectUnchanged(state: CollaborationState, operation: () => unknown, error?: RegExp): void {
  const before = structuredClone(state)
  expect(operation).toThrow(error)
  expect(state).toEqual(before)
}

afterEach(() => vi.unstubAllGlobals())

describe('创建与计数', () => {
  test('初始状态独立，落盘格式完整且验收待处理', () => {
    const state = newCollaborationState()
    expect(state).toEqual({
      version: 1,
      workers: [],
      messages: [],
      tasks: [],
      nextTaskNumber: 1,
      acceptance: { status: 'pending', fingerprint: null, reviewerId: null, testerId: null, reason: null },
    })
    expect(collaborationStateSchema.parse(state)).toEqual(state)
    create(state)
    expect(newCollaborationState().tasks).toEqual([])
  })

  test('主智能体和已有工人可创建未归属待办；不激活工人，也不修改验收或消息', () => {
    const state = team()
    const before = structuredClone(state)
    const first = create(state, { subject: '  第一个任务  ' })
    const second = createTeamTask(state, 'worker-1', { subject: '第二个任务', description: '', blockedBy: [first.id] })
    expect(first).toEqual({ id: 'task-1', revision: 1, subject: '第一个任务', description: '完成任务与测试', status: 'pending', owner: null, blockedBy: [], writeScopes: [] })
    expect(second).toMatchObject({ id: 'task-2', revision: 1, status: 'pending', owner: null, blockedBy: [first.id] })
    expect(state.nextTaskNumber).toBe(3)
    expect(state.workers).toEqual(before.workers)
    expect(state.messages).toEqual(before.messages)
    expect(state.acceptance).toEqual(before.acceptance)
  })

  test('未知调用方创建被拒绝且不消耗编号', () => {
    const state = team()
    expectUnchanged(state, () => createTeamTask(state, 'unknown', { subject: '任务', description: '' }), /成员不存在/)
    expect(create(state).id).toBe('task-1')
  })

  test('仅未删除的任务计入 256 上限；墓碑保留且编号不复用', () => {
    const state = team()
    for (let index = 0; index < 256; index += 1) create(state)
    expectUnchanged(state, () => create(state), /256/)
    const first = state.tasks[0]
    update(state, first, 'delete')
    expect(first).toMatchObject({ id: 'task-1', status: 'deleted', revision: 2 })
    expect(create(state).id).toBe('task-257')
    expect(state.tasks).toHaveLength(257)
    expect(state.nextTaskNumber).toBe(258)
    expect(collaborationStateSchema.safeParse(state).success).toBe(true)
    expectUnchanged(state, () => create(state), /256/)
    expectUnchanged(state, () => update(state, first, 'reopen'), /已删除/)
  })

  test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])('无效或耗尽的计数器不修改状态：%s', (number) => {
    const state = team()
    state.nextTaskNumber = number
    expectUnchanged(state, () => create(state), /编号/)
  })

  test('计数器碰撞不覆盖已有任务', () => {
    const state = team()
    create(state)
    state.nextTaskNumber = 1
    expectUnchanged(state, () => create(state), /已存在/)
  })
})

describe('修订号、归属与状态', () => {
  test('CAS 抢占只有第一次成功；旧修订号不能覆盖负责人或内容', async () => {
    const state = team()
    const task = create(state)
    const input = { taskId: task.id, expectedRevision: 1, action: 'claim' }
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => updateTeamTask(state, 'worker-1', input)),
      Promise.resolve().then(() => updateTeamTask(state, 'worker-2', input)),
    ])
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected'])
    expect(outcomes[1]).toMatchObject({ reason: expect.objectContaining({ message: expect.stringContaining('修订号冲突') }) })
    expect(task).toMatchObject({ status: 'in_progress', owner: 'worker-1', revision: 2 })
    expectUnchanged(state, () => updateTeamTask(state, 'lead', { taskId: task.id, expectedRevision: 1, action: 'edit', subject: '过期覆盖' }), /修订号冲突/)
    expect(state.workers.map((item) => item.status)).toEqual(['queued', 'queued'])
  })

  test('工人只可修改自己的任务，不能借 owner 字段伪造归属', () => {
    const state = team()
    const task = create(state)
    expectUnchanged(state, () => update(state, task, 'edit', { subject: '越权修改' }, 'worker-1'), /自己负责/)
    update(state, task, 'claim', {}, 'worker-1')
    for (const action of ['edit', 'release', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete']) {
      const fields = action === 'edit' ? { subject: '越权' } : action === 'set_dependencies' ? { blockedBy: [] } : action === 'reassign' ? { owner: 'worker-2' } : {}
      expectUnchanged(state, () => update(state, task, action, fields, 'worker-2'), /自己负责/)
    }
    expectUnchanged(state, () => update(state, task, 'edit', { subject: '伪造', owner: 'worker-2' }, 'worker-1'), /参数无效/)
    update(state, task, 'edit', { subject: '合法编辑', description: '', writeScopes: ['src'] }, 'worker-1')
    expect(task).toMatchObject({ subject: '合法编辑', description: '', writeScopes: ['src'], revision: 3 })
  })

  test('未知调用方不能操作已知任务；未知任务和墓碑不可更新', () => {
    const state = team()
    const task = create(state)
    expectUnchanged(state, () => update(state, task, 'claim', {}, 'unknown'), /成员不存在/)
    expectUnchanged(state, () => updateTeamTask(state, 'lead', { taskId: 'missing', expectedRevision: 1, action: 'claim' }), /不存在/)
    update(state, task, 'delete')
    for (const action of ['claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete']) {
      const fields = action === 'edit' ? { subject: '恢复' } : action === 'set_dependencies' ? { blockedBy: [] } : action === 'reassign' ? { owner: 'lead' } : {}
      expectUnchanged(state, () => update(state, task, action, fields), /已删除/)
    }
  })

  test('只有主智能体可重新分配给已有成员；分配不等于开工，负责人可显式认领', () => {
    const state = team()
    const task = create(state)
    update(state, task, 'claim', {}, 'worker-1')
    expectUnchanged(state, () => update(state, task, 'reassign', { owner: 'worker-2' }, 'worker-1'), /只有主智能体/)
    expectUnchanged(state, () => update(state, task, 'reassign', { owner: 'missing' }), /成员不存在/)
    expectUnchanged(state, () => update(state, task, 'reassign', { owner: null }), /参数无效/)
    update(state, task, 'reassign', { owner: 'worker-2' })
    expect(task).toMatchObject({ status: 'pending', owner: 'worker-2', revision: 3 })
    expectUnchanged(state, () => update(state, task, 'claim'), /未归属或分配给自己/)
    update(state, task, 'claim', {}, 'worker-2')
    expect(task).toMatchObject({ status: 'in_progress', owner: 'worker-2', revision: 4 })
    update(state, task, 'reassign', { owner: 'lead' })
    update(state, task, 'claim')
    expect(task.owner).toBe('lead')
    expect(state.workers.map((item) => item.status)).toEqual(['queued', 'queued'])
  })

  test('释放、完成、重开、删除各更新一次修订号，保留完成任务的负责人和墓碑内容', () => {
    const state = team()
    const task = create(state)
    expectUnchanged(state, () => update(state, task, 'complete'), /进行中/)
    expectUnchanged(state, () => update(state, task, 'release'), /已归属/)
    expectUnchanged(state, () => update(state, task, 'reopen'), /已完成/)
    update(state, task, 'claim', {}, 'worker-1')
    expectUnchanged(state, () => update(state, task, 'claim', {}, 'worker-1'), /待办/)
    update(state, task, 'release', {}, 'worker-1')
    expect(task).toMatchObject({ revision: 3, owner: null, status: 'pending' })
    update(state, task, 'claim')
    update(state, task, 'complete')
    expect(task).toMatchObject({ revision: 5, owner: 'lead', status: 'completed' })
    expectUnchanged(state, () => update(state, task, 'release'), /未完成/)
    expectUnchanged(state, () => update(state, task, 'complete'), /进行中/)
    update(state, task, 'reopen')
    expect(task).toMatchObject({ revision: 6, owner: 'lead', status: 'pending' })
    update(state, task, 'delete')
    expect(task).toMatchObject({ revision: 7, owner: 'lead', status: 'deleted', subject: '实现共享任务板', description: '完成任务与测试' })
    expect(taskViews(state)).toEqual([])
    expect(state.tasks).toEqual([task])
  })

  test('主智能体可编辑、释放、完成、重开和删除工人任务', () => {
    const state = team()
    const task = create(state)
    update(state, task, 'claim', {}, 'worker-1')
    update(state, task, 'edit', { subject: '主智能体编辑' })
    update(state, task, 'release')
    update(state, task, 'claim', {}, 'worker-2')
    update(state, task, 'complete')
    update(state, task, 'reopen')
    update(state, task, 'delete')
    expect(task).toMatchObject({ revision: 8, status: 'deleted', owner: 'worker-2' })
  })

  test('重新分配已完成任务不隐式重开，只有 reopen 改回待办', () => {
    const state = team()
    const task = create(state)
    update(state, task, 'claim')
    update(state, task, 'complete')
    update(state, task, 'reassign', { owner: 'worker-1' })
    expect(task).toMatchObject({ status: 'completed', owner: 'worker-1', revision: 4 })
    update(state, task, 'reopen', {}, 'worker-1')
    expect(task).toMatchObject({ status: 'pending', owner: 'worker-1', revision: 5 })
  })

  test('安全整数范围外的修订号不可递增', () => {
    const state = team()
    const task = create(state)
    task.revision = Number.MAX_SAFE_INTEGER
    expectUnchanged(state, () => update(state, task, 'claim'), /安全范围/)
  })
})

describe('依赖 DAG 与就绪状态', () => {
  test('依赖全部完成后才可认领；完成和重新打开后实时派生就绪状态', () => {
    const state = team()
    const first = create(state)
    const second = create(state)
    const last = create(state, { blockedBy: [first.id, second.id] })
    expect(taskViews(state).map((task) => task.ready)).toEqual([true, true, false])
    expectUnchanged(state, () => update(state, last, 'claim', {}, 'worker-1'), /未就绪/)
    update(state, first, 'claim')
    update(state, first, 'complete')
    expect(taskViews(state).find((task) => task.id === last.id)?.ready).toBe(false)
    update(state, second, 'claim')
    update(state, second, 'complete')
    expect(taskViews(state).find((task) => task.id === last.id)?.ready).toBe(true)
    update(state, last, 'claim', {}, 'worker-1')
    expect(taskViews(state).map((task) => task.ready)).toEqual([false, false, false])
    update(state, first, 'reopen')
    expectUnchanged(state, () => update(state, last, 'complete', {}, 'worker-1'), /依赖尚未完成/)
    update(state, first, 'claim')
    update(state, first, 'complete')
    update(state, last, 'complete', {}, 'worker-1')
    expect(last.status).toBe('completed')
  })

  test('创建拒绝不存在、已删除、自依赖和重复依赖，不消耗编号', () => {
    const state = team()
    const deleted = create(state)
    update(state, deleted, 'delete')
    for (const blockedBy of [['missing'], [deleted.id], ['task-2'], [deleted.id, deleted.id]]) {
      expectUnchanged(state, () => create(state, { blockedBy }), /依赖/)
    }
    expect(state.nextTaskNumber).toBe(2)
  })

  test('更新拒绝不存在、已删除、自依赖、重复和长环，失败保留原依赖与修订号', () => {
    const state = team()
    const first = create(state)
    const second = create(state, { blockedBy: [first.id] })
    const third = create(state, { blockedBy: [second.id] })
    const deleted = create(state)
    update(state, deleted, 'delete')
    for (const blockedBy of [['missing'], [deleted.id], [first.id], [second.id], [third.id], [third.id, third.id]]) {
      expectUnchanged(state, () => update(state, first, 'set_dependencies', { blockedBy }), /依赖|环/)
    }
    update(state, third, 'set_dependencies', { blockedBy: [first.id] })
    update(state, second, 'set_dependencies', { blockedBy: [third.id] })
    expect(second.blockedBy).toEqual([third.id])
    expectUnchanged(state, () => update(state, first, 'set_dependencies', { blockedBy: [second.id] }), /环/)
    update(state, second, 'set_dependencies', { blockedBy: [] })
    expect(second.blockedBy).toEqual([])
  })

  test('菱形依赖合法；删除不能让存活任务依赖墓碑，先解除依赖或删除下游', () => {
    const state = team()
    const root = create(state)
    const left = create(state, { blockedBy: [root.id] })
    const right = create(state, { blockedBy: [root.id] })
    const leaf = create(state, { blockedBy: [left.id, right.id] })
    expect(collaborationStateSchema.safeParse(state).success).toBe(true)
    expectUnchanged(state, () => update(state, root, 'delete'), /已删除/)
    expectUnchanged(state, () => update(state, left, 'delete'), /已删除/)
    update(state, leaf, 'delete')
    update(state, left, 'delete')
    update(state, right, 'set_dependencies', { blockedBy: [] })
    update(state, root, 'delete')
    expect(taskViews(state).map((task) => task.id)).toEqual([right.id])
    expect(collaborationStateSchema.safeParse(state).success).toBe(true)
  })
})

describe('写入范围与视图', () => {
  test('路径分隔符、点片段和重复范围规范化；输入和视图数组不共享可变引用', () => {
    const state = team()
    const scopes = [' ./src\\session// ', 'src/session/', 'docs/./guide.md', 'docs/../src/session', 'src\\..\\src/session']
    const task = create(state, { writeScopes: scopes })
    expect(task.writeScopes).toEqual(['src/session', 'docs/guide.md'])
    scopes.push('outside-input-change')
    expect(task.writeScopes).toEqual(['src/session', 'docs/guide.md'])
    const view = taskViews(state)[0]
    view.writeScopes.push('outside-view-change')
    view.blockedBy.push('missing')
    view.subject = '修改视图'
    expect(task).toMatchObject({ subject: '实现共享任务板', writeScopes: ['src/session', 'docs/guide.md'], blockedBy: [] })
    update(state, task, 'edit', { writeScopes: ['tests\\board.ts', './tests/board.ts/'] })
    expect(task.writeScopes).toEqual(['tests/board.ts'])
  })

  test('同路径或父子目录与其他进行中任务重叠时提示，不误报同前缀或未开工任务，不阻止认领', () => {
    const state = team()
    const running = create(state, { subject: '正在修改', writeScopes: ['src/session', 'docs/guide.md'] })
    const target = create(state, { writeScopes: ['src/session/board.ts', 'docs'] })
    const separate = create(state, { writeScopes: ['src/sessions', 'docs-old'] })
    create(state, { writeScopes: ['src'] })
    update(state, running, 'claim', {}, 'worker-1')
    let views = taskViews(state)
    expect(views.find((task) => task.id === running.id)?.writeScopeWarnings).toEqual([])
    expect(views.find((task) => task.id === target.id)?.writeScopeWarnings).toEqual([expect.stringContaining(running.id)])
    expect(views.find((task) => task.id === separate.id)?.writeScopeWarnings).toEqual([])
    expect(views.find((task) => task.id === target.id)?.ready).toBe(true)
    update(state, target, 'claim', {}, 'worker-2')
    views = taskViews(state)
    expect(views.find((task) => task.id === running.id)?.writeScopeWarnings).toEqual([expect.stringContaining(target.id)])
    update(state, running, 'complete', {}, 'worker-1')
    expect(taskViews(state).find((task) => task.id === target.id)?.writeScopeWarnings).toEqual([])
  })

  test.each(['win32', 'linux'])('%s 按平台处理大小写和范围去重', (platform) => {
    vi.stubGlobal('process', { ...process, platform })
    const state = team()
    const running = create(state, { writeScopes: ['Src/Session'] })
    const target = create(state, { writeScopes: ['src/session/board.ts', 'SRC/SESSION/board.ts'] })
    update(state, running, 'claim')
    expect(target.writeScopes).toHaveLength(platform === 'win32' ? 1 : 2)
    expect(taskViews(state).find((task) => task.id === target.id)?.writeScopeWarnings).toHaveLength(platform === 'win32' ? 1 : 0)
  })

  test.each(['', ' ', '.', './', '..', '../secret', 'src/../../secret', 'src\\..\\..\\secret', 'src/..', '/etc/passwd', '\\Windows', '\\\\server\\share', 'C:\\workspace\\file', 'C:relative', 'https://example.com/file', 'src\0file', 'src\nfile', 'src/*.ts', 'src/file?', 'src/<file>', 'src/file:stream', 'src/file.', 'src/dir /file'])('拒绝无效范围且不修改状态：%j', (scope) => {
    const state = team()
    expectUnchanged(state, () => create(state, { writeScopes: [scope] }), /参数无效/)
    const task = create(state)
    expectUnchanged(state, () => update(state, task, 'edit', { writeScopes: [scope] }), /参数无效/)
  })
})

describe('输入校验', () => {
  test.each([
    null,
    [],
    {},
    { subject: '任务' },
    { subject: '', description: '' },
    { subject: '   ', description: '' },
    { subject: 'a'.repeat(201), description: '' },
    { subject: '任务', description: 'a'.repeat(20_001) },
    { subject: 1, description: '' },
    { subject: '任务', description: null },
    { subject: '任务', description: '', owner: 'lead' },
    { subject: '任务', description: '', blockedBy: null },
    { subject: '任务', description: '', blockedBy: [1] },
    { subject: '任务', description: '', blockedBy: ['a'.repeat(129)] },
    { subject: '任务', description: '', blockedBy: Array.from({ length: 257 }, () => 'task-1') },
    { subject: '任务', description: '', writeScopes: [1] },
    { subject: '任务', description: '', writeScopes: ['a'.repeat(1025)] },
    { subject: '任务', description: '', writeScopes: Array.from({ length: 51 }, () => 'src') },
  ])('创建拒绝错误类型、额外字段及超限输入 %#', (input) => {
    const state = team()
    expectUnchanged(state, () => createTeamTask(state, 'lead', input), /参数无效/)
  })

  test.each([
    {},
    { action: 'unknown' },
    { action: 'edit' },
    { action: 'edit', subject: '' },
    { action: 'edit', subject: 'a'.repeat(201) },
    { action: 'edit', description: 'a'.repeat(20_001) },
    { action: 'edit', blockedBy: [] },
    { action: 'set_dependencies' },
    { action: 'set_dependencies', blockedBy: Array.from({ length: 257 }, () => 'task-1') },
    { action: 'set_dependencies', blockedBy: ['a'.repeat(129)] },
    { action: 'reassign' },
    { action: 'reassign', owner: '' },
    { action: 'claim', owner: 'worker-1' },
    { action: 'claim', writeScopes: ['src'] },
    { action: 'claim', expectedRevision: 0 },
    { action: 'claim', expectedRevision: -1 },
    { action: 'claim', expectedRevision: 1.5 },
    { action: 'claim', expectedRevision: '1' },
    { action: 'claim', expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { action: 'claim', taskId: '' },
    { action: 'claim', taskId: 'a'.repeat(129) },
  ])('更新按 action 校验字段及修订号 %#', (fields) => {
    const state = team()
    const task = create(state)
    expectUnchanged(state, () => updateTeamTask(state, 'lead', { taskId: task.id, expectedRevision: task.revision, ...fields }), /参数无效/)
  })

  test('长度和数量边界可用，空描述和清空范围不被忽略', () => {
    const state = team()
    const task = create(state, { subject: 'a'.repeat(200), description: 'b'.repeat(20_000), writeScopes: Array.from({ length: 50 }, (_, index) => `${index}/${'c'.repeat(1020)}`) })
    expect(task.writeScopes).toHaveLength(50)
    update(state, task, 'edit', { description: '', writeScopes: [] })
    expect(task).toMatchObject({ description: '', writeScopes: [] })
  })
})

describe('落盘验证与恢复', () => {
  test('完整 worker、消息、工作树、结果和验收字段往返保留；接入点和密钥等多余字段丢弃', () => {
    const state = team()
    const first = state.workers[0]
    first.messages = [{ role: 'system', content: '系统说明' }, { role: 'assistant', content: [{ type: 'text', text: '结果' }] }]
    first.worktree = { repoRoot: '/project', dir: '/trees/worker-1', cwd: '/trees/worker-1/app', links: ['node_modules'], baseTree: 'base', integratedTree: 'integrated' }
    first.summary = '完成'
    first.issues = '无'
    first.verdict = 'passed'
    first.checks = [{ command: 'pnpm test', succeeded: true }]
    first.startedAt = 100
    first.endedAt = 200
    first.tokens = 500
    first.edited = ['src/board.ts']
    first.resultRevision = 2
    first.notifiedRevision = 1
    state.messages.push({ id: 'message-1', sender: 'lead', recipient: first.id, content: '请检查', createdAt: '2026-01-01T00:00:00Z', status: 'pending' })
    state.acceptance = { status: 'testing', fingerprint: 'tree-1', reviewerId: 'worker-1', testerId: 'worker-2', reason: '检查中' }
    create(state)
    const stored = { ...state, endpoint: { apiKey: 'test-only' }, apiKey: 'test-only', workers: state.workers.map((item) => ({ ...item, endpoint: { apiKey: 'test-only' }, apiKey: 'test-only' })) }
    expect(collaborationStateSchema.parse(JSON.parse(JSON.stringify(stored)))).toEqual(state)
  })

  test.each([
    { version: 2 },
    { nextTaskNumber: 0 },
    { nextTaskNumber: 1.5 },
    { nextTaskNumber: Number.MAX_SAFE_INTEGER + 1 },
    { tasks: [{ id: 'task-1' }] },
    { acceptance: { status: 'completed' } },
    { messages: [{ id: 'message-1', sender: 'lead', recipient: 'worker-1', content: '', createdAt: '昨天', status: 'pending' }] },
  ])('落盘字段无效时拒绝整份状态 %#', (fields) => {
    expect(collaborationStateSchema.safeParse({ ...team(), ...fields }).success).toBe(false)
  })

  test.each([
    { status: 'invalid' },
    { role: 'lead' },
    { tokens: -1 },
    { activation: 1.5 },
    { resultRevision: -1 },
    { notifiedRevision: '1' },
    { worktree: {} },
    { checks: [{ command: 'pnpm test', succeeded: 'yes' }] },
    { messages: [null] },
    { messages: [{ role: 'invalid', content: '' }] },
    { messages: [{ role: { toString: (): string => 'user' }, content: '' }] },
    { messages: [{ role: 'user' }] },
    { messages: [{ role: 'assistant', content: 1 }] },
  ])('落盘 worker 字段和模型消息基础结构验证 %#', (fields) => {
    const state = team()
    expect(collaborationStateSchema.safeParse({ ...state, workers: [{ ...worker('worker-1'), ...fields }] }).success).toBe(false)
  })

  test('落盘拒绝重复 id、无效归属、计数器倒退和损坏的依赖图', () => {
    const state = team()
    const first = create(state)
    const second = create(state, { blockedBy: [first.id] })
    const invalidStates = [
      { ...state, workers: [worker('lead')] },
      { ...state, workers: [worker('worker-1'), worker('worker-1')] },
      { ...state, tasks: [first, first] },
      { ...state, nextTaskNumber: 2 },
      { ...state, tasks: [{ ...first, owner: 'missing' }, second] },
      { ...state, tasks: [{ ...first, status: 'in_progress' }, second] },
      { ...state, tasks: [{ ...first, blockedBy: [second.id] }, second] },
      { ...state, tasks: [{ ...first, status: 'deleted' }, second] },
      { ...state, tasks: [{ ...first, blockedBy: ['missing'] }, second] },
      { ...state, tasks: [{ ...first, blockedBy: [first.id] }, second] },
      { ...state, tasks: [first, { ...second, blockedBy: [first.id, first.id] }] },
      { ...state, tasks: [first, { ...second, writeScopes: ['../escape'] }] },
    ]
    for (const invalid of invalidStates) expect(collaborationStateSchema.safeParse(invalid).success).toBe(false)
  })

  test('落盘也执行 256 上限，但允许更多墓碑', () => {
    const state = team()
    const template = create(state)
    const tasks = Array.from({ length: 257 }, (_, index) => ({ ...template, id: `task-${index + 1}` }))
    expect(collaborationStateSchema.safeParse({ ...state, tasks, nextTaskNumber: 258 }).success).toBe(false)
    tasks[0] = { ...tasks[0], status: 'deleted' }
    expect(collaborationStateSchema.safeParse({ ...state, tasks, nextTaskNumber: 258 }).success).toBe(true)
  })

  test('恢复仅将 running/queued 标记 interrupted，不消费 pending 消息或改动任务和验收，重复恢复无变化', () => {
    const state = team()
    const statuses: CollaborationWorker['status'][] = ['running', 'queued', 'completed', 'failed', 'cancelled', 'interrupted']
    state.workers = statuses.map((status, index) => worker(`worker-${index + 1}`, status))
    state.workers[0].messages.push({ role: 'user', content: '保留上下文' })
    const task = create(state)
    update(state, task, 'claim', {}, 'worker-1')
    state.messages = [
      { id: 'message-1', sender: 'lead', recipient: 'worker-1', content: '待处理', createdAt: '2026-01-01T00:00:00Z', status: 'pending' },
      { id: 'message-2', sender: 'worker-2', recipient: 'lead', content: '已处理', createdAt: '2026-01-01T00:00:00Z', status: 'delivered' },
    ]
    state.acceptance.status = 'reviewing'
    const before = structuredClone(state)
    expect(recoverCollaborationState(state)).toBe(true)
    expect(state.workers.map((item) => item.status)).toEqual(['interrupted', 'interrupted', 'completed', 'failed', 'cancelled', 'interrupted'])
    expect(state).toEqual({ ...before, workers: before.workers.map((item) => item.status === 'running' || item.status === 'queued' ? { ...item, status: 'interrupted' } : item) })
    const recovered = structuredClone(state)
    expect(recoverCollaborationState(state)).toBe(false)
    expect(state).toEqual(recovered)
    expect(collaborationStateSchema.parse(state)).toEqual(state)
    expect(recoverCollaborationState(newCollaborationState())).toBe(false)
  })
})
