import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { Checkpoints } from '../src/checkpoint.js'
import { findBash, findRipgrep } from '../src/environment.js'
import type { RulePack, SessionChecks, SessionLimits, SessionSecurity } from '../src/protocol.js'
import { runTurn, type TurnIO } from '../src/session/loop.js'
import { buildSystemPrompt } from '../src/session/prompt.js'
import { Session } from '../src/session/session.js'
import type { ModelCallUsage } from '../src/usage/log.js'

// inputTokens 是这次调用报给 Diffra 的输入 token 数，默认 1000
type Step = ({ toolCalls: Array<{ name: string; input: unknown }> } | { text: string }) & { inputTokens?: number }
type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>
type StreamPart = StreamResult['stream'] extends ReadableStream<infer Part> ? Part : never

const usageOf = (inputTokens = 1000) => ({
  inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
})

// 按剧本一步一步返回：每次模型调用对应数组里的一项
function scriptedModel(steps: Step[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: steps.map((step, index) => ({
      stream: simulateReadableStream<StreamPart>({
        chunks:
          'text' in step
            ? [
                { type: 'stream-start' as const, warnings: [] },
                { type: 'text-start' as const, id: 't' },
                { type: 'text-delta' as const, id: 't', delta: step.text },
                { type: 'text-end' as const, id: 't' },
                { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage: usageOf(step.inputTokens) },
              ]
            : [
                { type: 'stream-start' as const, warnings: [] },
                ...step.toolCalls.map((call, callIndex) => ({
                  type: 'tool-call' as const,
                  toolCallId: `call-${index}-${callIndex}`,
                  toolName: call.name,
                  input: JSON.stringify(call.input),
                })),
                { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage: usageOf(step.inputTokens) },
              ],
      }),
    })),
  })
}

function recordingIO(permissionChoice: string | null = 'allow_once'): TurnIO & {
  updates: SessionUpdate[]
  permissionRequests: number
  usage: ModelCallUsage[]
} {
  const io = {
    updates: [] as SessionUpdate[],
    permissionRequests: 0,
    usage: [] as ModelCallUsage[],
    update: async (update: SessionUpdate) => {
      io.updates.push(update)
    },
    requestPermission: async () => {
      io.permissionRequests++
      return permissionChoice
    },
    recordUsage: async (call: ModelCallUsage) => {
      io.usage.push(call)
    },
  }
  return io
}

let project: string
let checkpointDir: string

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'diffra-loop-'))
  checkpointDir = mkdtempSync(join(tmpdir(), 'diffra-loop-cp-'))
})

afterEach(() => {
  rmSync(project, { recursive: true, force: true })
  rmSync(checkpointDir, { recursive: true, force: true })
})

const NO_RULES = { packs: [], review: false }

