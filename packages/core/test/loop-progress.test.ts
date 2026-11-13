import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, test } from 'vitest'
import { goalContinuation } from '../src/session/goal.js'
import { runTurn } from '../src/session/loop.js'
import {
  addFile,
  checkResults,
  exec,
  lastTaskState,
  makeSession,
  patch,
  project,
  read,
  recordingIO,
  replaceLines,
  scriptedModel,
  type Step,
  turnOutcomes,
  useTempProject,
  verifications,
} from './loop-helpers.js'

// 主循环里和「有没有进展」相关的规则：防打转、步数上限、结束门禁的检查进展计数、兜底模型、目标模式

useTempProject()

const notices = (io: { updates: SessionUpdate[] }) => io.updates.flatMap((update) => (update.sessionUpdate === 'notice' ? [update.title] : []))
const noticesWithText = (io: { updates: SessionUpdate[] }) =>
  io.updates.flatMap((update) => (update.sessionUpdate === 'notice' ? [{ title: update.title, description: update.description ?? '' }] : []))
const promptOf = (model: MockLanguageModelV4, index: number) => JSON.stringify(model.doStreamCalls[index]?.prompt)
// 第 index 次调模型时对话里的用户消息（不含 Diffra 补的上下文），按顺序
function userTexts(model: MockLanguageModelV4, index: number): string[] {
  return (model.doStreamCalls[index]?.prompt ?? [])
    .flatMap((message) => (message.role === 'user' ? [message.content.map((part) => (part.type === 'text' ? part.text : '')).join('')] : []))
    .filter((text) => !text.startsWith('[Diffra] Context'))
}
const cardsTitled = (io: { updates: SessionUpdate[] }, title: string) =>
  io.updates.flatMap((update) => (update.sessionUpdate === 'tool_call' && update.title === title ? [update] : []))
const usageRoles = (io: { usage: Array<{ role: string; modelId: string }> }) => io.usage.map((call) => [call.role, call.modelId])

const GATE_FEEDBACK =
  '[Diffra] Before ending the turn Diffra ran the project checks on your changes, and the task is not finished yet. ' +
  'Fix the problems below and continue; the checks run again the next time you end your turn.'
const SAME_CHANGE_HINT = 'If the remaining errors are in files that belong to the same change, fix them together: one apply_patch can change several files.'
const STUCK_REMINDER =
  '[Diffra] You made the same call 3 times and got the same result each time, without changing any file in between. ' +
  'Stop repeating it: try a different approach, or stop and tell the user what is blocking you.'
const STUCK_NOTICE = '智能体在重复同样的操作，已停止'
const FALLBACK_NOTICE = '已换用备用模型 兜底供应商 / fallback'
const STALLED_NOTICE = '完成检查连续 3 次没有进展，已停止'
const UNFINISHED_REASON = '这一轮没有走完就停了，任务还没完成；可以接着执行剩余步骤。'

// b.txt 里没有这一行：补丁每次都以同样的错误失败，不改文件，是一个结果每次都一样的调用
const staleCall = replaceLines('b.txt', 'old line', 'new line')
const stalePatch: Step = { toolCalls: [staleCall] }
const text = (value: string): Step => ({ text: value })

const tscError = (file: string, line: number, name: string) => `src/${file}.ts(${line},1): error TS2304: Cannot find name '${name}'.`
const tscCheck = 'cat errors.txt; ! grep -q "error TS" errors.txt'
const pytestFailures = Array.from({ length: 10 }, (_, index) => `FAILED tests/test_app.py::test_${index + 1} - AssertionError: assert 0 == 1`)
const pytestCheck = 'cat results.txt; ! grep -q FAILED results.txt'
// 删掉 results.txt 里第 from 到 to（不含）个失败的用例
const removeFailures = (from: number, to: number): Step => ({
  toolCalls: [patch('*** Update File: results.txt', ...pytestFailures.slice(from, to).map((line) => `-${line}`))],
})

