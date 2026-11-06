import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { Checkpoints } from '../src/checkpoint.js'
import { findBash, findRipgrep } from '../src/environment.js'
import type { RulePack, SessionChecks } from '../src/protocol.js'
import { runTurn, type TurnIO } from '../src/session/loop.js'
import { buildSystemPrompt } from '../src/session/prompt.js'
import { Session } from '../src/session/session.js'

type Step = { toolCalls: Array<{ name: string; input: unknown }> } | { text: string }
type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>
type StreamPart = StreamResult['stream'] extends ReadableStream<infer Part> ? Part : never

const usage = {
  inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
}

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
                { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage },
              ]
            : [
                { type: 'stream-start' as const, warnings: [] },
                ...step.toolCalls.map((call, callIndex) => ({
                  type: 'tool-call' as const,
                  toolCallId: `call-${index}-${callIndex}`,
                  toolName: call.name,
                  input: JSON.stringify(call.input),
                })),
                { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage },
              ],
      }),
    })),
  })
}

function recordingIO(permissionChoice: string | null = 'allow_once'): TurnIO & {
  updates: SessionUpdate[]
  permissionRequests: number
} {
  const io = {
    updates: [] as SessionUpdate[],
    permissionRequests: 0,
    update: async (update: SessionUpdate) => {
      io.updates.push(update)
    },
    requestPermission: async () => {
      io.permissionRequests++
      return permissionChoice
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
) {
  const bashPath = await findBash()
  const rules = review ? { packs: review.packs, review: true } : NO_RULES
  return new Session({
    cwd: project,
    config: {
      model: { endpoint: { protocol: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', apiKey: 'k' }, modelId: 'mock', contextWindow: 100_000 },
      reviewModel: null,
      checks,
      readOnlyPaths,
      rules,
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
