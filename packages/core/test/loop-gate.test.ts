import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { PermissionOption, SessionUpdate, ToolCallUpdate } from '@agentclientprotocol/sdk'
import type { ToolResultPart } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, test } from 'vitest'
import { runTurn, TURN_ABORTED_NOTE } from '../src/session/loop.js'
import { Session } from '../src/session/session.js'
import {
  addFile,
  checkResults,
  deleteFile,
  exec,
  infoMeta,
  lastTaskState,
  makeSession,
  patch,
  project,
  read,
  recordingIO,
  replaceLines,
  scriptedModel,
  serviceError,
  type Step,
  toolUpdates,
  turnOutcomes,
  useTempProject,
  verifications,
  withoutContext,
} from './loop-helpers.js'

// 主循环的工具调用和结束门禁：模型不再调工具就是想停下，这一轮改了文件时门禁自动跑检查（第 504 步起没有 finish）

useTempProject()

const GATE_FEEDBACK =
  '[Diffra] Before ending the turn Diffra ran the project checks on your changes, and the task is not finished yet. ' +
  'Fix the problems below and continue; the checks run again the next time you end your turn.'
const SAME_CHANGE_HINT = 'If the remaining errors are in files that belong to the same change, fix them together: one apply_patch can change several files.'
const STOPPED_REASON = '这一轮没有走完就停了，任务还没完成；可以接着执行剩余步骤。'
// 每轮只许调一次模型：改完文件就到步数上限，门禁没跑，待验证留着
const ONE_STEP = { compactAtPercent: 70, maxSteps: 1, goalMaxRounds: 5 }

// 门禁打回时追加的用户消息，按出现顺序
function gateFeedback(session: Session): string[] {
  return session.messages.flatMap((message) => (message.role === 'user' && typeof message.content === 'string' && message.content.startsWith(GATE_FEEDBACK) ? [message.content] : []))
}

function toolResults(session: Session): ToolResultPart[] {
  return session.messages.flatMap((message) => (message.role === 'tool' ? message.content.flatMap((part) => (part.type === 'tool-result' ? [part] : [])) : []))
}

const resultText = (part: ToolResultPart | undefined) => (part && 'value' in part.output && typeof part.output.value === 'string' ? part.output.value : JSON.stringify(part?.output))

const finishCards = (io: { updates: SessionUpdate[] }) => io.updates.filter((update) => update.sessionUpdate === 'tool_call' && update.title === '完成')

// 像客户端那样把更新记进会话的轮次：撤销、重新生成按轮次里记下的任务状态取待验证
function recordingInto(session: Session) {
  const io = recordingIO()
  const push = io.update
  io.update = async (update: SessionUpdate) => {
    session.recordUpdate(update)
    await push(update)
  }
  return io
}

// 两轮各改一个文件、都在门禁之前停下：第一轮开始时没有待验证，第二轮开始时带着第一轮的
async function twoUnverifiedTurns(): Promise<Session> {
  const session = await makeSession(scriptedModel([{ toolCalls: [addFile('a.txt', 'a')] }, { toolCalls: [addFile('b.txt', 'b')] }]), undefined, [], undefined, undefined, ONE_STEP)
  for (const [id, text] of [['turn-1', '写 a.txt'], ['turn-2', '写 b.txt']] as const) {
    session.startTurn(id, text)
    await expect(runTurn(session, { id, text }, recordingInto(session))).resolves.toBe('max_turn_requests')
    session.endTurn('max_turn_requests')
  }
  expect(session.taskState).toEqual({ status: 'blocked', needsVerification: true, reason: STOPPED_REASON })
  return session
}