describe('卡死检测和步数上限', () => {
  test('同一个调用连续三次结果一样时先提醒，提醒后再重复就停下', async () => {
    writeFileSync(join(project, 'b.txt'), 'b\n')
    const model = scriptedModel([stalePatch, stalePatch, stalePatch, stalePatch, stalePatch, stalePatch, text('不会走到这里')])
    const session = await makeSession(model)
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '改 b.txt' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(6)
    // 第三次之后提醒了模型：第四次请求里最后一条用户消息就是提醒，之前没有
    expect(userTexts(model, 2)).not.toContain(STUCK_REMINDER)
    expect(userTexts(model, 3).at(-1)).toBe(STUCK_REMINDER)
    expect(noticesWithText(io)).toEqual([
      { title: STUCK_NOTICE, description: `apply_patch ${JSON.stringify(staleCall.input)}：提醒过后又连续 3 次得到同样的结果。可以补充说明后让它继续。` },
    ])
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'stuck' }])
    expect(lastTaskState(io)).toMatchObject({ status: 'blocked', reason: UNFINISHED_REASON })
    expect(readFileSync(join(project, 'b.txt'), 'utf8')).toBe('b\n')
  })

  test('反复读同一个没改过的文件也算同样的结果：提醒后再重复就停下', async () => {
    writeFileSync(join(project, 'b.txt'), 'b\n')
    const readB: Step = { toolCalls: [read('b.txt')] }
    const model = scriptedModel([readB, readB, readB, readB, readB, readB, text('不会走到这里')])
    const session = await makeSession(model)
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '看看 b.txt' }, io)).resolves.toBe('end_turn')
    expect(userTexts(model, 3).at(-1)).toBe(STUCK_REMINDER)
    expect(model.doStreamCalls).toHaveLength(6)
    expect(notices(io)).toEqual([STUCK_NOTICE])
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'stuck' }])
  })

  test('中间有成功的编辑时重新计数', async () => {
    writeFileSync(join(project, 'a.txt'), 'one\n')
    writeFileSync(join(project, 'b.txt'), 'b\n')
    const model = scriptedModel([
      { toolCalls: [read('a.txt')] },
      stalePatch,
      stalePatch,
      { toolCalls: [replaceLines('a.txt', 'one', 'two')] },
      stalePatch,
      stalePatch,
      text('好了'),
    ])
    const session = await makeSession(model)
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '改 a.txt' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(7)
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('two\n')
    expect(JSON.stringify(session.messages)).not.toContain('same call 3 times')
    expect(notices(io)).toEqual([])
    // 改了文件、没配检查命令：结束门禁放行，结论是未经验证
    expect(verifications(io)).toEqual(['unverified'])
    expect(turnOutcomes(io)).toEqual([{ finish: 'unverified', stop: null }])
  })

  test('同一条命令跑了 6 次、每次结果不一样：提醒一次，不停下', async () => {
    const tick: Step = { toolCalls: [exec('date +%s%N')] }
    const model = scriptedModel([tick, tick, tick, tick, tick, tick, text('不查了')])
    const session = await makeSession(model)
    session.permissionMode = 'full'
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '看看时间' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(7)
    expect(promptOf(model, 5)).not.toContain('same call 6 times')
    expect(userTexts(model, 6).at(-1)).toBe(
      '[Diffra] You have made the same call 6 times without changing any file in between. Repeating it will not give you anything new: act on what you already know, or try a different approach.',
    )
    expect(JSON.stringify(session.messages)).not.toContain(STUCK_REMINDER)
    expect(notices(io)).toEqual([])
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: null }])
  }, 30_000)

  test('步数上限按设置来，到了就停下并说明怎么继续', async () => {
    for (const name of ['a', 'b', 'c', 'd']) writeFileSync(join(project, `${name}.txt`), `${name}\n`)
    const steps: Step[] = ['a', 'b', 'c', 'd'].map((name) => ({ toolCalls: [read(`${name}.txt`)] }))
    const model = scriptedModel([...steps, text('不会走到这里')])
    const session = await makeSession(model, undefined, undefined, undefined, undefined, { compactAtPercent: 70, maxSteps: 3, goalMaxRounds: 5 })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '读文件' }, io)).resolves.toBe('max_turn_requests')
    expect(model.doStreamCalls).toHaveLength(3)
    expect(noticesWithText(io)).toEqual([{ title: '已达到单次任务的步数上限（3 步），已停止', description: '发消息让它继续，或在「设置 → 任务执行」里调整上限。' }])
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'step-limit' }])
    expect(lastTaskState(io)).toMatchObject({ status: 'blocked', reason: UNFINISHED_REASON })
  })

  test('改的过程中改错几次也不检查、不停下、不换模型；停下时结束门禁跑检查，不过才打回一条用户消息', async () => {
    writeFileSync(join(project, 'a.txt'), 'value = broken\n')
    const check = 'grep -q "value = fixed" a.txt'
    const model = scriptedModel([
      { toolCalls: [read('a.txt')] },
      { toolCalls: [replaceLines('a.txt', 'value = broken', 'value = try1')] },
      { toolCalls: [replaceLines('a.txt', 'value = try1', 'value = try2')] },
      { toolCalls: [replaceLines('a.txt', 'value = try2', 'value = try3')] },
      text('完成'),
      { toolCalls: [replaceLines('a.txt', 'value = try3', 'value = fixed')] },
      text('完成'),
    ])
    const fallback = scriptedModel([text('不会走到这里')])
    const session = await makeSession(model, { afterEdit: check, beforeFinish: null }, [], undefined, undefined, undefined, { fallback })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '修复 a.txt' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(7)
    expect(fallback.doStreamCalls).toHaveLength(0)
    expect(notices(io)).toEqual([])
    // 只配了 afterEdit 时门禁跑那条命令；改的过程中一次都没跑
    expect(checkResults(io, '快速检查')).toEqual([])
    expect(checkResults(io, '完成检查')).toEqual(['failed', 'passed'])
    // 第一次停下被打回：追加的是一条用户消息，模型接着改
    expect(userTexts(model, 5).at(-1)).toBe(`${GATE_FEEDBACK}\n\nThe check \`${check}\` failed.\nExit code: 1\n(no output)\n${SAME_CHANGE_HINT}`)
    expect(verifications(io)).toEqual(['failed', 'verified'])
    expect(turnOutcomes(io)).toEqual([{ finish: 'verified', stop: null }])
    expect(lastTaskState(io)).toMatchObject({ status: 'completed', needsVerification: false })
  }, 30_000)

  test('完成检查连续 3 次不过且输出一样（没有进展）、没配兜底模型时停下，记 gate-exhausted，剩余问题留给下一轮', async () => {
    const check = 'grep -q final new.txt'
    const model = scriptedModel([{ toolCalls: [addFile('new.txt', 'draft')] }, text('完成'), text('完成'), text('完成'), text('不会走到这里')])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: check })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '写 new.txt' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(4)
    expect(noticesWithText(io)).toEqual([
      { title: STALLED_NOTICE, description: '检查输出的最后几行：\n- (no output)\n发「继续」可以接着修，或者先手动处理这几处。' },
    ])
    expect(verifications(io)).toEqual(['failed', 'failed', 'failed'])
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'gate-exhausted' }])
    expect(lastTaskState(io)).toMatchObject({ status: 'blocked', reason: UNFINISHED_REASON, needsVerification: true })
    expect(session.unresolvedCheck).toEqual({ command: check, lines: ['(no output)'] })
  })

  test('完成检查前 3 次失败但每次都修好一部分时不停，第 4 次通过后正常完成；失败信息带进展摘要和一次改多个文件的引导', async () => {
    const errors = ['a', 'b', 'c', 'd'].map((name) => tscError(name, 1, name))
    writeFileSync(join(project, 'errors.txt'), `${errors.join('\n')}\n`)
    const fix = (index: number) => replaceLines('errors.txt', errors[index]!, `// fixed ${index}`)
    const model = scriptedModel([
      { toolCalls: [read('errors.txt'), fix(0)] },
      text('都修好了'),
      { toolCalls: [fix(1)] },
      text('都修好了'),
      { toolCalls: [fix(2)] },
      text('都修好了'),
      { toolCalls: [fix(3)] },
      text('都修好了'),
    ])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: tscCheck })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '修类型错误' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(8)
    expect(notices(io)).toEqual([])
    expect(checkResults(io, '完成检查')).toEqual(['failed', 'failed', 'failed', 'passed'])
    expect(turnOutcomes(io)).toEqual([{ finish: 'verified', stop: null }])
    const first = userTexts(model, 2).at(-1)
    expect(first?.startsWith(`${GATE_FEEDBACK}\n\nThe check \`${tscCheck}\` failed. The check reported 3 errors.\n`)).toBe(true)
    expect(first).toContain(errors[1])
    const second = userTexts(model, 4).at(-1)
    expect(second).toContain('Since the last check: 1 of 3 errors fixed, 0 new, 2 remaining.')
    expect(second?.endsWith(`\n${SAME_CHANGE_HINT}`)).toBe(true)
  }, 30_000)

  test('完成检查同样的错误连续 3 次没有进展（只是行号变了）时停下，提示里列出剩余错误；下一轮开始时模型收到上次剩余的错误', async () => {
    writeFileSync(join(project, 'errors.txt'), `${tscError('task', 1, 'draftKey')}\n`)
    const shift = (from: number) => replaceLines('errors.txt', tscError('task', from, 'draftKey'), tscError('task', from + 1, 'draftKey'))
    const model = scriptedModel([
      { toolCalls: [read('errors.txt'), shift(1)] },
      text('修好了'),
      { toolCalls: [shift(2)] },
      text('修好了'),
      { toolCalls: [shift(3)] },
      text('修好了'),
      { toolCalls: [replaceLines('errors.txt', tscError('task', 4, 'draftKey'), '// fixed')] },
      text('修好了'),
    ])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: tscCheck })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '修类型错误' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(6)
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'gate-exhausted' }])
    expect(noticesWithText(io)).toEqual([
      { title: STALLED_NOTICE, description: `还剩 1 个错误：\n- ${tscError('task', 4, 'draftKey')}\n发「继续」可以接着修，或者先手动处理这几处。` },
    ])
    expect(session.unresolvedCheck).toEqual({ command: tscCheck, lines: [tscError('task', 4, 'draftKey')] })

    const next = recordingIO()
    await expect(runTurn(session, { id: 'turn-2', text: '继续' }, next)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(8)
    // 剩余的错误跟在这一轮的提问后面
    expect(userTexts(model, 6).slice(-2)).toEqual([
      '继续',
      `[Diffra] When the most recent turn stopped because a check was stuck, these errors from the check \`${tscCheck}\` were still unresolved:\n` +
        `${tscError('task', 4, 'draftKey')}\nIf the user wants you to continue, start by fixing them.`,
    ])
    expect(turnOutcomes(next)).toEqual([{ finish: 'verified', stop: null }])
    // 只带一次：这一轮的检查已经通过，下一轮不再说
    expect(session.unresolvedCheck).toBeNull()
  }, 30_000)

  test('错误来回变、每次都算有进展时，本轮完成检查失败满 12 次停下', async () => {
    writeFileSync(join(project, 'errors.txt'), `${tscError('a', 1, 'x0')}\n`)
    const rename = (from: number) => replaceLines('errors.txt', tscError('a', 1, `x${from}`), tscError('a', 1, `x${from + 1}`))
    const model = scriptedModel([
      { toolCalls: [read('errors.txt'), rename(0)] },
      text('修好了'),
      ...Array.from({ length: 11 }, (_, index): Step[] => [{ toolCalls: [rename(index + 1)] }, text('修好了')]).flat(),
      text('不会走到这里'),
    ])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: tscCheck })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '修类型错误' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(24)
    expect(checkResults(io, '完成检查')).toEqual(Array.from({ length: 12 }, () => 'failed'))
    expect(noticesWithText(io)).toEqual([
      {
        title: '完成检查失败次数到上限，已停止',
        description: `这一轮完成检查一共失败了 12 次。还剩 1 个错误：\n- ${tscError('a', 1, 'x12')}\n发「继续」可以接着修，或者先手动处理这几处。`,
      },
    ])
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'gate-exhausted' }])
  }, 60_000)

  test('快速检查和完成检查都填了：停下时只跑完成检查那条，快速检查那条一次都不跑', async () => {
    const model = scriptedModel([{ toolCalls: [addFile('a.txt', 'a')] }, { toolCalls: [addFile('b.txt', 'b')] }, text('写好了')])
    const session = await makeSession(model, { afterEdit: 'echo quick-ran', beforeFinish: 'echo finish-ran' })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '写两个文件' }, io)).resolves.toBe('end_turn')
    expect(checkResults(io, '快速检查')).toEqual([])
    expect(checkResults(io, '完成检查')).toEqual(['passed'])
    expect(cardsTitled(io, '完成检查：echo finish-ran')).toHaveLength(1)
    expect(JSON.stringify(io.updates)).not.toContain('quick-ran')
    expect(cardsTitled(io, '完成').map((card) => card.content)).toEqual([[{ type: 'content', content: { type: 'text', text: '检查通过：echo finish-ran' } }]])
    expect(turnOutcomes(io)).toEqual([{ finish: 'verified', stop: null }])
  })

  test('检查输出超过给模型看的长度时按完整输出比较：500 个错误一个没修、每步只多一个，算没进展', async () => {
    const errors = Array.from({ length: 500 }, (_, index) => tscError(`f${index}`, 1, `x${index}`))
    writeFileSync(join(project, 'errors.txt'), `${errors.join('\n')}\n`)
    const add = (index: number) => replaceLines('errors.txt', errors[0]!, `${tscError(`new${index}`, 1, 'n')}\n${errors[0]}`)
    const model = scriptedModel([
      { toolCalls: [read('errors.txt'), add(1)] },
      text('修好了'),
      { toolCalls: [add(2)] },
      text('修好了'),
      { toolCalls: [add(3)] },
      text('修好了'),
      text('不会走到这里'),
    ])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: tscCheck })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '修类型错误' }, io)).resolves.toBe('end_turn')
    expect(userTexts(model, 2).at(-1)).toContain('The check reported 501 errors.')
    expect(userTexts(model, 4).at(-1)).toContain('Since the last check: 0 of 501 errors fixed, 1 new, 502 remaining.')
    expect(model.doStreamCalls).toHaveLength(6)
    expect(notices(io)).toEqual([STALLED_NOTICE])
    expect(noticesWithText(io)[0]?.description).toContain('还剩 503 个错误')
    expect(noticesWithText(io)[0]?.description).toContain('- 另外还有 498 个')
  }, 60_000)

  test('完成检查有进展地打回 3 次后模型只回文字想结束：门禁照样再跑、打回，没进展的这一次不算卡住，接着修到通过', async () => {
    writeFileSync(join(project, 'results.txt'), `# results\n${pytestFailures.join('\n')}\n`)
    const model = scriptedModel([
      { toolCalls: [read('results.txt'), replaceLines('results.txt', '# results', '# run')] },
      text('测试都过了'),
      removeFailures(0, 3),
      text('测试都过了'),
      removeFailures(3, 6),
      text('测试都过了'),
      text('还剩几个，我接着修'),
      removeFailures(6, 10),
      text('测试都过了'),
    ])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: pytestCheck })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '修测试' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(9)
    // 只回文字的那一次也是想结束这一轮：门禁跑了第 4 次，没有进展
    expect(userTexts(model, 7).at(-1)).toContain('Since the last check: 0 of 4 errors fixed, 0 new, 4 remaining.')
    expect(JSON.stringify(session.messages)).not.toContain('did not call finish')
    expect(notices(io)).toEqual([])
    expect(verifications(io)).toEqual(['failed', 'failed', 'failed', 'failed', 'verified'])
    expect(turnOutcomes(io)).toEqual([{ finish: 'verified', stop: null }])
  }, 30_000)

  test('重新生成收到剩余错误的那一轮时，重发的那一轮照样收到；说明里写的是最近一次因检查卡住停下', async () => {
    writeFileSync(join(project, 'errors.txt'), `${tscError('task', 1, 'draftKey')}\n`)
    const shift = (from: number) => replaceLines('errors.txt', tscError('task', from, 'draftKey'), tscError('task', from + 1, 'draftKey'))
    const fix = replaceLines('errors.txt', tscError('task', 4, 'draftKey'), '// fixed')
    const model = scriptedModel([
      { toolCalls: [read('errors.txt'), shift(1)] },
      text('修好了'),
      { toolCalls: [shift(2)] },
      text('修好了'),
      { toolCalls: [shift(3)] },
      text('修好了'),
      { toolCalls: [fix] },
      text('修好了'),
      { toolCalls: [read('errors.txt'), fix] },
      text('修好了'),
    ])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: tscCheck })
    const run = async (id: string, prompt: string) => {
      session.startTurn(id, prompt)
      const io = recordingIO()
      await runTurn(session, { id, text: prompt }, io)
      session.endTurn('end_turn')
      return io
    }

    expect(turnOutcomes(await run('turn-1', '修类型错误'))).toEqual([{ finish: null, stop: 'gate-exhausted' }])
    expect(turnOutcomes(await run('turn-2', '继续'))).toEqual([{ finish: 'verified', stop: null }])
    const resumed = promptOf(model, 6)
    expect(resumed).toContain('When the most recent turn stopped because a check was stuck')
    expect(resumed).not.toContain('When the previous turn stopped')

    await session.rewind('turn-2')
    // 文件回到 turn-2 开始时：错误还在第 4 行，重发的那一轮照样能修
    expect(readFileSync(join(project, 'errors.txt'), 'utf8')).toBe(`${tscError('task', 4, 'draftKey')}\n`)
    expect(turnOutcomes(await run('turn-3', '继续'))).toEqual([{ finish: 'verified', stop: null }])
    expect(model.doStreamCalls).toHaveLength(10)
    expect(promptOf(model, 8).split('were still unresolved')).toHaveLength(2)
    expect(session.unresolvedCheck).toBeNull()
  }, 60_000)

  test('完成检查的失败测试从 10 个修到 0 个时不停，正常完成', async () => {
    writeFileSync(join(project, 'results.txt'), `# results\n${pytestFailures.join('\n')}\n`)
    const model = scriptedModel([
      { toolCalls: [read('results.txt'), replaceLines('results.txt', '# results', '# run')] },
      text('测试都过了'),
      removeFailures(0, 4),
      text('测试都过了'),
      removeFailures(4, 7),
      text('测试都过了'),
      removeFailures(7, 10),
      text('测试都过了'),
    ])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: pytestCheck })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '修测试' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(8)
    expect(notices(io)).toEqual([])
    expect(verifications(io)).toEqual(['failed', 'failed', 'failed', 'verified'])
    expect(turnOutcomes(io)).toEqual([{ finish: 'verified', stop: null }])
    expect(userTexts(model, 2).at(-1)).toContain('The check reported 10 errors.')
    expect(userTexts(model, 4).at(-1)).toContain('Since the last check: 4 of 10 errors fixed, 0 new, 6 remaining.')
    expect(userTexts(model, 6).at(-1)).toContain('Since the last check: 3 of 6 errors fixed, 0 new, 3 remaining.')
    expect(readFileSync(join(project, 'results.txt'), 'utf8')).toBe('# run\n')
  }, 30_000)
})

