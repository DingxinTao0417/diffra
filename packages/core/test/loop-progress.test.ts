import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, test } from 'vitest'
import { goalContinuation } from '../src/session/goal.js'
import { runTurn } from '../src/session/loop.js'
import {
  addFile,
  exec,
  lastTaskState,
  makeSession,
  project,
  read,
  recordingIO,
  replaceLines,
  scriptedModel,
  type Step,
  turnOutcomes,
  useTempProject,
} from './loop-helpers.js'

// 主循环里和「有没有进展」相关的规则：防打转、步数上限、结束一轮、兜底模型、目标模式

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

const STUCK_REMINDER =
  '[Diffra] You made the same call 3 times and got the same result each time, without changing any file in between. ' +
  'Stop repeating it: try a different approach, or stop and tell the user what is blocking you.'
const STUCK_NOTICE = '智能体在重复同样的操作，已停止'
const FALLBACK_NOTICE = '已换用备用模型 兜底供应商 / fallback'
const UNFINISHED_REASON = '这一轮没有走完就停了，任务还没完成；可以接着执行剩余步骤。'

// b.txt 里没有这一行：补丁每次都以同样的错误失败，不改文件，是一个结果每次都一样的调用
const staleCall = replaceLines('b.txt', 'old line', 'new line')
const stalePatch: Step = { toolCalls: [staleCall] }
const text = (value: string): Step => ({ text: value })

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
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: null }])
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
})

describe('结束一轮', () => {
  test('改了文件、配了检查命令：模型停下就结束，不跑检查、不出完成卡；系统提示里写着检查命令由模型自己决定跑不跑', async () => {
    const model = scriptedModel([{ toolCalls: [addFile('a.txt', 'one')] }, text('写好了')])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: 'echo ran > ran.txt; false' })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '写出 a.txt' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(2)
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('one\n')
    expect(existsSync(join(project, 'ran.txt'))).toBe(false)
    expect(io.updates.some((update) => update.sessionUpdate === 'tool_call' && update.title.startsWith('完成'))).toBe(false)
    expect(notices(io)).toEqual([])
    expect(session.systemPrompt).toContain('Diffra does not run it for you.')
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: null }])
    expect(lastTaskState(io)).toMatchObject({ status: 'completed', reason: null })
  })
})

describe('兜底模型', () => {
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

  test('没标完成就自动开始下一轮，标了完成才结束', async () => {
    const model = scriptedModel([
      { toolCalls: [addFile('a.txt', 'one')] },
      text('还差 b.txt'),
      { toolCalls: [addFile('b.txt', 'two'), completeGoal] },
      text('都写好了'),
    ])
    const session = await makeSession(model)
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '写出 a.txt 和 b.txt' }, io, { goalMaxRounds: 3 })).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(4)
    expect(toolNames(model, 0)).toContain('update_goal')
    expect(userTexts(model, 0).at(-1)).toContain('[Diffra] Goal mode. Work toward the goal below on your own over up to 3 rounds')
    expect(userTexts(model, 0).at(-1)).toContain('<goal>\n写出 a.txt 和 b.txt\n</goal>')
    expect(userTexts(model, 2).at(-1)).toBe(goalContinuation(2, 3))
    expect(notices(io)).toEqual(['目标模式第 2 轮', '目标已完成（用了 2 轮）'])
    expect(cardsTitled(io, '标记目标完成')).toHaveLength(1)
    expect(promptOf(model, 3)).toContain('Goal marked complete. End your turn with a short summary for the user.')
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: null }])
    expect(lastTaskState(io)).toMatchObject({ status: 'completed' })
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
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'goal-exhausted' }])
    expect(lastTaskState(io)).toMatchObject({ status: 'blocked', reason: UNFINISHED_REASON })
  })

  test('标了受阻后停下：任务状态 blocked、原因用模型给的，记 paused', async () => {
    const reason = '需要你提供测试数据库的连接串'
    const model = scriptedModel([{ toolCalls: [addFile('a.txt', 'draft'), { name: 'update_goal', input: { status: 'blocked', reason } }] }, text('卡住了'), text('不会走到这里')])
    const session = await makeSession(model)
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '接上数据库' }, io, { goalMaxRounds: 3 })).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(2)
    expect(promptOf(model, 1)).toContain('Goal marked blocked. End your turn and tell the user what you need from them.')
    expect(cardsTitled(io, '标记目标受阻').map((card) => card.content)).toEqual([[{ type: 'content', content: { type: 'text', text: reason } }]])
    expect(notices(io)).toEqual([])
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'paused' }])
    expect(lastTaskState(io)).toMatchObject({ status: 'blocked', reason })
  })

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
