import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { newTaskState, pendingRequirements, recordTaskReceipt, releaseEvidenceProblem, updateTask } from '../src/session/task-state.js'
import { SessionStore, type SessionRecord } from '../src/session/store.js'

test('不接受不存在或不匹配的命令证据', () => {
  const defined = updateTask(newTaskState(), { action: 'define', requirements: [{ id: 'ci', title: '确认 CI', commandIncludes: 'gh run view', outputIncludes: 'success' }] })
  expect(() => updateTask(defined, { action: 'satisfy', id: 'ci', receiptId: 'fake' })).toThrow('Evidence')
  const wrong = recordTaskReceipt(defined, 'wrong', 'echo success', 'success')
  expect(() => updateTask(wrong, { action: 'satisfy', id: 'ci', receiptId: 'wrong' })).toThrow('Evidence')
  const actual = recordTaskReceipt(defined, 'real', 'gh run view 123', 'success')
  expect(pendingRequirements(updateTask(actual, { action: 'satisfy', id: 'ci', receiptId: 'real' }))).toEqual([])
})

test('非发版任务写错完成条件时能重新定义，旧证据一起作废', () => {
  const requirement = { id: 'test', title: '测试通过', commandIncludes: 'pnpm test', outputIncludes: 'Tests 12 passed' }
  let state = updateTask(newTaskState(), { action: 'define', requirements: [requirement] })
  state = recordTaskReceipt(state, 'old', 'pnpm test', 'Tests 12 passed')
  state = updateTask(state, { action: 'satisfy', id: 'test', receiptId: 'old' })
  expect(pendingRequirements(state)).toEqual([])
  // 重新定义：新条件替换旧的，已经拿到的证据也不再算数
  const corrected = updateTask(state, { action: 'define', requirements: [{ ...requirement, outputIncludes: 'Tests 13 passed' }] })
  expect(corrected.requirements).toEqual([{ ...requirement, outputIncludes: 'Tests 13 passed', receiptId: null }])
  expect(corrected.receipts).toEqual([])
  expect(pendingRequirements(corrected)).toHaveLength(1)
  expect(() => updateTask(corrected, { action: 'satisfy', id: 'test', receiptId: 'old' })).toThrow('Evidence')
  // 也能整个换成另一组条件
  const rewritten = updateTask(corrected, { action: 'define', requirements: [{ id: 'lint', title: 'lint 通过', commandIncludes: 'pnpm lint', outputIncludes: 'ok' }] })
  expect(rewritten.requirements.map((item) => item.id)).toEqual(['lint'])
  // 第一次定义时留着定义前跑过的命令，之后的证据照常可用
  const first = updateTask(recordTaskReceipt(newTaskState(), 'early', 'pnpm lint', 'ok'), { action: 'define', requirements: [{ id: 'lint', title: 'lint 通过', commandIncludes: 'pnpm lint', outputIncludes: 'ok' }] })
  expect(pendingRequirements(updateTask(first, { action: 'satisfy', id: 'lint', receiptId: 'early' }))).toEqual([])
})

test('发版任务的完成条件不能覆盖、删减或换掉，四项的真实命令校验照旧', () => {
  const sha = '1234567890abcdef1234567890abcdef12345678'
  const commit = { id: 'commit', title: '提交', commandIncludes: 'git rev-parse HEAD', outputIncludes: sha }
  const push = { id: 'push', title: '远端', commandIncludes: 'git ls-remote origin', outputIncludes: sha }
  const ci = { id: 'ci', title: 'CI', commandIncludes: 'gh run view 123', outputIncludes: 'success' }
  const publish = { id: 'publish', title: '线上发布', commandIncludes: 'pnpm publish:release', outputIncludes: '已发布 0.1.2' }
  const requirements = [commit, push, ci, publish]
  const release = { ...newTaskState(), contractRequired: true }
  const defined = updateTask(release, { action: 'define', requirements })
  expect(() => updateTask(defined, { action: 'define', requirements })).toThrow('cannot be removed, weakened or replaced')
  expect(() => updateTask(defined, { action: 'define', requirements: [commit, push, ci] })).toThrow('cannot be removed, weakened or replaced')
  expect(() => updateTask(defined, { action: 'define', requirements: [{ ...commit, outputIncludes: 'committed' }, push, ci, publish] })).toThrow('cannot be removed')
  expect(defined.requirements).toEqual(requirements.map((item) => ({ ...item, receiptId: null })))
  // 四项少一项、或者用 echo 冒充提交，定义时就被拒
  expect(() => updateTask(release, { action: 'define', requirements: [commit, push, ci] })).toThrow('must include commit, push, ci, publish')
  expect(() => updateTask(release, { action: 'define', requirements: [{ ...commit, commandIncludes: `echo ${sha}` }, push, ci, publish] })).toThrow('real Git/CI/update-source query')
})

test('发布证据交叉核对 SHA、CI 成功和正式更新源发布结果', () => {
  const sha = '1234567890abcdef1234567890abcdef12345678'
  const state = newTaskState()
  state.contractRequired = true
  const requirements = [
    { id: 'commit', title: '提交', commandIncludes: 'git rev-parse HEAD', outputIncludes: sha },
    { id: 'push', title: '远端', commandIncludes: 'git ls-remote origin', outputIncludes: sha },
    { id: 'ci', title: 'CI', commandIncludes: 'gh run view 123', outputIncludes: 'success' },
    { id: 'publish', title: '线上发布', commandIncludes: 'pnpm publish:release', outputIncludes: '已发布 0.1.2' },
  ]
  let progress = updateTask(state, { action: 'define', requirements })
  expect(releaseEvidenceProblem(progress)).toContain('SHA')
  for (const item of requirements) {
    const output = item.id === 'ci' ? JSON.stringify({ headSha: sha, status: 'completed', conclusion: 'success' }) : item.outputIncludes
    progress = recordTaskReceipt(progress, item.id, item.commandIncludes, output)
    progress = updateTask(progress, { action: 'satisfy', id: item.id, receiptId: item.id })
  }
  expect(releaseEvidenceProblem(progress)).toBeNull()
  progress.receipts = progress.receipts.map((item) => item.id === 'ci' ? { ...item, output: 'success but still running' } : item)
  expect(releaseEvidenceProblem(progress)).toContain('CI evidence')
})

test('会话文件重载保留等待原因、完成要求和命令证据，旧记录兼容', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'diffra-task-state-'))
  try {
    const store = new SessionStore(dir)
    let state = updateTask(newTaskState(), { action: 'define', requirements: [{ id: 'ci', title: '等待 CI', commandIncludes: 'gh run view', outputIncludes: 'success' }] })
    state = recordTaskReceipt(state, 'receipt', 'gh run view 123', 'running')
    state.status = 'waiting'
    state.reason = '等待 CI 123'
    const record: SessionRecord = { version: 1, id: 'task-test', cwd: dir, title: '发布', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archived: false, turns: [], messages: [], compaction: null, taskState: state }
    await store.save(record)
    expect((await store.load(record.id)).taskState).toEqual(state)
    delete record.taskState
    await store.save(record)
    expect((await store.load(record.id)).taskState).toBeUndefined()
  } finally { await rm(dir, { recursive: true, force: true }) }
})