describe('兜底模型', () => {
  test('完成检查连续 3 次没有进展时换兜底模型接着做；用量按兜底模型记，对话里交代了换人的原因', async () => {
    const check = 'grep -q final new.txt'
    const coder = scriptedModel([{ toolCalls: [addFile('new.txt', 'draft')] }, text('完成'), text('完成'), text('完成')])
    const fallback = scriptedModel([{ toolCalls: [replaceLines('new.txt', 'draft', 'final')] }, text('改成 final 了')])
    const session = await makeSession(coder, { afterEdit: null, beforeFinish: check }, [], undefined, undefined, undefined, { fallback })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '写 new.txt' }, io)).resolves.toBe('end_turn')
    expect(readFileSync(join(project, 'new.txt'), 'utf8')).toBe('final\n')
    expect(noticesWithText(io)).toEqual([{ title: FALLBACK_NOTICE, description: '完成检查连续 3 次没有进展。这一轮剩下的部分由它来做，下一轮回到编码模型。' }])
    expect(coder.doStreamCalls).toHaveLength(4)
    expect(fallback.doStreamCalls).toHaveLength(2)
    // 第 3 次打回的说明之后交代换人
    const handover = userTexts(fallback, 0).slice(-2)
    expect(handover[0]?.startsWith(GATE_FEEDBACK)).toBe(true)
    expect(handover[1]).toBe(
      `[Diffra] The check \`${check}\` failed 3 times in a row without fixing any of the previous errors. ` +
        'A different model takes over this task from here. Read what was tried above, work out why it did not work, and take a different approach.',
    )
    expect(usageRoles(io)).toEqual([...Array.from({ length: 4 }, () => ['coder', 'mock']), ['coder', 'fallback'], ['coder', 'fallback']])
    expect(verifications(io)).toEqual(['failed', 'failed', 'failed', 'verified'])
    expect(turnOutcomes(io)).toEqual([{ finish: 'verified', stop: null }])
  }, 30_000)

  test('卡死提醒后仍重复时换兜底模型；兜底模型也卡住就停下，每轮只换一次', async () => {
    writeFileSync(join(project, 'b.txt'), 'b\n')
    const coder = scriptedModel([stalePatch, stalePatch, stalePatch, stalePatch, stalePatch, stalePatch])
    const fallback = scriptedModel([stalePatch, stalePatch, stalePatch, stalePatch, stalePatch, stalePatch, text('不会走到这里')])
    const session = await makeSession(coder, undefined, [], undefined, undefined, undefined, { fallback })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '改 b.txt' }, io)).resolves.toBe('end_turn')
    expect(coder.doStreamCalls).toHaveLength(6)
    expect(fallback.doStreamCalls).toHaveLength(6)
    expect(notices(io)).toEqual([FALLBACK_NOTICE, STUCK_NOTICE])
    expect(noticesWithText(io)[0]?.description).toBe(`提醒过后仍在重复同样的操作（apply_patch ${JSON.stringify(staleCall.input)}）。这一轮剩下的部分由它来做，下一轮回到编码模型。`)
    expect(userTexts(fallback, 0)).toContain(
      '[Diffra] The previous model kept making the same call with the same result, even after a reminder. ' +
        'A different model takes over this task from here. Read what was tried above, work out why it did not work, and take a different approach.',
    )
    // 换人后重复计数重新开始：对话里已有编码模型那次提醒，兜底模型第 3 次之后再提醒一次，再犯才停
    const reminders = (index: number) => userTexts(fallback, index).filter((item) => item === STUCK_REMINDER)
    expect(reminders(2)).toHaveLength(1)
    expect(reminders(3)).toHaveLength(2)
    expect(userTexts(fallback, 3).at(-1)).toBe(STUCK_REMINDER)
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'stuck' }])
  })

  test('换兜底模型后检查计数清零，兜底模型还有完整的 3 次没进展名额', async () => {
    writeFileSync(join(project, 'a.txt'), 'v0\n')
    const bumpCall = (index: number) => replaceLines('a.txt', `v${index}`, `v${index + 1}`)
    const bump = (index: number): Step => ({ toolCalls: [bumpCall(index)] })
    const coder = scriptedModel([
      { toolCalls: [read('a.txt'), bumpCall(0)] },
      text('改好了'),
      bump(1),
      text('改好了'),
      bump(2),
      text('改好了'),
      text('不会走到这里'),
    ])
    const fallback = scriptedModel([bump(3), text('改好了'), bump(4), text('改好了'), bump(5), text('改好了'), text('不会走到这里')])
    const check = 'echo "src/a.ts(1,1): error TS2304: Cannot find name \'x\'."; exit 1'
    const session = await makeSession(coder, { afterEdit: null, beforeFinish: check }, [], undefined, undefined, undefined, { fallback })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '修 a.txt' }, io)).resolves.toBe('end_turn')
    expect(coder.doStreamCalls).toHaveLength(6)
    expect(fallback.doStreamCalls).toHaveLength(6)
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('v6\n')
    expect(notices(io)).toEqual([FALLBACK_NOTICE, STALLED_NOTICE])
    expect(checkResults(io, '完成检查')).toEqual(Array.from({ length: 6 }, () => 'failed'))
    expect(usageRoles(io)).toEqual([...Array.from({ length: 6 }, () => ['coder', 'mock']), ...Array.from({ length: 6 }, () => ['coder', 'fallback'])])
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'gate-exhausted' }])
  }, 60_000)

  test('下一轮回到编码模型', async () => {
    writeFileSync(join(project, 'b.txt'), 'b\n')
    const coder = scriptedModel([stalePatch, stalePatch, stalePatch, stalePatch, stalePatch, stalePatch, text('第二轮由编码模型回答')])
    const fallback = scriptedModel([text('兜底模型回答')])
    const session = await makeSession(coder, undefined, [], undefined, undefined, undefined, { fallback })
    const first = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '改 b.txt' }, first)).resolves.toBe('end_turn')
    expect(coder.doStreamCalls).toHaveLength(6)
    expect(fallback.doStreamCalls).toHaveLength(1)
    expect(notices(first)).toEqual([FALLBACK_NOTICE])
    expect(turnOutcomes(first)).toEqual([{ finish: null, stop: null }])

    const second = recordingIO()
    await expect(runTurn(session, { id: 'turn-2', text: '再说一遍' }, second)).resolves.toBe('end_turn')
    expect(coder.doStreamCalls).toHaveLength(7)
    expect(fallback.doStreamCalls).toHaveLength(1)
    expect(usageRoles(second)).toEqual([['coder', 'mock']])
    expect(notices(second)).toEqual([])
  })
})

