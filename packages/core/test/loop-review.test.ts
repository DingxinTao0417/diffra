import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PermissionOption, SessionUpdate, ToolCallUpdate } from '@agentclientprotocol/sdk'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { RulePack, SessionSecurity } from '../src/protocol.js'
import { runTurn, type TurnIO } from '../src/session/loop.js'
import type { Session } from '../src/session/session.js'
import {
  addFile,
  checkResults,
  exec,
  lastTaskState,
  makeSession,
  project,
  read,
  recordingIO,
  replaceLines,
  scriptedModel,
  type Step,
  toolUpdates,
  turnOutcomes,
  useTempProject,
  verifications,
  withoutContext,
} from './loop-helpers.js'

// 结束门禁里的规范审查、安全检查，提交前问深度扫描，Git 带进来的改动不算这一轮的

useTempProject()

const GATE_FEEDBACK = '[Diffra] Before ending the turn Diffra ran the project checks on your changes, and the task is not finished yet.'

// 结束门禁打回时追加进对话的用户消息，按出现顺序
const gateFeedback = (session: Session) =>
  session.messages.flatMap((message) => (message.role === 'user' && typeof message.content === 'string' && message.content.startsWith(GATE_FEEDBACK) ? [message.content] : []))

// 第 index 次调用编码模型时发出去的对话
const promptOf = (model: MockLanguageModelV4, index: number) => JSON.stringify(model.doStreamCalls[index]?.prompt)

const lastFinishCard = (io: { updates: SessionUpdate[] }) => io.updates.findLast((update) => update.sessionUpdate === 'tool_call' && update.title === '完成')