async function makeSession(
  model: MockLanguageModelV4,
  checks: SessionChecks = { afterEdit: null, beforeFinish: null },
  readOnlyPaths: string[] = [],
  review?: { packs: RulePack[]; model: MockLanguageModelV4 },
  security: SessionSecurity = { staticCheck: false, lightScan: false },
  limits: SessionLimits = { compactAtPercent: 70, maxSteps: 100 },
) {
  const bashPath = await findBash()
  const rules = review ? { packs: review.packs, review: true } : NO_RULES
  return new Session({
    cwd: project,
    config: {
      model: { endpoint: { protocol: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', apiKey: 'k' }, modelId: 'mock', contextWindow: 100_000, provider: null },
      reviewModel: null,
      checks,
      readOnlyPaths,
      rules,
      permissionMode: 'ask',
      security,
      limits,
      checkpointDir,
    },
    environment: { bashPath, rgPath: await findRipgrep() },
    checkpoints: await Checkpoints.open(checkpointDir, project, readOnlyPaths),
    rulePacks: rules.packs,
    systemPrompt: await buildSystemPrompt(project, bashPath, { checks, readOnlyPaths, rules }, rules.packs),
    model,
    reviewModel: review?.model,
  })
}

function toolUpdates(io: { updates: SessionUpdate[] }, status: 'completed' | 'failed') {
  return io.updates.filter((update) => update.sessionUpdate === 'tool_call_update' && update.status === status)
}

describe('主循环', () => {
  test('读 → 改错 → 快速检查失败 → 改对 → finish 检查通过', async () => {
    writeFileSync(join(project, 'a.txt'), 'value = broken\n')
    const check = 'grep -q "value = fixed" a.txt'
    const model = scriptedModel([
      { toolCalls: [{ name: 'read_file', input: { path: 'a.txt' } }] },
      { toolCalls: [{ name: 'edit_file', input: { path: 'a.txt', old_string: 'broken', new_string: 'still broken' } }] },
      { toolCalls: [{ name: 'edit_file', input: { path: 'a.txt', old_string: 'still broken', new_string: 'fixed' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '修好了' } }] },
    ])
    const session = await makeSession(model, { afterEdit: check, beforeFinish: null })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '修复 a.txt' }, io)).resolves.toBe('end_turn')
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('value = fixed\n')
    // 第一次快速检查失败后，失败输出作为用户消息交给了模型
    expect(session.messages.some((message) => message.role === 'user' && String(message.content).includes('failed after your edits'))).toBe(true)
    expect(toolUpdates(io, 'failed')).toHaveLength(1)
    // 两次编辑都带 diff
    expect(io.updates.filter((update) => update.sessionUpdate === 'tool_call_update' && update.content?.[0]?.type === 'diff')).toHaveLength(2)
    expect(model.doStreamCalls).toHaveLength(4)
    // 「完成」卡片在完成检查之后才出现
    const finishCheckIndex = io.updates.findIndex((update) => update.sessionUpdate === 'tool_call' && update.title.startsWith('完成检查'))
    const finishIndex = io.updates.findIndex((update) => update.sessionUpdate === 'tool_call' && update.title === '完成')
    expect(finishCheckIndex).toBeGreaterThanOrEqual(0)
    expect(finishIndex).toBeGreaterThan(finishCheckIndex)
    // 系统提示词里写明了会自动跑的检查命令
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain('Do not run it yourself')

    // 撤销这一轮：文件回到开始前
    expect(await session.checkpointChanges('turn-1')).toEqual([{ path: 'a.txt', change: 'modified' }])
    await session.restoreCheckpoint('turn-1')
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('value = broken\n')
  })

  test('finish 检查不通过时打回，改好后再 finish', async () => {
    writeFileSync(join(project, 'a.txt'), 'x\n')
    const model = scriptedModel([
      { toolCalls: [{ name: 'edit_file', input: { path: 'new.txt', old_string: '', new_string: 'draft\n' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '完成' } }] },
      { toolCalls: [{ name: 'read_file', input: { path: 'new.txt' } }] },
      { toolCalls: [{ name: 'edit_file', input: { path: 'new.txt', old_string: 'draft', new_string: 'final' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '完成' } }] },
    ])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: 'grep -q final new.txt' })
    await expect(runTurn(session, { id: 't', text: '写 new.txt' }, recordingIO())).resolves.toBe('end_turn')
    expect(readFileSync(join(project, 'new.txt'), 'utf8')).toBe('final\n')
    expect(model.doStreamCalls).toHaveLength(5)
  })

  test('改了文件却没调 finish 时被拉回', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'edit_file', input: { path: 'b.txt', old_string: '', new_string: 'b\n' } }] },
      { text: '改好了' },
      { toolCalls: [{ name: 'finish', input: { summary: '完成' } }] },
    ])
    const session = await makeSession(model)
    const io = recordingIO()
    await expect(runTurn(session, { id: 't', text: '写 b.txt' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(3)
    // 没配检查命令：finish 照样通过，但标注未经验证
    const finish = io.updates.findLast((update) => update.sessionUpdate === 'tool_call' && update.title === '完成')
    expect(finish).toMatchObject({ status: 'completed' })
    expect(JSON.stringify(finish)).toContain('未经自动验证')
  })

  test('只回答问题、不改文件时不需要 finish', async () => {
    const model = scriptedModel([{ text: '这个项目是做什么的：……' }])
    const io = recordingIO()
    await expect(runTurn(await makeSession(model), { id: 't', text: '介绍一下' }, io)).resolves.toBe('end_turn')
    expect(io.updates.some((update) => update.sessionUpdate === 'agent_message_chunk')).toBe(true)
  })

  test('需要确认的命令被拒绝后，模型收到拒绝结果，文件没被写', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'run_command', input: { command: 'echo hi > out.txt' } }] },
      { text: '好的，不执行了' },
    ])
    const io = recordingIO('reject')
    await expect(runTurn(await makeSession(model), { id: 't', text: '写文件' }, io)).resolves.toBe('end_turn')
    expect(io.permissionRequests).toBe(1)
    expect(() => readFileSync(join(project, 'out.txt'))).toThrow()
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('rejected this command')
  })

  test('危险命令直接拦下，不弹确认', async () => {
    const model = scriptedModel([{ toolCalls: [{ name: 'run_command', input: { command: 'rm -rf /' } }] }, { text: '好' }])
    const io = recordingIO('allow_once')
    await runTurn(await makeSession(model), { id: 't', text: '清理' }, io)
    expect(io.permissionRequests).toBe(0)
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('blocked by Diffra')
  })

  test('允许的命令照常执行，输出返回给模型', async () => {
    const model = scriptedModel([{ toolCalls: [{ name: 'run_command', input: { command: 'echo from-bash' } }] }, { text: '好' }])
    const io = recordingIO()
    await runTurn(await makeSession(model), { id: 't', text: '跑命令' }, io)
    expect(io.permissionRequests).toBe(0)
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('from-bash')
  })

  test('参数不合法的工具调用返回错误，每个调用都有且只有一个结果', async () => {
    const model = scriptedModel([{ toolCalls: [{ name: 'read_file', input: {} }] }, { text: '好' }])
    const session = await makeSession(model)
    await runTurn(session, { id: 't', text: '读' }, recordingIO())
    const results = session.messages.flatMap((message) =>
      message.role === 'tool' ? message.content.filter((part) => part.type === 'tool-result') : [],
    )
    expect(results).toHaveLength(1)
    expect(JSON.stringify(results[0])).toMatch(/Invalid/)
  })

  test('停止时结束正在跑的命令并返回 cancelled', async () => {
    const model = scriptedModel([{ toolCalls: [{ name: 'run_command', input: { command: 'sleep 30' } }] }, { text: '不会走到这里' }])
    const session = await makeSession(model)
    const started = Date.now()
    const running = runTurn(session, { id: 't', text: '等' }, recordingIO())
    setTimeout(() => session.cancel(), 500)
    await expect(running).resolves.toBe('cancelled')
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(session.running).toBe(false)
  })
})