describe('主循环', () => {
  test('用户终端读取必须授权，拒绝不调用客户端，会话允许只对指定终端生效', async () => {
    const terminalId = '11111111-1111-4111-8111-111111111111'
    for (const choice of ['reject', 'allow_once', 'allow_always']) {
      const model = scriptedModel([
        { toolCalls: [{ name: 'terminal_read', input: { terminalId, lines: 10 } }] },
        { toolCalls: [{ name: 'terminal_read', input: { terminalId, lines: 10 } }] },
        { text: '分析完毕' },
      ])
      const session = await makeSession(model)
      session.config.browser = true
      session.permissionMode = 'full'
      const io = recordingIO(choice)
      let reads = 0
      await runTurn(session, { id: choice, text: '检查终端输出' }, {
        ...io,
        devServer: async (params) => {
          expect(params.action).toBe('terminal-read')
          reads++
          return { text: 'terminal result', url: null }
        },
      })
      expect(reads).toBe(choice === 'reject' ? 0 : 2)
      expect(io.permissionRequests).toBe(choice === 'allow_always' ? 1 : 2)
    }
  }, 30_000)

  test('读 → 改错 → 改对 → 停下时检查通过：改的过程中不跑检查；只配了旧的快速检查时门禁用它；撤销后文件回到开始前', async () => {
    writeFileSync(join(project, 'a.txt'), 'value = broken\n')
    const check = 'grep -q "value = fixed" a.txt'
    const model = scriptedModel([
      { toolCalls: [read('a.txt')] },
      { toolCalls: [replaceLines('a.txt', 'value = broken', 'value = still broken')] },
      { toolCalls: [replaceLines('a.txt', 'value = still broken', 'value = fixed')] },
      { text: '修好了' },
    ])
    const session = await makeSession(model, { afterEdit: check, beforeFinish: null })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '修复 a.txt' }, io)).resolves.toBe('end_turn')
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('value = fixed\n')
    expect(toolUpdates(io, 'failed')).toHaveLength(0)
    // 两次编辑都带 diff
    expect(io.updates.filter((update) => update.sessionUpdate === 'tool_call_update' && update.content?.[0]?.type === 'diff')).toHaveLength(2)
    expect(model.doStreamCalls).toHaveLength(4)
    // 「完成」卡片在完成检查之后才出现
    const finishCheckIndex = io.updates.findIndex((update) => update.sessionUpdate === 'tool_call' && update.title === `完成检查：${check}`)
    const finishIndex = io.updates.findIndex((update) => update.sessionUpdate === 'tool_call' && update.title === '完成')
    expect(finishCheckIndex).toBeGreaterThanOrEqual(0)
    expect(finishIndex).toBeGreaterThan(finishCheckIndex)
    expect(checkResults(io, '快速检查')).toEqual([])
    expect(checkResults(io, '完成检查')).toEqual(['passed'])
    expect(verifications(io)).toEqual(['verified'])
    expect(turnOutcomes(io)).toEqual([{ finish: 'verified', stop: null }])
    expect(lastTaskState(io)).toMatchObject({ status: 'completed', needsVerification: false })
    // 系统提示词里写明了检查在停下时自动跑、改的过程中不要自己跑
    const system = model.doStreamCalls[0]?.prompt.find((message) => message.role === 'system')?.content
    expect(system).toContain(`When you end your turn after changing files, Diffra runs \`${check}\` automatically.`)
    expect(system).toContain('Do not run that command yourself while you are still changing code')

    // 撤销这一轮：文件回到开始前，原来的结论不再算数
    expect(await session.checkpointChanges('turn-1')).toEqual([{ path: 'a.txt', change: 'modified' }])
    await session.restoreCheckpoint('turn-1')
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('value = broken\n')
    expect(session.taskState).toEqual({ status: 'blocked', needsVerification: false, reason: '文件已撤销，原来的结论不再算数。' })
  }, 30_000)

  test('停下时检查不通过：出 failed 完成卡，追加一条带检查输出的用户消息打回，改好后再停下才完成', async () => {
    const check = 'cat new.txt && grep -q final new.txt'
    const model = scriptedModel([
      { toolCalls: [addFile('new.txt', 'draft')] },
      { text: '完成' },
      { toolCalls: [read('new.txt')] },
      { toolCalls: [replaceLines('new.txt', 'draft', 'final')] },
      { text: '完成' },
    ])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: check })
    const io = recordingIO()
    await expect(runTurn(session, { id: 't', text: '写 new.txt' }, io)).resolves.toBe('end_turn')
    expect(readFileSync(join(project, 'new.txt'), 'utf8')).toBe('final\n')
    expect(model.doStreamCalls).toHaveLength(5)
    expect(checkResults(io, '完成检查')).toEqual(['failed', 'passed'])
    expect(verifications(io)).toEqual(['failed', 'verified'])

    const [failed, passed] = finishCards(io)
    expect(failed).toMatchObject({
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: `完成检查没有通过：${check}` } }],
      _meta: { diffra: { verification: 'failed' } },
    })
    // 检查通过的完成卡只带 verification，不带未验证标记
    expect(passed).toMatchObject({ status: 'completed', content: [{ type: 'content', content: { type: 'text', text: `检查通过：${check}` } }] })
    expect(passed?._meta).toEqual({ diffra: { verification: 'verified' } })

    // 打回的是一条用户消息（不是工具结果），紧跟在模型想结束的那句话后面，带着检查命令的输出
    expect(gateFeedback(session)).toEqual([`${GATE_FEEDBACK}\n\nThe check \`${check}\` failed.\nExit code: 1\ndraft\n${SAME_CHANGE_HINT}`])
    const messages = withoutContext(session.messages)
    const at = messages.findIndex((message) => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith(GATE_FEEDBACK))
    expect(messages[at - 1]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: '完成' }] })
    expect(messages[at + 1]?.role).toBe('assistant')
    expect(JSON.stringify(model.doStreamCalls[2]?.prompt)).toContain('The check `cat new.txt && grep -q final new.txt` failed.')

    expect(turnOutcomes(io)).toEqual([{ finish: 'verified', stop: null }])
    expect(lastTaskState(io)).toMatchObject({ status: 'completed', needsVerification: false })
  }, 30_000)

  test('完成检查意外没跑完（发卡片时出错）不算通过：打回说明没跑完，再停下时重新检查', async () => {
    const check = 'grep -q final new.txt'
    const model = scriptedModel([{ toolCalls: [addFile('new.txt', 'final')] }, { text: '完成' }, { text: '完成' }])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: check })
    const io = recordingIO()
    const update = io.update
    let broken = true
    io.update = async (item: SessionUpdate) => {
      if (broken && item.sessionUpdate === 'tool_call' && item.title.startsWith('完成检查')) {
        broken = false
        throw new Error('界面连接断了')
      }
      return update(item)
    }

    await expect(runTurn(session, { id: 't', text: '写 new.txt' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(3)
    // 第一次的检查卡片没发出去，只有第二次跑完的
    expect(checkResults(io, '完成检查')).toEqual(['passed'])
    expect(verifications(io)).toEqual(['failed', 'verified'])
    expect(finishCards(io)[0]).toMatchObject({ status: 'failed', content: [{ type: 'content', content: { type: 'text', text: `完成检查没有跑完：${check}` } }] })
    expect(gateFeedback(session)).toEqual([
      `${GATE_FEEDBACK}\n\nThe check \`${check}\` did not complete (界面连接断了). Fix what stopped it if you can; it runs again when you end your turn.`,
    ])
    expect(turnOutcomes(io)).toEqual([{ finish: 'verified', stop: null }])
  }, 30_000)

  test('只用命令改了文件也算改动：停下时照样跑完成检查，不过就打回，改好后通过', async () => {
    const check = 'grep -q final out.txt'
    const model = scriptedModel([
      { toolCalls: [exec('printf draft > out.txt')] },
      { text: '写好了' },
      { toolCalls: [exec('printf final > out.txt')] },
      { text: '改好了' },
    ])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: check })
    const io = recordingIO()
    await expect(runTurn(session, { id: 't', text: '写 out.txt' }, io)).resolves.toBe('end_turn')
    expect(readFileSync(join(project, 'out.txt'), 'utf8')).toBe('final')
    expect(model.doStreamCalls).toHaveLength(4)
    expect(checkResults(io, '完成检查')).toEqual(['failed', 'passed'])
    expect(verifications(io)).toEqual(['failed', 'verified'])
    expect(gateFeedback(session)).toHaveLength(1)
    expect(turnOutcomes(io)).toEqual([{ finish: 'verified', stop: null }])
    expect(lastTaskState(io)).toMatchObject({ status: 'completed', needsVerification: false })
  }, 30_000)

  test('只用命令改了文件、检查一直不过而模型只回文字：连续 3 次没进展就停下记 gate-exhausted，任务受阻、带着待验证', async () => {
    const check = 'grep -q final out.txt'
    const model = scriptedModel([{ toolCalls: [exec('printf draft > out.txt')] }, { text: '写好了' }, { text: '真的写好了' }, { text: '结束' }])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: check })
    const io = recordingIO()
    await expect(runTurn(session, { id: 't', text: '写 out.txt' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(4)
    expect(checkResults(io, '完成检查')).toEqual(['failed', 'failed', 'failed'])
    expect(verifications(io)).toEqual(['failed', 'failed', 'failed'])
    // 第三次打回之后不再调模型；后两次说明和上次一样、什么都没修好
    const feedback = gateFeedback(session)
    expect(feedback).toHaveLength(3)
    expect(feedback[0]).not.toContain('nothing was fixed')
    for (const item of feedback.slice(1)) expect(item).toContain('The output is the same as after the last check: nothing was fixed.')
    expect(io.updates.some((update) => update.sessionUpdate === 'notice' && update.title === '完成检查连续 3 次没有进展，已停止')).toBe(true)
    expect(session.unresolvedCheck?.command).toBe(check)
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'gate-exhausted' }])
    expect(lastTaskState(io)).toMatchObject({ status: 'blocked', needsVerification: true, reason: STOPPED_REASON })
  }, 30_000)

  test('安全检查连续 3 次打回时停下记 gate-exhausted：结束时的任务状态受阻、带着待验证', async () => {
    const model = scriptedModel([
      { toolCalls: [addFile('run.js', 'export const run = (input) => eval(input)')] },
      { text: '改好了' },
      { text: '真的改好了' },
      { text: '不用改' },
    ])
    const session = await makeSession(model, undefined, [], undefined, { staticCheck: true, lightScan: false })
    const io = recordingIO()
    await expect(runTurn(session, { id: 't', text: '写 run.js' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(4)
    expect(verifications(io)).toEqual(['failed', 'failed', 'failed'])
    expect(finishCards(io)[0]).toMatchObject({ status: 'failed', content: [{ type: 'content', content: { type: 'text', text: '安全检查发现 1 处高危问题' } }] })
    const feedback = gateFeedback(session)
    expect(feedback).toHaveLength(3)
    for (const item of feedback) expect(item).toContain('Security checks found high-risk problems in the code you changed:\n- SEC-INJ-2 at run.js:1:')
    expect(io.updates.some((update) => update.sessionUpdate === 'notice' && update.title === '完成检查连续 3 次没有通过，已停止')).toBe(true)
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'gate-exhausted' }])
    // 结束时那条更新里的任务状态就是受阻、带着待验证
    const outcomeUpdate = io.updates.find((update) => infoMeta(update).turnOutcome)
    expect(outcomeUpdate && infoMeta(outcomeUpdate).taskState).toEqual({ status: 'blocked', reason: STOPPED_REASON, requirements: [], needsVerification: true })
  }, 30_000)

  test('没有检查点时 dev_server_start 也算跑过命令：判断不了有没有改动，停下时记 unverified', async () => {
    const model = scriptedModel([{ toolCalls: [{ name: 'dev_server_start', input: { command: 'pnpm gen' } }] }, { text: '起好了' }])
    const session = await makeSession(model, undefined, [], undefined, undefined, undefined, {}, { checkpoints: null })
    session.config.browser = true
    session.permissionMode = 'full'
    const io = recordingIO()
    // 开发服务器启动时生成文件
    await runTurn(session, { id: 't', text: '起服务' }, {
      ...io,
      devServer: async () => {
        writeFileSync(join(project, 'out.txt'), 'x')
        return { text: 'started', url: null }
      },
    })
    expect(model.doStreamCalls).toHaveLength(2)
    expect(verifications(io)).toEqual(['unverified'])
    expect(turnOutcomes(io)).toEqual([{ finish: 'unverified', stop: null }])
  })

  test('没有检查点时跑过命令就停下记 unverified，不跑检查命令冒充验证；没跑命令时算没改动', async () => {
    const commanded = scriptedModel([{ toolCalls: [exec('printf x > out.txt')] }, { text: '写好了' }])
    const io = recordingIO()
    await runTurn(await makeSession(commanded, { afterEdit: null, beforeFinish: 'true' }, [], undefined, undefined, undefined, {}, { checkpoints: null }), { id: 't', text: '写 out.txt' }, io)
    const [card] = finishCards(io)
    // 检查命令配了，不带表示「没配检查命令」的 unverified 标记，说明由界面写
    expect(card).toMatchObject({ status: 'completed', content: [] })
    expect(card?._meta).toEqual({ diffra: { verification: 'unverified' } })
    expect(checkResults(io, '完成检查')).toEqual([])
    expect(commanded.doStreamCalls).toHaveLength(2)
    expect(turnOutcomes(io)).toEqual([{ finish: 'unverified', stop: null }])
    expect(lastTaskState(io)).toMatchObject({ status: 'completed', needsVerification: false })

    const answered = scriptedModel([{ text: '这个文件是配置' }])
    const answerIO = recordingIO()
    await runTurn(await makeSession(answered, { afterEdit: null, beforeFinish: 'true' }, [], undefined, undefined, undefined, {}, { checkpoints: null }), { id: 't', text: '看看 a.txt' }, answerIO)
    expect(verifications(answerIO)).toEqual([])
    expect(checkResults(answerIO, '完成检查')).toEqual([])
    expect(turnOutcomes(answerIO)).toEqual([{ finish: null, stop: null }])
  })

  test('没有检查点时只跑了只读命令（读文件、搜索）：算没改动，不出完成卡', async () => {
    writeFileSync(join(project, 'a.txt'), 'alpha\n')
    const model = scriptedModel([{ toolCalls: [read('a.txt'), exec('grep -n alpha a.txt')] }, { text: '内容是 alpha' }])
    const io = recordingIO()
    await runTurn(await makeSession(model, { afterEdit: null, beforeFinish: 'true' }, [], undefined, undefined, undefined, {}, { checkpoints: null }), { id: 't', text: '看看 a.txt' }, io)
    expect(verifications(io)).toEqual([])
    expect(checkResults(io, '完成检查')).toEqual([])
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: null }])
  })

  test('改了文件、模型直接停下：门禁自动跑，没配检查命令时完成卡标未验证，任务完成', async () => {
    const model = scriptedModel([{ toolCalls: [addFile('b.txt', 'b')] }, { text: '改好了' }])
    const session = await makeSession(model)
    const io = recordingIO()
    await expect(runTurn(session, { id: 't', text: '写 b.txt' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(2)
    const [card] = finishCards(io)
    // 未经验证是结构化字段，卡片正文留空由界面写
    expect(card).toMatchObject({ status: 'completed', content: [] })
    expect(card?._meta).toEqual({ diffra: { unverified: true, verification: 'unverified' } })
    expect(gateFeedback(session)).toEqual([])
    expect(turnOutcomes(io)).toEqual([{ finish: 'unverified', stop: null }])
    expect(lastTaskState(io)).toMatchObject({ status: 'completed', needsVerification: false })
  })

  test('只回答问题、不改文件：直接完成，不出完成卡', async () => {
    const model = scriptedModel([{ text: '这个项目是做什么的：……' }])
    const io = recordingIO()
    await expect(runTurn(await makeSession(model, { afterEdit: null, beforeFinish: 'false' }), { id: 't', text: '介绍一下' }, io)).resolves.toBe('end_turn')
    expect(io.updates.some((update) => update.sessionUpdate === 'agent_message_chunk')).toBe(true)
    expect(model.doStreamCalls).toHaveLength(1)
    expect(verifications(io)).toEqual([])
    expect(checkResults(io, '完成检查')).toEqual([])
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: null }])
    expect(lastTaskState(io)).toMatchObject({ status: 'completed', needsVerification: false })
  })

  test('待验证从之前轮次带过来时，本轮没改文件停下也要过门禁；只跑了不改文件的命令也一样', async () => {
    const model = scriptedModel([{ text: '这个函数负责解析配置' }])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: 'true' })
    session.taskState.needsVerification = true
    const io = recordingIO()
    await expect(runTurn(session, { id: 't', text: '这个函数是做什么的' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(1)
    expect(checkResults(io, '完成检查')).toEqual(['passed'])
    expect(verifications(io)).toEqual(['verified'])
    expect(turnOutcomes(io)).toEqual([{ finish: 'verified', stop: null }])
    expect(lastTaskState(io)).toMatchObject({ status: 'completed', needsVerification: false })

    // 没配检查命令：照样出完成卡，标未验证
    const listed = scriptedModel([{ toolCalls: [exec('ls')] }, { text: '看过了' }])
    const listedSession = await makeSession(listed)
    listedSession.taskState.needsVerification = true
    const listedIO = recordingIO()
    await runTurn(listedSession, { id: 't', text: '看看目录' }, listedIO)
    expect(listed.doStreamCalls).toHaveLength(2)
    expect(finishCards(listedIO).map((card) => card._meta)).toEqual([{ diffra: { unverified: true, verification: 'unverified' } }])
    expect(turnOutcomes(listedIO)).toEqual([{ finish: 'unverified', stop: null }])
    expect(lastTaskState(listedIO)).toMatchObject({ status: 'completed', needsVerification: false })
  }, 30_000)

  test('只跑了不改文件的命令就停下：工作区指纹没变，算没改动，不跑检查、不出完成卡', async () => {
    const model = scriptedModel([{ toolCalls: [exec('ls')] }, { text: '看过了' }])
    const io = recordingIO()
    await expect(runTurn(await makeSession(model, { afterEdit: null, beforeFinish: 'false' }), { id: 't', text: '看看目录' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(2)
    expect(checkResults(io, '完成检查')).toEqual([])
    expect(verifications(io)).toEqual([])
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: null }])
    expect(lastTaskState(io)).toMatchObject({ status: 'completed', needsVerification: false })
  })

  test('改项目外的文件（授权写的临时脚本）不算本轮改动：不跑完成检查，不出完成卡，不标待验证', async () => {
    const outside = join(project, '..', `diffra-outside-${basename(project)}.py`)
    const model = scriptedModel([{ toolCalls: [addFile(outside, 'print(1)')] }, { text: '统计完了' }])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: 'false' })
    const io = recordingIO()
    try {
      await expect(runTurn(session, { id: 't', text: '写个脚本统计一下' }, io)).resolves.toBe('end_turn')
      expect(readFileSync(outside, 'utf8')).toBe('print(1)\n')
      // 项目外写入照旧要问
      expect(io.permissionRequests).toBe(1)
      expect(model.doStreamCalls).toHaveLength(2)
      expect(checkResults(io, '完成检查')).toEqual([])
      expect(verifications(io)).toEqual([])
      expect(turnOutcomes(io)).toEqual([{ finish: null, stop: null }])
      expect(session.taskState).toMatchObject({ status: 'completed', needsVerification: false })
    } finally {
      rmSync(outside, { force: true })
    }
  })

  test('没有检查点时重新生成不回滚文件，待验证保留重新生成前的值', async () => {
    const model = scriptedModel([{ toolCalls: [addFile('a.txt', 'a')] }])
    const session = await makeSession(model, undefined, [], undefined, undefined, ONE_STEP, {}, { checkpoints: null })
    session.startTurn('turn-1', '写 a.txt')
    await expect(runTurn(session, { id: 'turn-1', text: '写 a.txt' }, recordingInto(session))).resolves.toBe('max_turn_requests')
    session.endTurn('max_turn_requests')
    expect(session.taskState.needsVerification).toBe(true)
    await expect(session.rewind('turn-1')).resolves.toEqual({ filesRestored: false })
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('a\n')
    expect(session.taskState).toEqual({ status: 'running', needsVerification: true, reason: null })
  })

  test('有检查点时重新生成：文件回到这一轮开始前，待验证取这一轮开始时的值', async () => {
    const session = await twoUnverifiedTurns()
    await expect(session.rewind('turn-2')).resolves.toEqual({ filesRestored: true })
    expect(existsSync(join(project, 'b.txt'))).toBe(false)
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('a\n')
    // 第二轮开始时带着第一轮没验证的改动
    expect(session.taskState).toEqual({ status: 'running', needsVerification: true, reason: null })

    await expect(session.rewind('turn-1')).resolves.toEqual({ filesRestored: true })
    expect(existsSync(join(project, 'a.txt'))).toBe(false)
    expect(session.taskState).toEqual({ status: 'running', needsVerification: false, reason: null })
  }, 30_000)

  test('撤销：任务状态改成受阻，待验证和原因按这一轮之前有没有没验证的改动', async () => {
    const session = await twoUnverifiedTurns()
    await session.restoreCheckpoint('turn-2')
    expect(existsSync(join(project, 'b.txt'))).toBe(false)
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('a\n')
    expect(session.taskState).toEqual({ status: 'blocked', needsVerification: true, reason: '文件已撤销，之前轮次的改动还没验证。' })
    expect(session.messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('[Note from Diffra] The user reverted all file changes') })

    await session.restoreCheckpoint('turn-1')
    expect(existsSync(join(project, 'a.txt'))).toBe(false)
    expect(session.taskState).toEqual({ status: 'blocked', needsVerification: false, reason: '文件已撤销，原来的结论不再算数。' })
  }, 30_000)

  test('apply_patch 失败、没改到文件时，不算改动：不跑检查，也不标成需要验证', async () => {
    const model = scriptedModel([{ toolCalls: [replaceLines('missing.txt', 'x', 'y')] }, { text: '文件不存在，没有改动' }])
    const io = recordingIO()
    await expect(runTurn(await makeSession(model, { afterEdit: null, beforeFinish: 'false' }), { id: 't', text: '改 missing.txt' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(2)
    expect(toolUpdates(io, 'failed')).toHaveLength(1)
    expect(checkResults(io, '完成检查')).toEqual([])
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: null }])
    expect(lastTaskState(io)).toMatchObject({ needsVerification: false })
  })

  test('需要确认的命令被拒绝后，模型收到拒绝结果，文件没被写', async () => {
    const model = scriptedModel([{ toolCalls: [exec('echo hi > out.txt')] }, { text: '好的，不执行了' }])
    const io = recordingIO('reject')
    await expect(runTurn(await makeSession(model), { id: 't', text: '写文件' }, io)).resolves.toBe('end_turn')
    expect(io.permissionRequests).toBe(1)
    expect(existsSync(join(project, 'out.txt'))).toBe(false)
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('rejected this command')
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: null }])
  })

  test('命令确认带上模型写的 justification：确认请求的 rawInput 和卡片内容里都有；没写时不带', async () => {
    const justification = '把结果写进 out.txt，方便你对照'
    const model = scriptedModel([{ toolCalls: [exec('echo hi > out.txt', { justification })] }, { toolCalls: [exec('echo hi > out2.txt')] }, { text: '好的，不执行了' }])
    const asked: ToolCallUpdate[] = []
    const io = recordingIO('reject')
    io.requestPermission = async (toolCall: ToolCallUpdate) => {
      asked.push(toolCall)
      return 'reject'
    }
    await runTurn(await makeSession(model), { id: 't', text: '写文件' }, io)
    expect(asked).toHaveLength(2)
    expect(asked[0]).toMatchObject({ title: '执行 echo hi > out.txt', kind: 'execute', status: 'pending' })
    expect(asked[0]?.rawInput).toEqual({ command: 'echo hi > out.txt', justification })
    expect(asked[0]?.content).toEqual([{ type: 'content', content: { type: 'text', text: justification } }])
    expect(asked[1]?.rawInput).toEqual({ command: 'echo hi > out2.txt' })
    expect(asked[1]?.content).toBeUndefined()
  })

  test('命令确认多一项「这个项目里始终允许同类命令」，带上要记的命令键；项目里已经允许的不再问；无项目任务和 rm 不给这一项', async () => {
    const run = (cmd: string): Step => ({ toolCalls: [exec(cmd)] })
    const asked: Array<{ options: string[]; meta: unknown }> = []
    const answering = (pick: string) => {
      const io = recordingIO()
      io.requestPermission = async (toolCall: ToolCallUpdate, options: PermissionOption[]) => {
        asked.push({ options: options.map((option) => option.optionId), meta: toolCall._meta })
        return pick
      }
      return io
    }

    // 选了项目里始终允许：这个会话里同类命令马上不再问
    const model = scriptedModel([run('node --version'), run('node -e "1"'), run('rm -f nothing.txt'), { text: '好了' }])
    await runTurn(await makeSession(model), { id: 't', text: '跑一下' }, answering('allow_project'))
    expect(asked[0]?.options).toEqual(['allow_once', 'allow_always', 'allow_project', 'reject'])
    expect(asked[0]?.meta).toEqual({ diffra: { projectCommands: { cwd: project, keys: ['node'] } } })
    // 第二条 node 命令没再问；rm 照旧问，而且没有「项目里始终允许」
    expect(asked).toHaveLength(2)
    expect(asked[1]?.options).toEqual(['allow_once', 'allow_always', 'reject'])

    // 建会话时带进来的命令键：一开始就不问；手填的 rm 不算数，照旧问
    asked.length = 0
    const base = await makeSession(scriptedModel([]))
    const allowed = new Session({
      cwd: project,
      config: { ...base.config, allowedCommands: ['node', 'rm'] },
      environment: base.environment,
      checkpoints: null,
      rulePacks: [],
      systemPrompt: base.systemPrompt,
      model: scriptedModel([run('node --version'), run('rm -f nothing.txt'), { text: '好了' }]),
    })
    await runTurn(allowed, { id: 't', text: '跑一下' }, answering('reject'))
    expect(asked).toHaveLength(1)
    expect(asked[0]?.options).toEqual(['allow_once', 'allow_always', 'reject'])
  }, 30_000)

  test('危险命令直接拦下，不弹确认', async () => {
    const model = scriptedModel([{ toolCalls: [exec('rm -rf /')] }, { text: '好' }])
    const io = recordingIO('allow_once')
    await runTurn(await makeSession(model), { id: 't', text: '清理' }, io)
    expect(io.permissionRequests).toBe(0)
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('blocked by Diffra')
  })

  test('允许的命令照常执行，输出按 Wall time / 退出码 / Output 的格式返回给模型', async () => {
    const model = scriptedModel([{ toolCalls: [exec('echo from-bash')] }, { text: '好' }])
    const io = recordingIO()
    const session = await makeSession(model)
    await runTurn(session, { id: 't', text: '跑命令' }, io)
    expect(io.permissionRequests).toBe(0)
    expect(resultText(toolResults(session)[0])).toMatch(/^Wall time: \d+\.\d{4} seconds\nProcess exited with code 0\nOutput:\nfrom-bash$/)
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('from-bash')
  })

  test('命令结果的 _meta 带上是否成功：退出码非 0 时工具调用仍是 completed，但 commandSucceeded 为 false；apply_patch 不带', async () => {
    const model = scriptedModel([
      { toolCalls: [exec('echo ok')] },
      { toolCalls: [exec('exit 3')] },
      { toolCalls: [read('missing.txt')] },
      { toolCalls: [addFile('n.txt', 'n')] },
      { text: '好' },
    ])
    const io = recordingIO()
    await runTurn(await makeSession(model), { id: 't', text: '跑命令' }, io)
    const metaOf = (toolCallId: string) => {
      const update = io.updates.findLast((item) => item.sessionUpdate === 'tool_call_update' && item.toolCallId === toolCallId)
      return update?.sessionUpdate === 'tool_call_update' ? { status: update.status, meta: update._meta } : null
    }
    expect(metaOf('call-0-0')).toEqual({ status: 'completed', meta: { diffra: { commandSucceeded: true } } })
    expect(metaOf('call-1-0')).toEqual({ status: 'completed', meta: { diffra: { commandSucceeded: false } } })
    // 读不存在的文件也是命令，cat 退出码非 0
    expect(metaOf('call-2-0')).toEqual({ status: 'completed', meta: { diffra: { commandSucceeded: false } } })
    // 不是命令的工具不带这个字段
    expect(metaOf('call-3-0')).toEqual({ status: 'completed', meta: undefined })
  })

  test('工具开始时的标题就带上目标，跑完后换成工具返回的标题；失败的保留开始时的标题', async () => {
    writeFileSync(join(project, 'a.txt'), 'hello\n')
    const model = scriptedModel([
      { toolCalls: [exec('echo ok')] },
      { toolCalls: [read('./a.txt')] },
      { toolCalls: [replaceLines('missing.txt', 'x', 'y')] },
      { toolCalls: [addFile('b.txt', 'b')] },
      { toolCalls: [replaceLines('a.txt', 'hello', 'hi')] },
      { toolCalls: [patch('*** Add File: c.txt', '+c', '*** Add File: d.txt', '+d')] },
      { toolCalls: [deleteFile('c.txt')] },
      { text: '完成' },
    ])
    const io = recordingIO()
    await runTurn(await makeSession(model), { id: 't', text: '看看' }, io)
    const startTitles = io.updates.flatMap((update) => (update.sessionUpdate === 'tool_call' && update.title !== '完成' ? [update.title] : []))
    expect(startTitles).toEqual(['执行 echo ok', '执行 cat ./a.txt', '修改文件', '修改文件', '修改文件', '修改文件', '修改文件'])
    const finalTitle = (toolCallId: string) => {
      const update = io.updates.findLast((item) => item.sessionUpdate === 'tool_call_update' && item.toolCallId === toolCallId)
      return update?.sessionUpdate === 'tool_call_update' ? { status: update.status, title: update.title } : null
    }
    expect(finalTitle('call-0-0')).toEqual({ status: 'completed', title: '执行 echo ok' })
    expect(finalTitle('call-1-0')).toEqual({ status: 'completed', title: '执行 cat ./a.txt' })
    expect(finalTitle('call-2-0')).toEqual({ status: 'failed', title: undefined })
    expect(finalTitle('call-3-0')).toEqual({ status: 'completed', title: '新建 b.txt' })
    expect(finalTitle('call-4-0')).toEqual({ status: 'completed', title: '编辑 a.txt' })
    expect(finalTitle('call-5-0')).toEqual({ status: 'completed', title: '修改 c.txt、d.txt' })
    expect(finalTitle('call-6-0')).toEqual({ status: 'completed', title: '删除 c.txt' })
  }, 30_000)

  test('参数不合法的工具调用返回错误，每个调用都有且只有一个结果，不算跑过命令', async () => {
    const model = scriptedModel([{ toolCalls: [{ name: 'exec_command', input: {} }] }, { text: '好' }])
    const session = await makeSession(model, undefined, [], undefined, undefined, undefined, {}, { checkpoints: null })
    const io = recordingIO()
    await runTurn(session, { id: 't', text: '读' }, io)
    const results = toolResults(session)
    expect(results).toHaveLength(1)
    expect(JSON.stringify(results[0])).toMatch(/Invalid/)
    // 没有检查点时跑过命令会记 unverified；这个调用根本没执行
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: null }])
  })

  test('停止时结束正在跑的命令并返回 cancelled，任务取消，对话末尾加上 <turn_aborted>', async () => {
    const model = scriptedModel([{ toolCalls: [exec('sleep 30', { yield_time_ms: 30_000 })] }, { text: '不会走到这里' }])
    const session = await makeSession(model)
    const io = recordingIO()
    const started = Date.now()
    const running = runTurn(session, { id: 't', text: '等' }, io)
    setTimeout(() => session.cancel(), 500)
    await expect(running).resolves.toBe('cancelled')
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(session.running).toBe(false)
    expect(model.doStreamCalls).toHaveLength(1)
    // 等着的进程一起结束，不留在后台
    expect(session.execSessions.size).toBe(0)
    expect(toolResults(session).map((part) => part.output)).toEqual([{ type: 'error-text', value: 'Cancelled by the user. The process was stopped.' }])
    expect(session.messages.at(-1)).toEqual({ role: 'user', content: TURN_ABORTED_NOTE })
    expect(session.taskState).toMatchObject({ status: 'cancelled', reason: '用户取消，任务并未完成。' })
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'cancelled' }])
  }, 30_000)

  test('门禁跑检查时停止：不标记完成、不打回，返回 cancelled，改动留着待验证，对话末尾加上 <turn_aborted>', async () => {
    const check = 'sleep 30'
    const model = scriptedModel([{ toolCalls: [addFile('new.txt', 'x')] }, { text: '改好了' }])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: check })
    const io = recordingIO()
    const update = io.update
    io.update = async (item: SessionUpdate) => {
      await update(item)
      if (item.sessionUpdate === 'tool_call' && item.title === `完成检查：${check}`) setTimeout(() => session.cancel(), 300)
    }
    const started = Date.now()
    await expect(runTurn(session, { id: 't', text: '写 new.txt' }, io)).resolves.toBe('cancelled')
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(model.doStreamCalls).toHaveLength(2)
    expect(checkResults(io, '完成检查')).toEqual(['failed'])
    expect(verifications(io)).toEqual([])
    expect(gateFeedback(session)).toEqual([])
    expect(session.messages.at(-1)).toEqual({ role: 'user', content: TURN_ABORTED_NOTE })
    expect(session.taskState).toEqual({ status: 'cancelled', needsVerification: true, reason: '用户取消，任务并未完成。' })
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'cancelled' }])
  }, 30_000)

  test('模型调用失败时停下，记 model-error，任务受阻', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw serviceError(400)
      },
    })
    const io = recordingIO()
    await expect(runTurn(await makeSession(model), { id: 't', text: '介绍一下' }, io)).resolves.toBe('end_turn')
    expect(io.updates.some((update) => update.sessionUpdate === 'notice' && update.title === '模型调用失败')).toBe(true)
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'model-error', errorKind: 'unknown' }])
    expect(lastTaskState(io)).toMatchObject({ status: 'blocked', reason: STOPPED_REASON })
  })
})

