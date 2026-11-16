import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { runTurn } from '../src/session/loop.js'
import { buildSystemPrompt } from '../src/session/prompt.js'
import { SessionStore } from '../src/session/store.js'
import { makeSession, NO_RULES, recordingIO, scriptedModel, useTempProject } from './loop-helpers.js'

// 无项目任务的 v2 部分（M11）：提示词里说明文件夹是新建的、写了文件后重新选一次规则包、转成正式项目
useTempProject()

let dir: string | null = null
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

describe('无项目任务', () => {
  test('系统提示词里说明工作目录是为这个任务新建的空文件夹；项目任务没有这一段', async () => {
    const base = { checks: { afterEdit: null, beforeFinish: null }, readOnlyPaths: [], rules: NO_RULES }
    expect(await buildSystemPrompt(null, { ...base, noProject: true }, [])).toContain('a new empty folder that Diffra created for this task')
    expect(await buildSystemPrompt(null, base, [])).not.toContain('## Working folder')
  })

  test('文件夹还空时不重建；有了文件，下一轮开始时重建一次系统提示词，之后不再重建', async () => {
    const calls: number[] = []
    let files = 0
    const model = scriptedModel([{ text: '一' }, { text: '二' }, { text: '三' }])
    const session = await makeSession(model, undefined, undefined, undefined, undefined, undefined, undefined, {
      rebuildPrompt: async () => {
        calls.push(files)
        return files === 0 ? null : { rulePacks: [], systemPrompt: 'REBUILT PROMPT', workerPrompt: 'REBUILT WORKER' }
      },
    })
    const original = session.systemPrompt
    await runTurn(session, { id: 't1', text: '先看看' }, recordingIO())
    expect(session.systemPrompt).toBe(original)
    files = 3
    await runTurn(session, { id: 't2', text: '写个文件' }, recordingIO())
    expect(session.systemPrompt).toBe('REBUILT PROMPT')
    expect(session.workerPrompt).toBe('REBUILT WORKER')
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('REBUILT PROMPT')
    await runTurn(session, { id: 't3', text: '再改改' }, recordingIO())
    expect(calls).toEqual([0, 3])
  })

  test('转成正式项目：记录和索引里的无项目标记清掉，别的不变', async () => {
    dir = mkdtempSync(join(tmpdir(), 'diffra-promote-'))
    const store = new SessionStore(dir)
    await store.save({ version: 1, id: 's1', cwd: 'D:\\Docs\\Diffra\\2026-11-15 写周报', title: '写周报', createdAt: '2026-11-15T00:00:00Z', updatedAt: '2026-11-15T00:00:00Z', archived: false, noProject: true, turns: [], messages: [], compaction: null })
    expect((await store.list())[0]?.noProject).toBe(true)
    const entry = await store.update('s1', { noProject: false })
    expect(entry).toMatchObject({ noProject: false, title: '写周报', cwd: 'D:\\Docs\\Diffra\\2026-11-15 写周报' })
    expect((await new SessionStore(dir).list())[0]?.noProject).toBe(false)
    expect((await store.load('s1')).noProject).toBe(false)
  })
})