describe('系统提示词', () => {
  test('配了检查命令时告诉模型会自动跑、不用自己跑', async () => {
    const prompt = await buildSystemPrompt(project, null, { checks: { afterEdit: 'pnpm typecheck', beforeFinish: 'pnpm test' }, readOnlyPaths: [], rules: NO_RULES }, [])
    expect(prompt).toContain('automatically runs `pnpm typecheck`')
    expect(prompt).toContain('Do not run it yourself')
    expect(prompt).toContain('Diffra then runs `pnpm test`')
  })

  test('没配检查命令时要求模型自己验证', async () => {
    const prompt = await buildSystemPrompt(project, null, { checks: { afterEdit: null, beforeFinish: null }, readOnlyPaths: [], rules: NO_RULES }, [])
    expect(prompt).toContain('verify it, for example by running the relevant tests')
    expect(prompt).toContain('No project checks are configured')
  })

  test('读入项目根目录的 AGENTS.md', async () => {
    writeFileSync(join(project, 'AGENTS.md'), '用 pnpm，不要用 npm\n')
    const prompt = await buildSystemPrompt(project, null, { checks: { afterEdit: null, beforeFinish: null }, readOnlyPaths: [], rules: NO_RULES }, [])
    expect(prompt).toContain('--- AGENTS.md ---\n用 pnpm，不要用 npm')
  })
})

describe('系统提示词里的保护说明', () => {
  test('写明受保护文件和禁写目录', async () => {
    const prompt = await buildSystemPrompt(project, null, { checks: { afterEdit: null, beforeFinish: null }, readOnlyPaths: ['data', 'uploads'], rules: NO_RULES }, [])
    expect(prompt).toContain('Files that may contain secrets (.env')
    expect(prompt).toContain("Never modify anything under these paths, they hold the user's data: data, uploads")
  })
})