describe('输出被截断', () => {
  const promptOf = (model: MockLanguageModelV4, index: number) => JSON.stringify(model.doStreamCalls[index]?.prompt)

  test('只回了半截文字时提醒接着写，不当成回答结束', async () => {
    const model = scriptedModel([{ text: '前半段', truncated: true }, { text: '后半段' }])
    const session = await makeSession(model)
    await expect(runTurn(session, { id: 't', text: '讲讲' }, recordingIO())).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(2)
    expect(promptOf(model, 1)).toContain('cut off by the output token limit')
  })

  test('工具参数被截断时不执行，参数错误之后说明是被截断了、要拆成几次小的 apply_patch', async () => {
    writeFileSync(join(project, 'a.txt'), 'hello\n')
    const model = scriptedModel([
      { toolCalls: [{ name: 'apply_patch', input: null, raw: '{"input":"*** Begin Patch\\n*** Update File: a.txt\\n-hello\\n+hel' }], truncated: true },
      { text: '好' },
    ])
    const session = await makeSession(model)
    await runTurn(session, { id: 't', text: '改' }, recordingIO())
    expect(model.doStreamCalls).toHaveLength(2)
    expect(promptOf(model, 1)).toContain('A tool call that was cut off was not executed')
    expect(promptOf(model, 1)).toContain('several smaller apply_patch calls')
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('hello\n')
  })

  test('连续截断超过两次不再提醒，照原来的流程结束', async () => {
    const model = scriptedModel([{ text: '1', truncated: true }, { text: '2', truncated: true }, { text: '3', truncated: true }, { text: '不会走到这里' }])
    const session = await makeSession(model)
    await expect(runTurn(session, { id: 't', text: '讲讲' }, recordingIO())).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(3)
  })

  test('工具调用完整、只是回复到了上限时照常执行，不加提醒', async () => {
    writeFileSync(join(project, 'a.txt'), 'hello\n')
    const model = scriptedModel([{ toolCalls: [read('a.txt')], truncated: true }, { text: '好' }])
    const session = await makeSession(model)
    await runTurn(session, { id: 't', text: '读' }, recordingIO())
    expect(promptOf(model, 1)).toContain('Output:\\nhello')
    expect(promptOf(model, 1)).not.toContain('cut off by the output token limit')
  })
})