describe('目标模式', () => {
  const completeGoal = { name: 'update_goal', input: { status: 'complete' } }
  const toolNames = (model: MockLanguageModelV4, index: number) => (model.doStreamCalls[index]?.tools ?? []).map((tool) => tool.name)
  const continuations = (messages: Array<{ role: string; content: unknown }>) =>
    messages.flatMap((message) => (message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('[Diffra] Goal mode, round') ? [message.content] : []))

  test('没标完成就自动开始下一轮，标了完成并过了门禁才结束；每轮都要过完成检查', async () => {
    const model = scriptedModel([
      { toolCalls: [addFile('a.txt', 'one')] },
      text('还差 b.txt'),
      { toolCalls: [addFile('b.txt', 'two'), completeGoal] },
      text('都写好了'),
    ])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: 'test -f a.txt' })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '写出 a.txt 和 b.txt' }, io, { goalMaxRounds: 3 })).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(4)
    expect(toolNames(model, 0)).toContain('update_goal')
    expect(userTexts(model, 0).at(-1)).toContain('[Diffra] Goal mode. Work toward the goal below on your own over up to 3 rounds')
    expect(userTexts(model, 0).at(-1)).toContain('<goal>\n写出 a.txt 和 b.txt\n</goal>')
    expect(userTexts(model, 2).at(-1)).toBe(goalContinuation(2, 3))
    expect(notices(io)).toEqual(['目标模式第 2 轮', '目标已完成（用了 2 轮）'])
    // 两轮各跑了一次完成检查
    expect(checkResults(io, '完成检查')).toEqual(['passed', 'passed'])
    expect(cardsTitled(io, '标记目标完成')).toHaveLength(1)
    expect(promptOf(model, 3)).toContain('Goal marked complete.')
    expect(turnOutcomes(io)).toEqual([{ finish: 'verified', stop: null }])
    expect(lastTaskState(io)).toMatchObject({ status: 'completed', needsVerification: false })
  })

  test('只回文字、没标完成时自动开下一轮，提示里是续跑说明；轮数用完还没完成就停下说明', async () => {
    const model = scriptedModel([text('我想想'), text('第二轮还是没做完'), text('不会走到这里')])
    const session = await makeSession(model)
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '做完它' }, io, { goalMaxRounds: 2 })).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(2)
    expect(userTexts(model, 1).at(-1)).toBe(goalContinuation(2, 2))
    expect(noticesWithText(io)).toEqual([
      { title: '目标模式第 2 轮', description: '' },
      { title: '目标模式已用完 2 轮，目标还没完成', description: '改动保留在工作区，发「继续」可以接着做。' },
    ])
    // 没改文件：门禁直接放行，不出完成卡
    expect(verifications(io)).toEqual([])
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'goal-exhausted' }])
    expect(lastTaskState(io)).toMatchObject({ status: 'blocked', reason: UNFINISHED_REASON })
  })

  test('最后一轮改了文件、过了门禁但轮数用完：门禁跑过了，不再留待验证', async () => {
    const model = scriptedModel([text('第一轮先看看'), { toolCalls: [addFile('a.txt', 'one')] }, text('第二轮写了一点')])
    const session = await makeSession(model)
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '做完它' }, io, { goalMaxRounds: 2 })).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(3)
    expect(notices(io)).toEqual(['目标模式第 2 轮', '目标模式已用完 2 轮，目标还没完成'])
    expect(verifications(io)).toEqual(['unverified'])
    expect(turnOutcomes(io)).toEqual([{ finish: 'unverified', stop: 'goal-exhausted' }])
    expect(lastTaskState(io)).toMatchObject({ needsVerification: false })
  })

  test('第 1 轮的改动未经验证，第 2 轮没改文件就标完成：本轮结论仍是 unverified', async () => {
    const model = scriptedModel([{ toolCalls: [addFile('a.txt', 'one')] }, text('还要确认一下'), { toolCalls: [completeGoal] }, text('确认过了')])
    const session = await makeSession(model)
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '写出 a.txt' }, io, { goalMaxRounds: 3 })).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(4)
    // 第 2 轮没有改动，门禁直接放行，不出完成卡
    expect(verifications(io)).toEqual(['unverified'])
    expect(notices(io)).toEqual(['目标模式第 2 轮', '目标已完成（用了 2 轮）'])
    expect(turnOutcomes(io)).toEqual([{ finish: 'unverified', stop: null }])
  })

  test('换轮后只用命令改了文件：停下时门禁按改了文件跑检查、打回，不开下一轮；检查卡住停下时带着待验证', async () => {
    const check = 'grep -q final out.txt'
    const model = scriptedModel([
      text('第一轮先看看'),
      { toolCalls: [exec('printf draft > out.txt')] },
      text('写好了'),
      text('真的写好了'),
      text('结束'),
      text('不会走到这里'),
    ])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: check })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '写出 out.txt' }, io, { goalMaxRounds: 3 })).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(5)
    expect(io.permissionRequests).toBe(1)
    // 第 1 轮没改文件不出完成卡；第 2 轮命令写的文件靠工作区指纹认出来，三次都打回
    expect(verifications(io)).toEqual(['failed', 'failed', 'failed'])
    expect(userTexts(model, 3).at(-1)?.startsWith(`${GATE_FEEDBACK}\n\nThe check \`${check}\` failed.`)).toBe(true)
    expect(continuations(session.messages)).toEqual([goalContinuation(2, 3)])
    expect(notices(io)).toEqual(['目标模式第 2 轮', STALLED_NOTICE])
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'gate-exhausted' }])
    expect(lastTaskState(io)).toMatchObject({ status: 'blocked', needsVerification: true })
  }, 30_000)

  test('第 1 轮已验证、第 2 轮未经验证时结论是 unverified；第 2 轮没有改动时结论仍是 verified', async () => {
    const unverified = scriptedModel([
      { toolCalls: [addFile('a.txt', 'one')] },
      text('还差 b.txt'),
      { toolCalls: [addFile('b.txt', 'two'), completeGoal] },
      text('都写好了'),
    ])
    const session = await makeSession(unverified, { afterEdit: null, beforeFinish: 'test -f a.txt' })
    const io = recordingIO()
    const originalUpdate = io.update
    // 第 2 轮开始时去掉检查命令，让第 2 轮的门禁未经验证
    io.update = async (update) => {
      await originalUpdate(update)
      if (update.sessionUpdate === 'notice' && update.title === '目标模式第 2 轮') session.config.checks = { afterEdit: null, beforeFinish: null }
    }
    await expect(runTurn(session, { id: 'turn-1', text: '写出 a.txt 和 b.txt' }, io, { goalMaxRounds: 3 })).resolves.toBe('end_turn')
    expect(verifications(io)).toEqual(['verified', 'unverified'])
    expect(turnOutcomes(io)).toEqual([{ finish: 'unverified', stop: null }])

    rmSync(join(project, 'a.txt'))
    rmSync(join(project, 'b.txt'))
    const noEdits = scriptedModel([{ toolCalls: [addFile('a.txt', 'one')] }, text('再看一遍'), { toolCalls: [completeGoal] }, text('没问题')])
    const verifiedIO = recordingIO()
    await expect(
      runTurn(await makeSession(noEdits, { afterEdit: null, beforeFinish: 'test -f a.txt' }), { id: 'turn-1', text: '写出 a.txt' }, verifiedIO, { goalMaxRounds: 3 }),
    ).resolves.toBe('end_turn')
    expect(verifications(verifiedIO)).toEqual(['verified'])
    expect(notices(verifiedIO)).toEqual(['目标模式第 2 轮', '目标已完成（用了 2 轮）'])
    expect(turnOutcomes(verifiedIO)).toEqual([{ finish: 'verified', stop: null }])
  }, 30_000)

  test('标了受阻后停下：不跑门禁，任务状态 blocked、原因用模型给的，记 paused', async () => {
    const reason = '需要你提供测试数据库的连接串'
    const model = scriptedModel([{ toolCalls: [addFile('a.txt', 'draft'), { name: 'update_goal', input: { status: 'blocked', reason } }] }, text('卡住了'), text('不会走到这里')])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: 'false' })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '接上数据库' }, io, { goalMaxRounds: 3 })).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(2)
    expect(promptOf(model, 1)).toContain('Goal marked blocked. End your turn and tell the user what you need from them.')
    expect(cardsTitled(io, '标记目标受阻').map((card) => card.content)).toEqual([[{ type: 'content', content: { type: 'text', text: reason } }]])
    expect(checkResults(io, '完成检查')).toEqual([])
    expect(verifications(io)).toEqual([])
    expect(notices(io)).toEqual([])
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'paused' }])
    // 改动留着待验证
    expect(lastTaskState(io)).toMatchObject({ status: 'blocked', reason, needsVerification: true })
  })

  test('门禁没过时标的完成不算数：打回后接着修，过了门禁还要再标一次完成才结束', async () => {
    const check = 'grep -q final a.txt'
    const model = scriptedModel([
      { toolCalls: [addFile('a.txt', 'draft'), completeGoal] },
      text('做完了'),
      { toolCalls: [replaceLines('a.txt', 'draft', 'final')] },
      text('改好了'),
      { toolCalls: [completeGoal] },
      text('确认完成'),
    ])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: check })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '写出 a.txt' }, io, { goalMaxRounds: 3 })).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(6)
    // 第一次停下被检查打回：给的是检查结果，不是下一轮
    expect(userTexts(model, 2).at(-1)?.startsWith(`${GATE_FEEDBACK}\n\nThe check \`${check}\` failed.`)).toBe(true)
    // 修好后过了门禁，但之前标的完成已经撤回：开第 2 轮
    expect(userTexts(model, 4).at(-1)).toBe(goalContinuation(2, 3))
    expect(verifications(io)).toEqual(['failed', 'verified'])
    expect(notices(io)).toEqual(['目标模式第 2 轮', '目标已完成（用了 2 轮）'])
    expect(cardsTitled(io, '标记目标完成')).toHaveLength(2)
    expect(turnOutcomes(io)).toEqual([{ finish: 'verified', stop: null }])
    expect(lastTaskState(io)).toMatchObject({ status: 'completed', needsVerification: false })
  }, 30_000)

  test('不是目标模式时不给 update_goal，模型调了也不算数，停下就结束', async () => {
    const model = scriptedModel([{ toolCalls: [completeGoal] }, text('好了')])
    const session = await makeSession(model)
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '问个问题' }, io)).resolves.toBe('end_turn')
    expect(toolNames(model, 0)).not.toContain('update_goal')
    expect(model.doStreamCalls).toHaveLength(2)
    expect(promptOf(model, 1)).toContain("unavailable tool 'update_goal'")
    expect(cardsTitled(io, '标记目标完成')).toEqual([])
    expect(notices(io)).toEqual([])
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: null }])
    expect(lastTaskState(io)).toMatchObject({ status: 'completed' })
  })
})