describe('系统提示词里的编码规范', () => {
  const pack: RulePack = {
    id: 'sample',
    name: '示例',
    languages: ['*'],
    source: '',
    license: '',
    rules: [{ id: 'GEN-ERR-1', level: 'required', section: null, text: '不吞异常。' }],
  }
  const checks = { afterEdit: null, beforeFinish: null }

  test('排在项目规则之后，写明优先级更低、只约束改动的代码', async () => {
    writeFileSync(join(project, 'AGENTS.md'), '项目规则\n')
    const prompt = await buildSystemPrompt(project, null, { checks, readOnlyPaths: [], rules: { packs: [pack], review: false } }, [pack])
    const rulesAt = prompt.indexOf('Coding rules')
    expect(rulesAt).toBeGreaterThan(prompt.indexOf('--- AGENTS.md ---'))
    expect(prompt.slice(rulesAt)).toContain("rank below the user's instructions and the project rules")
    expect(prompt.slice(rulesAt)).toContain('### 示例\n- GEN-ERR-1: 不吞异常。')
    expect(prompt).not.toContain('a reviewer checks your changes')
  })

  test('开了审查时告诉模型完成后会按规则审查；没有选中的包就不写这一段', async () => {
    const reviewed = await buildSystemPrompt(project, null, { checks, readOnlyPaths: [], rules: { packs: [pack], review: true } }, [pack])
    expect(reviewed).toContain('a reviewer checks your changes against these rules')
    const none = await buildSystemPrompt(project, null, { checks, readOnlyPaths: [], rules: { packs: [pack], review: true } }, [])
    expect(none).not.toContain('Coding rules')
  })
})

describe('完成前的规范审查', () => {
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
  const finishResults = (session: Session) =>
    session.messages
      .flatMap((message) => (message.role === 'tool' ? message.content : []))
      .filter((part) => part.type === 'tool-result' && part.toolName === 'finish')

  test('审查发现违规时打回；推荐级、不在本轮改动里的意见丢掉；改好后再审查通过', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'edit_file', input: { path: 'app.ts', old_string: '', new_string: 'try {\n  run()\n} catch {}\n' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '加了 run 调用' } }] },
      { toolCalls: [{ name: 'read_file', input: { path: 'app.ts' } }] },
      { toolCalls: [{ name: 'edit_file', input: { path: 'app.ts', old_string: '} catch {}', new_string: '} catch (error) {\n  log(error)\n  throw error\n}' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '异常记日志后抛出' } }] },
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
    expect(reviewer.doStreamCalls).toHaveLength(2)
    // 每次模型调用都记了用量，审查调用记成 reviewer
    expect(io.usage.map((call) => call.role)).toEqual(['coder', 'coder', 'reviewer', 'coder', 'coder', 'coder', 'reviewer'])
    expect(io.usage[2]).toMatchObject({ modelId: 'mock', provider: null, usage: { inputTokens: 1000, outputTokens: 10 } })
    const [first, second] = finishResults(session).map((part) => JSON.stringify(part))
    expect(first).toContain('GEN-ERR-1 at app.ts:3')
    expect(first).not.toContain('GEN-NAME-4')
    expect(first).not.toContain('other.ts')
    expect(first).not.toContain('app.ts:9')
    expect(second).toContain('Done.')
    // 审查模型看到带新文件行号的 diff、只含强制级的规则，第二次还看到作者的说明
    const reviewRequest = JSON.stringify(reviewer.doStreamCalls[0]?.prompt)
    expect(reviewRequest).toContain('=== app.ts')
    expect(reviewRequest).toContain('    3 + } catch {}')
    expect(reviewRequest).toContain('GEN-ERR-1: 不吞异常。')
    expect(reviewRequest).not.toContain('GEN-NAME-4')
    expect(JSON.stringify(reviewer.doStreamCalls[1]?.prompt)).toContain('异常记日志后抛出')
    // 界面上：两张审查卡片，第一张失败，最后的「完成」是通过的
    const reviewCards = io.updates.filter((update) => update.sessionUpdate === 'tool_call' && update.title === '规范审查')
    expect(reviewCards).toHaveLength(2)
    expect(toolUpdates(io, 'failed').some((update) => JSON.stringify(update).includes('catch 块是空的'))).toBe(true)
    expect(io.updates.findLast((update) => update.sessionUpdate === 'tool_call' && update.title === '完成')).toMatchObject({ status: 'completed' })
  })

  test('评审模型出错时不拦截完成，卡片上说明', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'edit_file', input: { path: 'app.ts', old_string: '', new_string: 'run()\n' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '完成' } }] },
    ])
    const reviewer = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error('reviewer down')
      },
    })
    const session = await makeSession(model, undefined, [], { packs: [pack], model: reviewer })
    const io = recordingIO()
    await expect(runTurn(session, { id: 't', text: '调用 run' }, io)).resolves.toBe('end_turn')
    expect(JSON.stringify(toolUpdates(io, 'failed'))).toContain('审查没有完成，这次不拦截')
    expect(io.updates.findLast((update) => update.sessionUpdate === 'tool_call' && update.title === '完成')).toMatchObject({ status: 'completed' })
  })

  test('这一轮只改了非代码文件时不审查', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'edit_file', input: { path: 'README.md', old_string: '', new_string: '# 说明\n' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '写了说明' } }] },
    ])
    const reviewer = scriptedModel([{ text: 'GEN-ERR-1 | README.md:1 | x' }])
    const session = await makeSession(model, undefined, [], { packs: [pack], model: reviewer })
    const io = recordingIO()
    await expect(runTurn(session, { id: 't', text: '写说明' }, io)).resolves.toBe('end_turn')
    expect(reviewer.doStreamCalls).toHaveLength(0)
    expect(io.updates.some((update) => update.sessionUpdate === 'tool_call' && update.title === '规范审查')).toBe(false)
  })
})