describe('结束前的规范审查', () => {
  const pack: RulePack = {
    id: 'u',
    name: '通用',
    languages: ['*'],
    source: '',
    license: '',
    rules: [
      { id: 'GEN-ERR-1', level: 'required', section: null, text: '不吞异常。' },
      { id: 'GEN-NAME-4', level: 'recommended', section: null, text: '常量名说完整。' },
    ],
  }
  const swallowing = 'try {\n  run()\n} catch {}\n'
  const rethrow = replaceLines('app.ts', '} catch {}', '} catch (error) {\n  log(error)\n  throw error\n}')

  test('模型停下时审查发现违规就打回一条消息、接着调模型；推荐级、不在本轮改动里的意见丢掉；改好后再停下时审查通过', async () => {
    const model = scriptedModel([
      { toolCalls: [addFile('app.ts', swallowing)] },
      { text: '加了 run 调用' },
      { toolCalls: [read('app.ts')] },
      { toolCalls: [rethrow] },
      { text: '异常记日志后抛出' },
    ])
    const reviewer = scriptedModel([
      {
        text:
          '检查了一下：\n- GEN-ERR-1 | app.ts:3 | catch 块是空的，吞掉了异常\n' +
          'GEN-NAME-4 | app.ts:2 | 推荐级不拦\nGEN-ERR-1 | other.ts:1 | 不是这次改的文件\nGEN-ERR-1 | app.ts:9 | 不是新增的行',
      },
      { text: 'NO_VIOLATIONS' },
    ])
    const session = await makeSession(model, undefined, [], { packs: [pack], model: reviewer })
    const io = recordingIO()

    await expect(runTurn(session, { id: 't', text: '调用 run' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(5)
    expect(reviewer.doStreamCalls).toHaveLength(2)
    // 每次模型调用都记了用量，审查调用记成 reviewer
    expect(io.usage.map((call) => call.role)).toEqual(['coder', 'coder', 'reviewer', 'coder', 'coder', 'coder', 'reviewer'])
    expect(io.usage[2]).toMatchObject({ modelId: 'mock', provider: null, usage: { inputTokens: 1000, outputTokens: 10 } })

    // 只打回一次：一条用户消息，只带强制级、落在本轮新增行上的意见；第二次停下时通过，不再追加
    const feedback = gateFeedback(session)
    expect(feedback).toHaveLength(1)
    expect(feedback[0]).toContain('The rule review found violations in the code you changed:\n- GEN-ERR-1 at app.ts:3: catch 块是空的，吞掉了异常')
    expect(feedback[0]).toContain('explain why in your final message')
    expect(feedback[0]).not.toContain('GEN-NAME-4')
    expect(feedback[0]).not.toContain('other.ts')
    expect(feedback[0]).not.toContain('app.ts:9')
    // 打回之后接着调模型，下一次请求里带着这条消息
    expect(promptOf(model, 1)).not.toContain('GEN-ERR-1 at app.ts:3')
    expect(promptOf(model, 2)).toContain('GEN-ERR-1 at app.ts:3')
    const conversation = withoutContext(session.messages)
    const feedbackAt = conversation.findIndex((message) => message.role === 'user' && message.content === feedback[0])
    expect(conversation[feedbackAt - 1]).toMatchObject({ role: 'assistant' })
    expect(conversation[feedbackAt + 1]).toMatchObject({ role: 'assistant' })

    // 审查模型看到带新文件行号的 diff、只含强制级的规则；summary 是模型停下时说的话
    const firstReview = JSON.stringify(reviewer.doStreamCalls[0]?.prompt)
    expect(firstReview).toContain('=== app.ts')
    expect(firstReview).toContain('    3 + } catch {}')
    expect(firstReview).toContain('GEN-ERR-1: 不吞异常。')
    expect(firstReview).not.toContain('GEN-NAME-4')
    expect(firstReview).toContain("Author's summary: 加了 run 调用")
    expect(JSON.stringify(reviewer.doStreamCalls[1]?.prompt)).toContain("Author's summary: 异常记日志后抛出")

    // 界面上：两张审查卡片，第一张失败；两张完成卡，第一张失败、最后一张通过（没配检查命令）
    const reviewCards = io.updates.filter((update) => update.sessionUpdate === 'tool_call' && update.title === '规范审查')
    expect(reviewCards).toHaveLength(2)
    expect(toolUpdates(io, 'failed').some((update) => JSON.stringify(update).includes('catch 块是空的'))).toBe(true)
    expect(checkResults(io, '规范审查')).toEqual(['failed', 'passed'])
    expect(verifications(io)).toEqual(['failed', 'unverified'])
    expect(lastFinishCard(io)).toMatchObject({ status: 'completed' })
    expect(turnOutcomes(io)).toEqual([{ finish: 'unverified', stop: null }])
    expect(lastTaskState(io)).toMatchObject({ status: 'completed', needsVerification: false })
  }, 30_000)

  test('完成检查不过时审查照样跑，两类问题在同一条打回消息里交回；一步都改好后再停下时通过', async () => {
    const model = scriptedModel([
      { toolCalls: [addFile('app.ts', swallowing)] },
      { text: '加了 run 调用' },
      { toolCalls: [rethrow, addFile('done.txt', 'ok')] },
      { text: '异常记日志后抛出' },
    ])
    const reviewer = scriptedModel([{ text: 'GEN-ERR-1 | app.ts:3 | catch 块是空的，吞掉了异常' }, { text: 'NO_VIOLATIONS' }])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: 'test -f done.txt' }, [], { packs: [pack], model: reviewer })
    const io = recordingIO()

    await expect(runTurn(session, { id: 't', text: '调用 run' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(4)
    expect(reviewer.doStreamCalls).toHaveLength(2)
    const feedback = gateFeedback(session)
    expect(feedback).toHaveLength(1)
    expect(feedback[0]).toContain('The check `test -f done.txt` failed.')
    expect(feedback[0]).toContain('one apply_patch can change several files')
    expect(feedback[0]).toContain('- GEN-ERR-1 at app.ts:3: catch 块是空的，吞掉了异常')
    expect(promptOf(model, 2)).toContain('The check `test -f done.txt` failed.')
    expect(checkResults(io, '完成检查')).toEqual(['failed', 'passed'])
    expect(checkResults(io, '规范审查')).toEqual(['failed', 'passed'])
    const finishCards = io.updates.flatMap((update) => (update.sessionUpdate === 'tool_call' && update.title === '完成' ? [JSON.stringify(update.content)] : []))
    expect(finishCards[0]).toContain('完成检查没有通过：test -f done.txt；规范审查发现 1 处问题')
    expect(finishCards[1]).toContain('检查通过：test -f done.txt')
    expect(verifications(io)).toEqual(['failed', 'verified'])
    expect(turnOutcomes(io)).toEqual([{ finish: 'verified', stop: null }])
  }, 30_000)

  test('本轮改动在完成检查开跑前取：检查命令自己生成的文件不进审查', async () => {
    const model = scriptedModel([{ toolCalls: [addFile('app.ts', 'run()')] }, { text: '加了 run 调用' }])
    const reviewer = scriptedModel([{ text: 'NO_VIOLATIONS' }])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: 'echo "export const generated = 1" > generated.ts' }, [], { packs: [pack], model: reviewer })
    const io = recordingIO()

    await expect(runTurn(session, { id: 't', text: '调用 run' }, io)).resolves.toBe('end_turn')
    expect(reviewer.doStreamCalls).toHaveLength(1)
    const request = JSON.stringify(reviewer.doStreamCalls[0]?.prompt)
    expect(request).toContain('=== app.ts')
    expect(request).not.toContain('generated.ts')
    expect(readFileSync(join(project, 'generated.ts'), 'utf8')).toContain('generated')
    expect(verifications(io)).toEqual(['verified'])
  }, 30_000)

  test('评审模型出错时不拦截，模型停下就完成，卡片上说明', async () => {
    const model = scriptedModel([{ toolCalls: [addFile('app.ts', 'run()')] }, { text: '完成' }])
    const reviewer = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error('reviewer down')
      },
    })
    const session = await makeSession(model, undefined, [], { packs: [pack], model: reviewer })
    const io = recordingIO()

    await expect(runTurn(session, { id: 't', text: '调用 run' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(2)
    expect(JSON.stringify(toolUpdates(io, 'failed'))).toContain('审查没有完成，这次不拦截')
    expect(checkResults(io, '规范审查')).toEqual(['error'])
    expect(gateFeedback(session)).toEqual([])
    expect(verifications(io)).toEqual(['unverified'])
    expect(lastFinishCard(io)).toMatchObject({ status: 'completed' })
    expect(turnOutcomes(io)).toEqual([{ finish: 'unverified', stop: null }])
  }, 30_000)

  test('改动太多被截断时只审查了一部分，记 partial', async () => {
    const code = Array.from({ length: 2000 }, (_, index) => `export const value${index} = ${index} // 用来撑大改动的一行`).join('\n')
    const model = scriptedModel([{ toolCalls: [addFile('big.ts', code)] }, { text: '加了常量' }])
    const reviewer = scriptedModel([{ text: 'NO_VIOLATIONS' }])
    const session = await makeSession(model, undefined, [], { packs: [pack], model: reviewer })
    const io = recordingIO()

    await expect(runTurn(session, { id: 't', text: '加常量' }, io)).resolves.toBe('end_turn')
    expect(reviewer.doStreamCalls).toHaveLength(1)
    expect(JSON.stringify(reviewer.doStreamCalls[0]?.prompt)).toContain('The diff was cut off here because it is too long.')
    expect(JSON.stringify(toolUpdates(io, 'completed'))).toContain('只审查了前面一部分')
    expect(checkResults(io, '规范审查')).toEqual(['partial'])
    expect(verifications(io)).toEqual(['unverified'])
  }, 30_000)

  test('这一轮只改了非代码文件时不审查', async () => {
    const model = scriptedModel([{ toolCalls: [addFile('README.md', '# 说明')] }, { text: '写了说明' }])
    const reviewer = scriptedModel([{ text: 'GEN-ERR-1 | README.md:1 | x' }])
    const session = await makeSession(model, undefined, [], { packs: [pack], model: reviewer })
    const io = recordingIO()

    await expect(runTurn(session, { id: 't', text: '写说明' }, io)).resolves.toBe('end_turn')
    expect(reviewer.doStreamCalls).toHaveLength(0)
    expect(io.updates.some((update) => update.sessionUpdate === 'tool_call' && update.title === '规范审查')).toBe(false)
    expect(gateFeedback(session)).toEqual([])
    expect(verifications(io)).toEqual(['unverified'])
  }, 30_000)
})

describe('结束前的静态安全检查', () => {
  const securityCards = (io: { updates: SessionUpdate[] }) =>
    io.updates.filter((update) => update.sessionUpdate === 'tool_call' && update.title === '静态检查')
  const withEval = 'export const calc = (input: string) => eval(input)'

  test('新增的代码有高危写法时模型停下就打回，改好后通过；改文件那一步不查；没改代码的轮次不检查', async () => {
    const model = scriptedModel([
      { toolCalls: [addFile('calc.ts', withEval)] },
      { text: '加了计算' },
      { toolCalls: [read('calc.ts')] },
      { toolCalls: [replaceLines('calc.ts', withEval, 'export const calc = (input: string) => Number(input)')] },
      { text: '改成 Number' },
      { text: '只是回答问题' },
    ])
    const session = await makeSession(model, undefined, [], undefined, { staticCheck: true, lightScan: false })
    const io = recordingIO()
    await expect(runTurn(session, { id: 't1', text: '加一个计算函数' }, io)).resolves.toBe('end_turn')

    const feedback = gateFeedback(session)
    expect(feedback).toHaveLength(1)
    expect(feedback[0]).toContain('Security checks found high-risk problems in the code you changed:\n- SEC-INJ-2 at calc.ts:1:')
    // 误报的放行办法：静态检查写 diffra-allow 注释，别的在最后的回复里说明
    expect(feedback[0]).toContain('"diffra-allow <RULE-ID>: <reason>"')
    expect(feedback[0]).toContain('explain in your final message why it is safe')
    expect(promptOf(model, 2)).toContain('SEC-INJ-2 at calc.ts:1')
    const results = io.updates.filter(
      (update) => update.sessionUpdate === 'tool_call_update' && securityCards(io).some((card) => card.sessionUpdate === 'tool_call' && card.toolCallId === update.toolCallId),
    )
    // 写完 eval 那一步不查，模型停下时才查、打回，改好后通过
    expect(results.map((update) => (update.sessionUpdate === 'tool_call_update' ? update.status : null))).toEqual(['failed', 'completed'])
    expect(JSON.stringify(results[0])).toContain('高危  SEC-INJ-2  calc.ts:1')
    expect(JSON.stringify(results[1])).toContain('没有发现常见的高危写法')
    expect(checkResults(io, '静态检查')).toEqual(['failed', 'passed'])
    expect(verifications(io)).toEqual(['failed', 'unverified'])
    expect(turnOutcomes(io)).toEqual([{ finish: 'unverified', stop: null }])

    // 下一轮只回答问题，不改文件：不跑安全检查，也不出完成卡
    const second = recordingIO()
    await expect(runTurn(session, { id: 't2', text: '解释一下' }, second)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(6)
    expect(securityCards(second)).toHaveLength(0)
    expect(verifications(second)).toEqual([])
    expect(turnOutcomes(second)).toEqual([{ finish: null, stop: null }])
  }, 30_000)

  test('写了带理由的放行注释就不拦，卡片上列出放行的地方', async () => {
    const code = `// diffra-allow SEC-INJ-2: 输入来自内部配置，不来自用户\n${withEval}`
    const model = scriptedModel([{ toolCalls: [addFile('calc.ts', code)] }, { text: '加了计算，eval 已说明' }])
    const session = await makeSession(model, undefined, [], undefined, { staticCheck: true, lightScan: false })
    const io = recordingIO()

    await expect(runTurn(session, { id: 't1', text: '加一个计算函数' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(2)
    expect(JSON.stringify(toolUpdates(io, 'completed'))).toContain('已放行  SEC-INJ-2  calc.ts:2')
    expect(JSON.stringify(toolUpdates(io, 'completed'))).toContain('理由：输入来自内部配置，不来自用户')
    // 放行的地方要让用户看到，不算干净
    expect(checkResults(io, '静态检查')).toEqual(['warned'])
    expect(gateFeedback(session)).toEqual([])
    expect(lastFinishCard(io)).toMatchObject({ status: 'completed' })
    expect(verifications(io)).toEqual(['unverified'])
  }, 30_000)
})

describe('结束前的轻量安全扫描', () => {
  const scanCards = (io: { updates: SessionUpdate[] }) =>
    io.updates.filter((update) => update.sessionUpdate === 'tool_call' && update.title === '轻量扫描')

  test('模型发现高危问题时打回，改好后再扫描通过；请求里带着改动所在的完整文件和模型停下时说的话', async () => {
    const reading = 'export const read = (req) => fs.readFileSync(path.join(UPLOAD, req.query.name))'
    const model = scriptedModel([
      { toolCalls: [addFile('files.ts', reading)] },
      { text: '加了读文件接口' },
      { toolCalls: [read('files.ts')] },
      { toolCalls: [replaceLines('files.ts', reading, 'export const read = (req) => fs.readFileSync(path.join(UPLOAD, safeName(req.query.name)))')] },
      { text: '文件名限制在上传目录内' },
    ])
    const reviewer = scriptedModel([{ text: 'high | SEC-INJ-4 | files.ts:1 | 文件名来自请求参数，可以用 ../ 读到上传目录外的文件' }, { text: 'NO_FINDINGS' }])
    // 请求参数直接进 readFileSync 会被 v2 的污点分析在静态检查里拦下；这里只看轻量扫描，关掉污点分析
    const session = await makeSession(model, undefined, [], { packs: [], model: reviewer }, { staticCheck: true, lightScan: true, taint: false })
    const io = recordingIO()
    await expect(runTurn(session, { id: 't1', text: '加一个读文件接口' }, io)).resolves.toBe('end_turn')

    expect(model.doStreamCalls).toHaveLength(5)
    expect(reviewer.doStreamCalls).toHaveLength(2)
    const request = JSON.stringify(reviewer.doStreamCalls[0]?.prompt)
    expect(request).toContain('=== files.ts')
    expect(request).toContain('Files touched by the change')
    expect(request).toContain('=== files.ts (full file, for context)')
    expect(request).toContain("Author's summary: 加了读文件接口")
    expect(JSON.stringify(reviewer.doStreamCalls[1]?.prompt)).toContain("Author's summary: 文件名限制在上传目录内")
    const feedback = gateFeedback(session)
    expect(feedback).toHaveLength(1)
    expect(feedback[0]).toContain('- SEC-INJ-4 at files.ts:1: 文件名来自请求参数，可以用 ../ 读到上传目录外的文件')
    expect(feedback[0]).toContain('explain in your final message why it is safe')
    expect(scanCards(io)).toHaveLength(2)
    expect(JSON.stringify(toolUpdates(io, 'failed'))).toContain('高危  SEC-INJ-4  files.ts:1')
    expect(checkResults(io, '轻量扫描')).toEqual(['failed', 'passed'])
    expect(io.usage.filter((call) => call.role === 'reviewer')).toHaveLength(2)
    expect(verifications(io)).toEqual(['failed', 'unverified'])
    expect(lastFinishCard(io)).toMatchObject({ status: 'completed' })
  }, 30_000)

  test('静态检查已经打回时不调用模型扫描', async () => {
    const withEval = 'export const calc = (input: string) => eval(input)'
    const model = scriptedModel([
      { toolCalls: [addFile('calc.ts', withEval)] },
      { text: '加了计算' },
      { toolCalls: [replaceLines('calc.ts', withEval, 'export const calc = (input: string) => Number(input)')] },
      { text: '改成 Number' },
    ])
    const reviewer = scriptedModel([{ text: 'NO_FINDINGS' }])
    const session = await makeSession(model, undefined, [], { packs: [], model: reviewer }, { staticCheck: true, lightScan: true })
    const io = recordingIO()

    await expect(runTurn(session, { id: 't1', text: '加一个计算函数' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(4)
    // 第一次停下静态检查打回，模型扫描没跑；改好后第二次停下才扫
    expect(reviewer.doStreamCalls).toHaveLength(1)
    expect(scanCards(io)).toHaveLength(1)
    expect(checkResults(io, '静态检查')).toEqual(['failed', 'passed'])
    expect(checkResults(io, '轻量扫描')).toEqual(['passed'])
    expect(JSON.stringify(reviewer.doStreamCalls[0]?.prompt)).toContain("Author's summary: 改成 Number")
  }, 30_000)

  test('只有提醒时记 warned；模型调用失败时不拦截，记 error', async () => {
    // 两个会话共用一个项目目录，各写各的文件
    const steps = (path: string): Step[] => [{ toolCalls: [addFile(path, 'export const read = (name: string) => load(name)')] }, { text: '加了读文件' }]
    const warnedModel = scriptedModel(steps('files.ts'))
    const warned = await makeSession(warnedModel, undefined, [], { packs: [], model: scriptedModel([{ text: 'medium | SEC-INJ-4 | files.ts:1 | 确认 name 不含 ../' }]) }, { staticCheck: false, lightScan: true })
    const warnedIO = recordingIO()
    await expect(runTurn(warned, { id: 't1', text: '加读文件' }, warnedIO)).resolves.toBe('end_turn')
    expect(warnedModel.doStreamCalls).toHaveLength(2)
    expect(JSON.stringify(toolUpdates(warnedIO, 'completed'))).toContain('提醒  SEC-INJ-4  files.ts:1')
    expect(checkResults(warnedIO, '轻量扫描')).toEqual(['warned'])
    expect(toolUpdates(warnedIO, 'failed')).toHaveLength(0)
    expect(gateFeedback(warned)).toEqual([])
    expect(verifications(warnedIO)).toEqual(['unverified'])

    const failing = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error('reviewer down')
      },
    })
    const erroredModel = scriptedModel(steps('load.ts'))
    const errored = await makeSession(erroredModel, undefined, [], { packs: [], model: failing }, { staticCheck: false, lightScan: true })
    const erroredIO = recordingIO()
    await expect(runTurn(errored, { id: 't1', text: '加读文件' }, erroredIO)).resolves.toBe('end_turn')
    expect(erroredModel.doStreamCalls).toHaveLength(2)
    expect(JSON.stringify(erroredIO.updates)).toContain('模型扫描没有完成，这次不拦截')
    expect(checkResults(erroredIO, '轻量扫描')).toEqual(['error'])
    expect(gateFeedback(errored)).toEqual([])
    expect(verifications(erroredIO)).toEqual(['unverified'])
  }, 30_000)

  test('依赖审计没跑完时记 partial', async () => {
    const manifest = JSON.stringify({ packageManager: 'yarn@4.0.0', dependencies: { axios: '1.6.0' } }, null, 2)
    const model = scriptedModel([{ toolCalls: [addFile('package.json', manifest)] }, { text: '加了 axios' }])
    const reviewer = scriptedModel([{ text: 'NO_FINDINGS' }])
    const session = await makeSession(model, undefined, [], { packs: [], model: reviewer }, { staticCheck: false, lightScan: true })
    const io = recordingIO()

    await expect(runTurn(session, { id: 't1', text: '加依赖' }, io)).resolves.toBe('end_turn')
    expect(JSON.stringify(io.updates)).toContain('yarn 项目暂不支持依赖审计')
    expect(checkResults(io, '轻量扫描')).toEqual(['partial'])
    expect(gateFeedback(session)).toEqual([])
    expect(verifications(io)).toEqual(['unverified'])
  }, 30_000)

  test('只有项目原有的依赖漏洞时记 warned', async () => {
    // 假的 npm：audit 报一个和本轮依赖无关的漏洞，不联网
    const bin = mkdtempSync(join(tmpdir(), 'diffra-fake-bin-'))
    const report = { vulnerabilities: { minimist: { name: 'minimist', severity: 'moderate', via: [{ title: 'Prototype pollution' }], fixAvailable: true } } }
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(report)}\nJSON\nexit 1\n`, { mode: 0o755 })
    const savedPath = process.env.PATH
    process.env.PATH = `${bin}${process.platform === 'win32' ? ';' : ':'}${savedPath ?? ''}`
    try {
      const manifest = JSON.stringify({ dependencies: { axios: '1.7.4' } }, null, 2)
      const model = scriptedModel([
        { toolCalls: [addFile('package.json', manifest)] },
        { toolCalls: [addFile('package-lock.json', '{}')] },
        { text: '加了 axios' },
      ])
      const reviewer = scriptedModel([{ text: 'NO_FINDINGS' }])
      const session = await makeSession(model, undefined, [], { packs: [], model: reviewer }, { staticCheck: false, lightScan: true })
      const io = recordingIO()

      await expect(runTurn(session, { id: 't1', text: '加依赖' }, io)).resolves.toBe('end_turn')
      expect(JSON.stringify(io.updates)).toContain('项目原有 1 个依赖漏洞')
      expect(checkResults(io, '轻量扫描')).toEqual(['warned'])
      expect(toolUpdates(io, 'failed')).toHaveLength(0)
      expect(gateFeedback(session)).toEqual([])
    } finally {
      process.env.PATH = savedPath
      rmSync(bin, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('提交前问深度扫描', () => {
  const deepScanOn: SessionSecurity = { staticCheck: false, lightScan: false, deepScan: true }
  const editCode = (path: string): Step => ({ toolCalls: [addFile(path, 'export const run = () => 1')] })
  const commitCall = exec('git -c core.quotepath=false commit -m 改了')
  const commit: Step = { toolCalls: [commitCall] }
  const push: Step = { toolCalls: [exec('git push')] }
  // 和 core 一样先记下这一轮再跑：「本任务改动」从记下的第一轮的快照算起
  const run = async (session: Session, id: string, text: string, io: TurnIO) => {
    session.startTurn(id, text)
    try {
      return await runTurn(session, { id, text }, io)
    } finally {
      session.endTurn('end_turn')
    }
  }
  // 记下每次确认的标题和 scope；深度扫描的确认按 pick 选，其他的（命令确认）一律允许一次
  function askingIO(pick: 'deep-scan-first' | 'deep-scan-skip' | 'deep-scan-never') {
    const io = recordingIO()
    const asked: Array<{ title: string; scope: unknown; command: unknown }> = []
    io.requestPermission = async (toolCall: ToolCallUpdate, options: PermissionOption[]) => {
      io.permissionRequests++
      const raw = typeof toolCall.rawInput === 'object' && toolCall.rawInput !== null ? (toolCall.rawInput as Record<string, unknown>) : {}
      const scope = raw.scope ?? null
      asked.push({ title: toolCall.title ?? '', scope, command: raw.command ?? null })
      return scope === 'deep-scan-before-commit' ? pick : (options.find((option) => option.kind === 'allow_once')?.optionId ?? null)
    }
    return Object.assign(io, { asked })
  }
  const deepScanAsks = (asked: Array<{ title: string; scope: unknown; command: unknown }>) => asked.filter((item) => item.scope === 'deep-scan-before-commit')
  const commandCards = (io: { updates: SessionUpdate[] }, text: string) =>
    io.updates.filter((update) => update.sessionUpdate === 'tool_call' && update.title.includes(text))

  test('开着深度扫描、本任务改过代码：exec_command 提交前先问；选先扫描时这条命令和同一步后面的调用都不执行，这一轮停下记 deep-scan，任务等待中', async () => {
    const model = scriptedModel([editCode('app.ts'), { toolCalls: [commitCall, exec('echo 提交之后')] }, { text: '不会走到这里' }])
    const session = await makeSession(model, undefined, [], undefined, deepScanOn)
    const io = askingIO('deep-scan-first')

    await expect(run(session, 't1', '改完提交', io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(2)
    expect(deepScanAsks(io.asked)).toEqual([{ title: '提交前先做一次深度扫描？', scope: 'deep-scan-before-commit', command: 'git -c core.quotepath=false commit -m 改了' }])
    // 提交命令没走到命令确认
    expect(io.asked).toHaveLength(1)
    // 提交命令出一张没执行的卡，后面那条命令没开始
    expect(commandCards(io, 'commit')).toMatchObject([{ status: 'failed', kind: 'execute', title: '执行 git -c core.quotepath=false commit -m 改了' }])
    expect(JSON.stringify(commandCards(io, 'commit'))).toContain('先做深度扫描，这条命令没有执行')
    expect(commandCards(io, '提交之后')).toEqual([])
    const results = session.messages.at(-1)
    expect(results).toMatchObject({ role: 'tool' })
    expect(JSON.stringify(results)).toContain('The user wants a deep security scan')
    expect(JSON.stringify(results)).toContain('this batched call was not executed')
    // 停在提交前，不跑结束门禁
    expect(verifications(io)).toEqual([])
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'deep-scan' }])
    expect(lastTaskState(io)).toMatchObject({ status: 'waiting', reason: '提交前先做深度扫描：看完报告再决定修哪些、要不要提交。' })
  }, 30_000)

  test('选「这个任务不再问」照常执行，这个会话里再提交、推送都不问；选直接推送只放过这一次', async () => {
    const never = scriptedModel([editCode('app.ts'), commit, push, { text: '好了' }])
    const neverSession = await makeSession(never, undefined, [], undefined, deepScanOn)
    const neverIO = askingIO('deep-scan-never')
    await expect(run(neverSession, 't1', '改完提交推送', neverIO)).resolves.toBe('end_turn')
    expect(never.doStreamCalls).toHaveLength(4)
    expect(deepScanAsks(neverIO.asked)).toEqual([{ title: '提交前先做一次深度扫描？', scope: 'deep-scan-before-commit', command: 'git -c core.quotepath=false commit -m 改了' }])
    expect(neverSession.deepScanDeclined).toBe(true)
    // 两条命令都照常执行（走了命令确认）
    expect(neverIO.asked.filter((item) => item.scope === null).map((item) => item.command)).toEqual(['git -c core.quotepath=false commit -m 改了', 'git push'])
    expect(commandCards(neverIO, 'git push')).toMatchObject([{ status: 'in_progress' }])
    expect(turnOutcomes(neverIO)).toEqual([{ finish: 'unverified', stop: null }])

    const skip = scriptedModel([editCode('b.ts'), push, push, { text: '好了' }])
    const skipIO = askingIO('deep-scan-skip')
    await expect(run(await makeSession(skip, undefined, [], undefined, deepScanOn), 't1', '改完推送', skipIO)).resolves.toBe('end_turn')
    expect(skip.doStreamCalls).toHaveLength(4)
    expect(deepScanAsks(skipIO.asked).map((item) => item.title)).toEqual(['推送前先做一次深度扫描？', '推送前先做一次深度扫描？'])
    expect(commandCards(skipIO, 'git push')).toMatchObject([{ status: 'in_progress' }, { status: 'in_progress' }])
  }, 30_000)

  test('关着深度扫描、只改了非代码文件、扫过之后代码没再变时都不问', async () => {
    const off = scriptedModel([editCode('app.ts'), commit, { text: '好了' }])
    const offIO = askingIO('deep-scan-first')
    await run(await makeSession(off), 't1', '改完提交', offIO)
    expect(off.doStreamCalls).toHaveLength(3)
    expect(deepScanAsks(offIO.asked)).toEqual([])

    const docs = scriptedModel([{ toolCalls: [addFile('README.md', '# 说明')] }, commit, { text: '好了' }])
    const docsIO = askingIO('deep-scan-first')
    await run(await makeSession(docs, undefined, [], undefined, deepScanOn), 't1', '写说明并提交', docsIO)
    expect(docs.doStreamCalls).toHaveLength(3)
    expect(deepScanAsks(docsIO.asked)).toEqual([])

    const scanned = scriptedModel([editCode('c.ts'), { text: '改好了' }, commit, { text: '好了' }, editCode('d.ts'), commit, { text: '好了' }])
    const scannedSession = await makeSession(scanned, undefined, [], undefined, deepScanOn)
    await run(scannedSession, 't1', '改一下', recordingIO())
    // 深度扫描跑完时记下的工作区指纹（见 security/deep.ts）
    scannedSession.deepScannedFingerprint = await scannedSession.checkpoints!.fingerprint()
    const scannedIO = askingIO('deep-scan-first')
    await run(scannedSession, 't2', '提交', scannedIO)
    expect(deepScanAsks(scannedIO.asked)).toEqual([])
    expect(commandCards(scannedIO, 'commit')).toMatchObject([{ status: 'in_progress' }])
    // 扫过之后代码又变了：再问
    const changedIO = askingIO('deep-scan-skip')
    await run(scannedSession, 't3', '再改再提交', changedIO)
    expect(deepScanAsks(changedIO.asked)).toHaveLength(1)
    expect(scanned.doStreamCalls).toHaveLength(7)
  }, 30_000)
})

describe('拉取代码这类 Git 带进来的改动', () => {
  const identity = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, ...identity }, encoding: 'utf8' })
  let upstream: string

  // 项目是 Git 仓库，上游是它的克隆：上游多了一个提交（改了 app.ts、新加带 eval 的 lib.ts），项目还没拉
  beforeEach(() => {
    git(project, 'init', '-q', '-b', 'main')
    writeFileSync(join(project, 'app.ts'), 'export const a = 1\n')
    git(project, 'add', '.')
    git(project, 'commit', '-qm', 'init')
    upstream = mkdtempSync(join(tmpdir(), 'diffra-loop-upstream-'))
    git(upstream, 'clone', '-q', project, '.')
    writeFileSync(join(upstream, 'app.ts'), 'export const a = 2\n')
    writeFileSync(join(upstream, 'lib.ts'), 'export const run = (input: string) => eval(input)\n')
    git(upstream, 'add', '.')
    git(upstream, 'commit', '-qm', 'upstream')
  })

  afterEach(() => {
    rmSync(upstream, { recursive: true, force: true })
  })

  const pull = (): Step => ({ toolCalls: [exec(`git pull -q --ff-only "${upstream.replace(/\\/g, '/')}" main`)] })
  const done: Step = { text: '好了' }
  const security: SessionSecurity = { staticCheck: true, lightScan: false }

  test('只用 exec_command 拉代码：拉下来的文件不算这一轮的改动，模型停下时判定没改文件，不出完成卡、不跑完成检查和静态检查', async () => {
    const model = scriptedModel([pull(), done])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: 'echo 不该跑' }, [], undefined, security)
    const io = recordingIO()

    await expect(runTurn(session, { id: 't1', text: '拉一下最新代码' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(2)
    expect(readFileSync(join(project, 'lib.ts'), 'utf8')).toContain('eval(input)')
    expect(verifications(io)).toEqual([])
    expect(checkResults(io, '完成检查')).toEqual([])
    expect(checkResults(io, '静态检查')).toEqual([])
    expect(gateFeedback(session)).toEqual([])
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: null }])
    expect(lastTaskState(io)).toMatchObject({ status: 'completed', needsVerification: false })
    expect(await session.checkpointChanges('t1')).toEqual([])
  }, 30_000)

  test('拉了代码又改了文件：模型停下时只检查、审查智能体改的；撤销这一轮只退回它改的，拉下来的代码留着，记录重新载入后照样', async () => {
    const model = scriptedModel([pull(), { toolCalls: [read('app.ts')] }, { toolCalls: [replaceLines('app.ts', 'export const a = 2', 'export const a = 3')] }, done])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: 'echo ok' }, [], undefined, security)
    session.startTurn('t1', '拉代码再改')
    const io = recordingIO()

    await expect(runTurn(session, { id: 't1', text: '拉代码再改' }, io)).resolves.toBe('end_turn')
    session.endTurn('end_turn')
    expect(model.doStreamCalls).toHaveLength(4)
    // 上游带进来的 lib.ts 里有 eval，静态检查没查它
    expect(checkResults(io, '静态检查')).toEqual(['passed'])
    expect(checkResults(io, '完成检查')).toEqual(['passed'])
    expect(gateFeedback(session)).toEqual([])
    expect(verifications(io)).toEqual(['verified'])
    expect(turnOutcomes(io)).toEqual([{ finish: 'verified', stop: null }])
    const diff = await session.checkpointDiff('t1')
    expect(diff).toContain('+export const a = 3')
    expect(diff).toContain('-export const a = 2')
    expect(diff).not.toContain('lib.ts')
    expect(await session.checkpointChanges('t1')).toEqual([{ path: 'app.ts', change: 'modified' }])

    // 存盘再载入：基线跟着记录走，撤销时还认得哪些是拉下来的
    const reloaded = await makeSession(scriptedModel([]), undefined, [], undefined, security, undefined, {}, { record: session.toRecord() })
    expect(await reloaded.restoreCheckpoint('t1')).toEqual([{ path: 'app.ts', change: 'modified' }])
    // 退回到拉取后磁盘上的样子；全局开了 core.autocrlf 时拉下来的是 CRLF
    expect(readFileSync(join(project, 'app.ts'), 'utf8').replace(/\r\n/g, '\n')).toBe('export const a = 2\n')
    expect(readFileSync(join(project, 'lib.ts'), 'utf8')).toContain('eval(input)')
    // 工作区和拉下来的提交一致，不会留下一堆把上游改动反着撤掉的改动
    expect(git(project, 'status', '--porcelain')).toBe('')
  }, 30_000)

  test('没挪 HEAD 的 git 命令照旧：用命令改的文件仍算这一轮的改动，模型停下时跑完成检查', async () => {
    const model = scriptedModel([{ toolCalls: [exec('git checkout -q -b topic && echo "export const b = 1" > b.ts')] }, done])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: 'echo ok' })
    const io = recordingIO()

    await expect(runTurn(session, { id: 't1', text: '开个分支写 b.ts' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(2)
    expect(checkResults(io, '完成检查')).toEqual(['passed'])
    expect(verifications(io)).toEqual(['verified'])
    expect(turnOutcomes(io)).toEqual([{ finish: 'verified', stop: null }])
    expect(await session.checkpointChanges('t1')).toEqual([{ path: 'b.ts', change: 'added' }])
  }, 30_000)
})