describe('上下文分项', () => {
  test('usage_update 带各部分的估算，合计等于模型返回的输入 token 数', async () => {
    const session = await makeSession(scriptedModel([{ text: '好的' }]))
    const io = recordingIO()
    await runTurn(session, { id: 't', text: '介绍一下项目' }, io)
    const usage = io.updates.find((update) => update.sessionUpdate === 'usage_update')
    const breakdown = (usage as { _meta?: { diffra?: Record<string, number> } } | undefined)?._meta?.diffra
    expect(breakdown).toBeDefined()
    const sum = Object.values(breakdown ?? {}).reduce((total, value) => total + value, 0)
    expect(Math.abs(sum - 1000)).toBeLessThanOrEqual(2)
    expect(breakdown?.tools).toBeGreaterThan(0)
    expect(breakdown?.system).toBeGreaterThan(0)
  })
})

describe('任务进行中读改动', () => {
  // 界面在一轮刚开始时就会来要 diff，这时快照可能还没打好
  test('这一轮的快照还没打好时返回空 diff；不在进行中的轮次没有快照照样报错', async () => {
    const session = await makeSession(scriptedModel([]))
    session.startTurn('t1', '改点东西')
    session.activeTurn = new AbortController()
    await expect(session.checkpointDiff('t1')).resolves.toBe('')
    session.activeTurn = null
    await expect(session.checkpointDiff('t1')).rejects.toThrow('没有检查点')
  })
})

describe('完成前的静态安全检查', () => {
  const securityCards = (io: { updates: SessionUpdate[] }) =>
    io.updates.filter((update) => update.sessionUpdate === 'tool_call' && update.title === '安全检查')

  test('新增的代码有高危写法时打回，改好后通过；没改代码的轮次不检查', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'edit_file', input: { path: 'calc.ts', old_string: '', new_string: 'export const calc = (input: string) => eval(input)\n' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '加了计算' } }] },
      { toolCalls: [{ name: 'read_file', input: { path: 'calc.ts' } }] },
      { toolCalls: [{ name: 'edit_file', input: { path: 'calc.ts', old_string: 'eval(input)', new_string: 'Number(input)' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '改成 Number' } }] },
      { text: '只是回答问题' },
    ])
    const session = await makeSession(model, undefined, [], undefined, { staticCheck: true, lightScan: false })
    const io = recordingIO()
    await expect(runTurn(session, { id: 't1', text: '加一个计算函数' }, io)).resolves.toBe('end_turn')

    const finishes = session.messages
      .flatMap((message) => (message.role === 'tool' ? message.content : []))
      .filter((part) => part.type === 'tool-result' && part.toolName === 'finish')
      .map((part) => JSON.stringify(part))
    expect(finishes[0]).toContain('SEC-INJ-2 at calc.ts:1')
    expect(finishes[0]).toContain('diffra-allow')
    expect(finishes[1]).toContain('Done.')
    const results = io.updates.filter(
      (update) => update.sessionUpdate === 'tool_call_update' && securityCards(io).some((card) => card.sessionUpdate === 'tool_call' && card.toolCallId === update.toolCallId),
    )
    expect(results.map((update) => (update.sessionUpdate === 'tool_call_update' ? update.status : null))).toEqual(['failed', 'completed'])
    expect(JSON.stringify(results[0])).toContain('高危  SEC-INJ-2  calc.ts:1')
    expect(JSON.stringify(results[1])).toContain('没有发现常见的高危写法')

    // 下一轮只回答问题，不改文件，不跑安全检查
    const second = recordingIO()
    await runTurn(session, { id: 't2', text: '解释一下' }, second)
    expect(securityCards(second)).toHaveLength(0)
  })

  test('写了带理由的放行注释就不拦，卡片上列出放行的地方', async () => {
    const code = '// diffra-allow SEC-INJ-2: 输入来自内部配置，不来自用户\nexport const calc = (input: string) => eval(input)\n'
    const model = scriptedModel([
      { toolCalls: [{ name: 'edit_file', input: { path: 'calc.ts', old_string: '', new_string: code } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '加了计算，eval 已说明' } }] },
    ])
    const session = await makeSession(model, undefined, [], undefined, { staticCheck: true, lightScan: false })
    const io = recordingIO()
    await runTurn(session, { id: 't1', text: '加一个计算函数' }, io)
    expect(JSON.stringify(toolUpdates(io, 'completed'))).toContain('已放行  SEC-INJ-2  calc.ts:2')
    expect(io.updates.findLast((update) => update.sessionUpdate === 'tool_call' && update.title === '完成')).toMatchObject({ status: 'completed' })
  })
})

describe('完成前的轻量安全扫描', () => {
  const scanCards = (io: { updates: SessionUpdate[] }) =>
    io.updates.filter((update) => update.sessionUpdate === 'tool_call' && update.title === '安全扫描')

  test('模型发现高危问题时打回，改好后再扫描通过；请求里带着改动所在的完整文件', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'edit_file', input: { path: 'files.ts', old_string: '', new_string: 'export const read = (req) => fs.readFileSync(path.join(UPLOAD, req.query.name))\n' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '加了读文件接口' } }] },
      { toolCalls: [{ name: 'read_file', input: { path: 'files.ts' } }] },
      { toolCalls: [{ name: 'edit_file', input: { path: 'files.ts', old_string: 'req.query.name', new_string: 'safeName(req.query.name)' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '文件名限制在上传目录内' } }] },
    ])
    const reviewer = scriptedModel([{ text: 'high | SEC-INJ-4 | files.ts:1 | 文件名来自请求参数，可以用 ../ 读到上传目录外的文件' }, { text: 'NO_FINDINGS' }])
    const session = await makeSession(model, undefined, [], { packs: [], model: reviewer }, { staticCheck: true, lightScan: true })
    const io = recordingIO()
    await expect(runTurn(session, { id: 't1', text: '加一个读文件接口' }, io)).resolves.toBe('end_turn')

    expect(reviewer.doStreamCalls).toHaveLength(2)
    const request = JSON.stringify(reviewer.doStreamCalls[0]?.prompt)
    expect(request).toContain('=== files.ts')
    expect(request).toContain('Files touched by the change')
    expect(JSON.stringify(reviewer.doStreamCalls[1]?.prompt)).toContain('文件名限制在上传目录内')
    expect(scanCards(io)).toHaveLength(2)
    expect(JSON.stringify(toolUpdates(io, 'failed'))).toContain('高危  SEC-INJ-4  files.ts:1')
    expect(io.usage.filter((call) => call.role === 'reviewer')).toHaveLength(2)
    expect(io.updates.findLast((update) => update.sessionUpdate === 'tool_call' && update.title === '完成')).toMatchObject({ status: 'completed' })
  })

  test('静态检查已经打回时不调用模型扫描', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'edit_file', input: { path: 'calc.ts', old_string: '', new_string: 'export const calc = (input: string) => eval(input)\n' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '加了计算' } }] },
      { toolCalls: [{ name: 'edit_file', input: { path: 'calc.ts', old_string: 'eval(input)', new_string: 'Number(input)' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '改成 Number' } }] },
    ])
    const reviewer = scriptedModel([{ text: 'NO_FINDINGS' }])
    const session = await makeSession(model, undefined, [], { packs: [], model: reviewer }, { staticCheck: true, lightScan: true })
    const io = recordingIO()
    await runTurn(session, { id: 't1', text: '加一个计算函数' }, io)
    expect(reviewer.doStreamCalls).toHaveLength(1)
    expect(scanCards(io)).toHaveLength(1)
  })
})

describe('上下文压缩', () => {
  // 每个文件约 18000 字，读出来的输出足够大，可以被省略
  const writeBigFiles = (count: number) => {
    for (let index = 1; index <= count; index++) {
      writeFileSync(join(project, `f${index}.txt`), `${Array.from({ length: 300 }, (_, line) => `file ${index} line ${line} ${'x'.repeat(40)}`).join('\n')}\n`)
    }
  }
  const reads = (count: number, inputTokens: (index: number) => number): Step[] =>
    Array.from({ length: count }, (_, index) => ({ toolCalls: [{ name: 'read_file', input: { path: `f${index + 1}.txt` } }], inputTokens: inputTokens(index) }))
  // 输出都很短、省不出地方的步骤
  const searches = (count: number, inputTokens: (index: number) => number): Step[] =>
    Array.from({ length: count }, (_, index) => ({ toolCalls: [{ name: 'search', input: { pattern: `nothing-${index}` } }], inputTokens: inputTokens(index) }))
  const compactionCards = (io: { updates: SessionUpdate[] }) =>
    io.updates.filter((update) => update.sessionUpdate === 'tool_call' && update.title === '上下文压缩')
  const cardText = (io: { updates: SessionUpdate[] }) =>
    io.updates
      .filter((update) => update.sessionUpdate === 'tool_call_update')
      .flatMap((update) => (update.content ?? []).flatMap((item) => (item.type === 'content' && item.content.type === 'text' ? [item.content.text] : [])))
      .join('\n')
  const notices = (io: { updates: SessionUpdate[] }) => io.updates.flatMap((update) => (update.sessionUpdate === 'notice' ? [update.title] : []))

  test('超过触发点时先省略较早的工具输出，够了就不调模型写摘要', async () => {
    writeBigFiles(6)
    // 窗口 10 万、触发点 70%：第 6 次调用报 7.5 万，加上刚读进来的文件，下一次调用前估算超过 7 万
    const model = scriptedModel([...reads(6, (index) => (index === 5 ? 75_000 : 1000)), { text: '看完了' }])
    const session = await makeSession(model)
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '读这些文件' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(7)
    expect(compactionCards(io)).toHaveLength(1)
    expect(cardText(io)).toContain('省略了 2 个较早的工具输出')
    expect(session.compaction).toBeNull()
    // 最早两步的输出换成了占位，最近四步原样保留
    const lastPrompt = JSON.stringify(model.doStreamCalls[6]?.prompt)
    expect(lastPrompt.match(/Output omitted by Diffra/g)).toHaveLength(2)
    expect(lastPrompt).not.toContain('file 1 line 0')
    expect(lastPrompt).toContain('file 3 line 0')
    expect(lastPrompt).toContain('file 6 line 0')
  })

  test('省略不够时写摘要：之后发的是摘要加最近四步，提问原文保留；存档恢复后一样；重新生成到压缩点之前时摘要作废', async () => {
    const model = scriptedModel([...searches(6, (index) => (index === 5 ? 90_000 : 1000)), { text: '摘要：搜了六次都没找到。' }, { text: '没找到' }])
    const session = await makeSession(model)
    const io = recordingIO()
    session.startTurn('turn-1', '找一找 TODO 在哪')

    await expect(runTurn(session, { id: 'turn-1', text: '找一找 TODO 在哪' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(8)
    // 第 7 次调用是写摘要：带着压缩点之前的对话和写摘要的要求，不让调工具
    const summaryCall = model.doStreamCalls[6]
    expect(JSON.stringify(summaryCall?.prompt)).toContain('too long for the context window')
    expect(summaryCall?.toolChoice).toEqual({ type: 'none' })
    expect(io.usage).toHaveLength(8)
    expect(cardText(io)).toContain('摘要：搜了六次都没找到。')

    const compaction = session.compaction
    expect(compaction).not.toBeNull()
    const lastPrompt = model.doStreamCalls[7]?.prompt ?? []
    const promptText = JSON.stringify(lastPrompt)
    expect(promptText).toContain('Earlier parts of this conversation were compacted')
    expect(promptText).toContain('摘要：搜了六次都没找到。')
    expect(promptText).toContain('找一找 TODO 在哪')
    expect(promptText).not.toContain('nothing-0')
    expect(promptText).toContain('nothing-5')
    expect(lastPrompt.filter((message) => message.role === 'assistant')).toHaveLength(4)
    // 原文都还在
    expect(JSON.stringify(session.messages)).toContain('nothing-0')

    const restored = new Session({
      cwd: project,
      config: session.config,
      environment: session.environment,
      checkpoints: null,
      rulePacks: [],
      systemPrompt: session.systemPrompt,
      model,
      record: JSON.parse(JSON.stringify(session.toRecord())),
    })
    expect(restored.compaction).toEqual(compaction)
    expect(restored.contextMessages()).toEqual(JSON.parse(JSON.stringify(session.contextMessages())))

    await session.rewind('turn-1')
    expect(session.compaction).toBeNull()
  })

  test('写摘要失败时停下并说明', async () => {
    const model = scriptedModel([...searches(6, (index) => (index === 5 ? 90_000 : 1000)), { text: '' }])
    const session = await makeSession(model)
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '找一找' }, io)).resolves.toBe('max_tokens')
    expect(notices(io)).toEqual(['上下文压缩失败，已停止'])
    expect(cardText(io)).toContain('压缩失败')
    expect(session.compaction).toBeNull()
  })

  test('最近几步本身就太大、没法压时停下', async () => {
    writeBigFiles(1)
    const model = scriptedModel([{ toolCalls: [{ name: 'read_file', input: { path: 'f1.txt' } }], inputTokens: 97_000 }, { text: '不会走到这里' }])
    const session = await makeSession(model)
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '读文件' }, io)).resolves.toBe('max_tokens')
    expect(model.doStreamCalls).toHaveLength(1)
    expect(notices(io)).toEqual(['上下文压缩后仍然太大，已停止'])
  })

  test('触发点按设置来：设成 90% 时 7.5 万不压缩', async () => {
    writeBigFiles(6)
    const model = scriptedModel([...reads(6, (index) => (index === 5 ? 75_000 : 1000)), { text: '看完了' }])
    const session = await makeSession(model, undefined, undefined, undefined, undefined, { compactAtPercent: 90, maxSteps: 100 })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '读这些文件' }, io)).resolves.toBe('end_turn')
    expect(compactionCards(io)).toHaveLength(0)
  })
})

describe('卡死检测和步数上限', () => {
  const readB: Step = { toolCalls: [{ name: 'read_file', input: { path: 'b.txt' } }] }
  const notices = (io: { updates: SessionUpdate[] }) => io.updates.flatMap((update) => (update.sessionUpdate === 'notice' ? [update.title] : []))

  test('同一个调用连续三次结果一样时先提醒，提醒后再重复就停下', async () => {
    writeFileSync(join(project, 'b.txt'), 'b\n')
    const model = scriptedModel([readB, readB, readB, readB, readB, readB, { text: '不会走到这里' }])
    const session = await makeSession(model)
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '看看 b.txt' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(6)
    // 第三次之后提醒了模型，第四次请求里带着提醒
    expect(JSON.stringify(model.doStreamCalls[3]?.prompt)).toContain('same call 3 times')
    expect(notices(io)).toEqual(['智能体在重复同样的操作，已停止'])
  })

  test('中间有成功的编辑时重新计数', async () => {
    writeFileSync(join(project, 'a.txt'), 'one\n')
    writeFileSync(join(project, 'b.txt'), 'b\n')
    const model = scriptedModel([
      { toolCalls: [{ name: 'read_file', input: { path: 'a.txt' } }] },
      readB,
      readB,
      { toolCalls: [{ name: 'edit_file', input: { path: 'a.txt', old_string: 'one', new_string: 'two' } }] },
      readB,
      readB,
      { toolCalls: [{ name: 'finish', input: { summary: '好了' } }] },
    ])
    const session = await makeSession(model)
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '改 a.txt' }, io)).resolves.toBe('end_turn')
    expect(JSON.stringify(session.messages)).not.toContain('same call 3 times')
    expect(notices(io)).toEqual([])
  })

  test('步数上限按设置来，到了就停下并说明怎么继续', async () => {
    for (const name of ['a', 'b', 'c', 'd']) writeFileSync(join(project, `${name}.txt`), `${name}\n`)
    const steps: Step[] = ['a', 'b', 'c', 'd'].map((name) => ({ toolCalls: [{ name: 'read_file', input: { path: `${name}.txt` } }] }))
    const model = scriptedModel([...steps, { text: '不会走到这里' }])
    const session = await makeSession(model, undefined, undefined, undefined, undefined, { compactAtPercent: 70, maxSteps: 3 })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '读文件' }, io)).resolves.toBe('max_turn_requests')
    expect(model.doStreamCalls).toHaveLength(3)
    expect(notices(io)).toEqual(['已达到单次任务的步数上限（3 步），已停止'])
  })
})
