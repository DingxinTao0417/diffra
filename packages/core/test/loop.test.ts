import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { Checkpoints } from '../src/checkpoint.js'
import { McpPool } from '../src/mcp.js'
import { findBash, findRipgrep } from '../src/environment.js'
import type { BrowserAction, BrowserActionResult, RulePack, SessionChecks, SessionLimits, SessionSecurity } from '../src/protocol.js'
import { normalizeUrl } from '../src/urls.js'
import { runTurn, type TurnIO } from '../src/session/loop.js'
import { formatPlan, runPlan } from '../src/session/plan.js'
import { buildSystemPrompt } from '../src/session/prompt.js'
import { IMAGE_CHARS, messagesChars, Session, type SessionOptions } from '../src/session/session.js'
import type { ModelCallUsage } from '../src/usage/log.js'
import { testMcpServer } from './mcp-fixture.js'

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
  limits: SessionLimits = { compactAtPercent: 70, maxSteps: 100, goalMaxRounds: 5 },
  // 规划、兜底角色的模拟模型；不给就是没配
  roles: { plan?: MockLanguageModelV4; fallback?: MockLanguageModelV4 } = {},
  extra: Partial<SessionOptions> = {},
) {
  const bashPath = await findBash()
  const rules = review ? { packs: review.packs, review: true } : NO_RULES
  const roleModel = (modelId: string, name: string) => ({
    endpoint: { protocol: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:1', apiKey: 'k' },
    modelId,
    contextWindow: 100_000,
    provider: { id: modelId, name },
  })
  return new Session({
    cwd: project,
    config: {
      model: { endpoint: { protocol: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', apiKey: 'k' }, modelId: 'mock', contextWindow: 100_000, provider: null },
      reviewModel: null,
      planModel: roles.plan ? roleModel('planner', '规划供应商') : null,
      fallbackModel: roles.fallback ? roleModel('fallback', '兜底供应商') : null,
      checks,
      readOnlyPaths,
      rules,
      permissionMode: 'ask',
      security,
      limits,
      plugins: [],
      checkpointDir,
    },
    environment: { bashPath, rgPath: await findRipgrep() },
    checkpoints: await Checkpoints.open(checkpointDir, project, readOnlyPaths),
    rulePacks: rules.packs,
    systemPrompt: await buildSystemPrompt(project, bashPath, { checks, readOnlyPaths, rules }, rules.packs),
    model,
    reviewModel: review?.model,
    planModel: roles.plan,
    fallbackModel: roles.fallback,
    ...extra,
  })
}

function toolUpdates(io: { updates: SessionUpdate[] }, status: 'completed' | 'failed') {
  return io.updates.filter((update) => update.sessionUpdate === 'tool_call_update' && update.status === status)
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
      await runTurn(session, { id: choice, text: '检查终端输出' }, { ...io, devServer: async (params) => {
        expect(params.action).toBe('terminal-read')
        reads++
        return { text: 'terminal result', url: null }
      } })
      expect(reads).toBe(choice === 'reject' ? 0 : 2)
      expect(io.permissionRequests).toBe(choice === 'allow_always' ? 1 : 2)
    }
  }, 30_000)

  test('verify_changes 不结束任务；之后继续命令并满足证据条件才完成', async () => {
    const requirement = { id: 'delivery', title: '执行后续交付步骤', commandIncludes: 'printf', outputIncludes: 'delivered' }
    const model = scriptedModel([
      { toolCalls: [{ name: 'task_progress', input: { action: 'define', requirements: [requirement] } }] },
      { toolCalls: [{ name: 'verify_changes', input: { summary: '中间验证' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '过早完成' } }] },
      { toolCalls: [{ name: 'run_command', input: { command: 'printf delivered' } }] },
      { toolCalls: [{ name: 'task_progress', input: { action: 'satisfy', id: 'delivery', receiptId: 'call-3-0' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '全部完成' } }] },
    ])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: 'true' })
    const io = recordingIO()
    expect(await runTurn(session, { id: 't', text: '完成多阶段交付' }, io)).toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(6)
    expect(session.taskState.status).toBe('completed')
    expect(session.taskState.requirements[0]?.receiptId).toBe('call-3-0')
    expect(JSON.stringify(session.messages)).toContain('Task is NOT complete')
    expect(io.updates.some((item) => item.sessionUpdate === 'tool_call' && item.title === '验证改动（不结束任务）')).toBe(true)
  }, 30_000)

  test('验证缓存匹配工作区指纹；后续编辑使缓存失效，取消不标记完成', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'edit_file', input: { path: 'cache.txt', old_string: '', new_string: 'one' } }] },
      { toolCalls: [{ name: 'verify_changes', input: { summary: '验证' } }] },
      { toolCalls: [{ name: 'verify_changes', input: { summary: '复用验证' } }] },
      { toolCalls: [{ name: 'edit_file', input: { path: 'cache.txt', old_string: 'one', new_string: 'two' } }] },
      { toolCalls: [{ name: 'verify_changes', input: { summary: '编辑后重新验证' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '完成' } }] },
    ])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: 'true' })
    const io = recordingIO()
    await runTurn(session, { id: 'cache', text: '测试验证缓存' }, io)
    expect(io.updates.filter((item) => item.sessionUpdate === 'tool_call' && item.title.startsWith('完成检查'))).toHaveLength(2)
    expect(session.taskState.status).toBe('completed')
    const cancelled = await makeSession(scriptedModel([{ toolCalls: [{ name: 'verify_changes', input: { summary: '验证期间取消' } }] }]), { afterEdit: null, beforeFinish: 'true' })
    const cancelIO = recordingIO()
    const originalUpdate = cancelIO.update
    cancelIO.update = async (update) => {
      await originalUpdate(update)
      if (update.sessionUpdate === 'tool_call' && update.title.startsWith('完成检查')) cancelled.cancel()
    }
    expect(await runTurn(cancelled, { id: 'cancel', text: '取消' }, cancelIO)).toBe('cancelled')
    expect(cancelled.taskState.status).toBe('cancelled')
  }, 30_000)

  test('发布任务没定义完整契约不能提前结束；暂停保留受阻状态', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'finish', input: { summary: '测试通过，稍后发布' } }] },
      { toolCalls: [{ name: 'pause_task', input: { status: 'waiting', reason: '等待 CI 完成' } }] },
    ])
    const session = await makeSession(model)
    await runTurn(session, { id: 't', text: '提交推送打包发布 0.1.2' }, recordingIO())
    expect(session.taskState.status).toBe('waiting')
    expect(session.taskState.contractRequired).toBe(true)
    expect(session.taskState.reason).toBe('等待 CI 完成')
    expect(JSON.stringify(session.messages)).toContain('commit, push, ci, publish')
  })

  test('暂停后恢复保留清单及执行证据，不能凭模型文字完成', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'task_progress', input: { action: 'define', requirements: [{ id: 'ci', title: 'CI 完成', commandIncludes: 'gh run view', outputIncludes: 'success' }] } }] },
      { toolCalls: [{ name: 'pause_task', input: { status: 'blocked', reason: '缺少凭据' } }] },
    ])
    const session = await makeSession(model)
    session.startTurn('t', '执行 CI')
    await runTurn(session, { id: 't', text: '执行 CI' }, recordingIO())
    session.endTurn('end_turn')
    const restored = await makeSession(scriptedModel([
      { toolCalls: [{ name: 'finish', input: { summary: '已完成' } }] },
      { toolCalls: [{ name: 'pause_task', input: { status: 'blocked', reason: '仍缺凭据' } }] },
    ]), undefined, [], undefined, undefined, undefined, {}, { record: session.toRecord() })
    expect(restored.taskState.requirements).toEqual(session.taskState.requirements)
    await runTurn(restored, { id: 'next', text: '继续' }, recordingIO())
    expect(restored.taskState.status).toBe('blocked')
    expect(restored.taskState.requirements[0]?.receiptId).toBeNull()
  })

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
  // Windows CI 上此集成测试启动多次 Git/Bash 子进程，保留全部断言并预留启动时间。
  }, 30_000)

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
    const session = await makeSession(model, undefined, undefined, undefined, undefined, { compactAtPercent: 90, maxSteps: 100, goalMaxRounds: 5 })
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
    const session = await makeSession(model, undefined, undefined, undefined, undefined, { compactAtPercent: 70, maxSteps: 3, goalMaxRounds: 5 })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '读文件' }, io)).resolves.toBe('max_turn_requests')
    expect(model.doStreamCalls).toHaveLength(3)
    expect(notices(io)).toEqual(['已达到单次任务的步数上限（3 步），已停止'])
  })
})

describe('兜底模型', () => {
  const notices = (io: { updates: SessionUpdate[] }) => io.updates.flatMap((update) => (update.sessionUpdate === 'notice' ? [update.title] : []))
  const finish = (summary: string): Step => ({ toolCalls: [{ name: 'finish', input: { summary } }] })

  test('快速检查连续 3 次失败时换兜底模型接着做；用量按兜底模型记，对话里交代了换人的原因', async () => {
    writeFileSync(join(project, 'a.txt'), 'value = broken\n')
    const coder = scriptedModel([
      { toolCalls: [{ name: 'read_file', input: { path: 'a.txt' } }] },
      { toolCalls: [{ name: 'edit_file', input: { path: 'a.txt', old_string: 'broken', new_string: 'try1' } }] },
      { toolCalls: [{ name: 'edit_file', input: { path: 'a.txt', old_string: 'try1', new_string: 'try2' } }] },
      { toolCalls: [{ name: 'edit_file', input: { path: 'a.txt', old_string: 'try2', new_string: 'try3' } }] },
    ])
    const fallback = scriptedModel([{ toolCalls: [{ name: 'edit_file', input: { path: 'a.txt', old_string: 'try3', new_string: 'fixed' } }] }, finish('改好了')])
    const session = await makeSession(coder, { afterEdit: 'grep -q "value = fixed" a.txt', beforeFinish: null }, [], undefined, undefined, undefined, { fallback })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '修复 a.txt' }, io)).resolves.toBe('end_turn')
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('value = fixed\n')
    expect(notices(io)).toEqual(['已换用兜底模型 兜底供应商 / fallback'])
    expect(coder.doStreamCalls).toHaveLength(4)
    expect(fallback.doStreamCalls).toHaveLength(2)
    expect(JSON.stringify(fallback.doStreamCalls[0]?.prompt)).toContain('A different model takes over')
    expect(io.usage.map((call) => call.modelId)).toEqual(['mock', 'mock', 'mock', 'mock', 'fallback', 'fallback'])
  })

  test('完成检查连续 3 次不过时换兜底模型', async () => {
    const coder = scriptedModel([
      { toolCalls: [{ name: 'edit_file', input: { path: 'new.txt', old_string: '', new_string: 'draft\n' } }] },
      finish('完成'),
      finish('完成'),
      finish('完成'),
    ])
    const fallback = scriptedModel([{ toolCalls: [{ name: 'edit_file', input: { path: 'new.txt', old_string: 'draft', new_string: 'final' } }] }, finish('改成 final 了')])
    const session = await makeSession(coder, { afterEdit: null, beforeFinish: 'grep -q final new.txt' }, [], undefined, undefined, undefined, { fallback })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '写 new.txt' }, io)).resolves.toBe('end_turn')
    expect(readFileSync(join(project, 'new.txt'), 'utf8')).toBe('final\n')
    expect(notices(io)).toEqual(['已换用兜底模型 兜底供应商 / fallback'])
  })

  test('卡死提醒后仍重复时换兜底模型；兜底模型也卡住就停下，每轮只换一次', async () => {
    writeFileSync(join(project, 'b.txt'), 'b\n')
    const readB: Step = { toolCalls: [{ name: 'read_file', input: { path: 'b.txt' } }] }
    const coder = scriptedModel([readB, readB, readB, readB, readB, readB])
    const fallback = scriptedModel([readB, readB, readB, readB, readB, readB, { text: '不会走到这里' }])
    const session = await makeSession(coder, undefined, [], undefined, undefined, undefined, { fallback })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '看看 b.txt' }, io)).resolves.toBe('end_turn')
    expect(coder.doStreamCalls).toHaveLength(6)
    expect(fallback.doStreamCalls).toHaveLength(6)
    expect(notices(io)).toEqual(['已换用兜底模型 兜底供应商 / fallback', '智能体在重复同样的操作，已停止'])
  })

  test('下一轮回到编码模型', async () => {
    writeFileSync(join(project, 'b.txt'), 'b\n')
    const readB: Step = { toolCalls: [{ name: 'read_file', input: { path: 'b.txt' } }] }
    const coder = scriptedModel([readB, readB, readB, readB, readB, readB, { text: '第二轮由编码模型回答' }])
    const fallback = scriptedModel([{ text: '兜底模型回答' }])
    const session = await makeSession(coder, undefined, [], undefined, undefined, undefined, { fallback })

    await expect(runTurn(session, { id: 'turn-1', text: '看看 b.txt' }, recordingIO())).resolves.toBe('end_turn')
    expect(fallback.doStreamCalls).toHaveLength(1)
    await expect(runTurn(session, { id: 'turn-2', text: '再说一遍' }, recordingIO())).resolves.toBe('end_turn')
    expect(coder.doStreamCalls).toHaveLength(7)
    expect(fallback.doStreamCalls).toHaveLength(1)
  })
})

describe('先出计划', () => {
  const plan = {
    understanding: '把 a.txt 里的 broken 改成 fixed',
    steps: [{ title: '改 a.txt', detail: '把 broken 换成 fixed\n改完跑一下检查', files: ['a.txt'] }],
    risks: ['b.txt 也引用了这个值，要不要一起改？'],
  }
  const planCards = (io: { updates: SessionUpdate[] }) =>
    io.updates.filter((update) => update.sessionUpdate === 'tool_call' && update.title === '计划')

  test('规划模型只读地看代码、交计划；改文件被拒，计划不进编码模型的对话，用量记成规划', async () => {
    writeFileSync(join(project, 'a.txt'), 'value = broken\n')
    const coder = scriptedModel([])
    const planner = scriptedModel([
      { toolCalls: [{ name: 'list_files', input: {} }] },
      { toolCalls: [{ name: 'read_file', input: { path: 'a.txt' } }] },
      { toolCalls: [{ name: 'edit_file', input: { path: 'a.txt', old_string: 'broken', new_string: 'fixed' } }] },
      { toolCalls: [{ name: 'submit_plan', input: plan }] },
    ])
    const session = await makeSession(coder, undefined, [], undefined, undefined, undefined, { plan: planner })
    const io = recordingIO()

    await expect(runPlan(session, { id: 'plan-1', text: '修复 a.txt' }, io)).resolves.toBe('end_turn')
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('value = broken\n')
    // 不在只读工具里的调用，AI SDK 直接答复模型这个工具不可用
    expect(JSON.stringify(planner.doStreamCalls[3]?.prompt)).toContain("unavailable tool 'edit_file'")
    expect(JSON.stringify(planner.doStreamCalls[0]?.prompt)).toContain('PLANNING MODE')
    expect(coder.doStreamCalls).toHaveLength(0)
    expect(session.messages).toEqual([])
    expect(io.usage.map((call) => [call.role, call.modelId])).toEqual(Array.from({ length: 4 }, () => ['planner', 'planner']))

    const card = planCards(io)[0]
    expect(card && card.sessionUpdate === 'tool_call' ? card.content : null).toEqual([{ type: 'content', content: { type: 'text', text: formatPlan(plan) } }])
    expect(formatPlan(plan)).toBe(
      ['把 a.txt 里的 broken 改成 fixed', '', '1. 改 a.txt', '   把 broken 换成 fixed', '   改完跑一下检查', '   涉及：a.txt', '', '风险和需要确认的问题：', '- b.txt 也引用了这个值，要不要一起改？'].join('\n'),
    )
  })

  test('上下文快满时要求直接交计划', async () => {
    const planner = scriptedModel([{ toolCalls: [{ name: 'search', input: { pattern: 'x' } }], inputTokens: 85_000 }, { toolCalls: [{ name: 'submit_plan', input: plan }] }])
    const session = await makeSession(scriptedModel([]), undefined, [], undefined, undefined, undefined, { plan: planner })

    await expect(runPlan(session, { id: 'plan-1', text: '修复 a.txt' }, recordingIO())).resolves.toBe('end_turn')
    expect(planner.doStreamCalls[0]?.toolChoice).toEqual({ type: 'auto' })
    expect(planner.doStreamCalls[1]?.toolChoice).toEqual({ type: 'tool', toolName: 'submit_plan' })
  })

  test('没配规划模型时用编码模型；看得到之前的对话', async () => {
    const coder = scriptedModel([{ toolCalls: [{ name: 'submit_plan', input: plan }] }])
    const session = await makeSession(coder)
    session.messages.push({ role: 'user', content: '之前说过：不要动 b.txt' }, { role: 'assistant', content: '好的' })
    const io = recordingIO()

    await expect(runPlan(session, { id: 'plan-1', text: '修复 a.txt' }, io)).resolves.toBe('end_turn')
    const prompt = JSON.stringify(coder.doStreamCalls[0]?.prompt)
    expect(prompt).toContain('不要动 b.txt')
    expect(prompt).toContain('修复 a.txt')
    expect(io.usage.map((call) => [call.role, call.modelId])).toEqual([['planner', 'mock']])
    expect(session.messages).toHaveLength(2)
  })
})

describe('目标模式', () => {
  const notices = (io: { updates: SessionUpdate[] }) => io.updates.flatMap((update) => (update.sessionUpdate === 'notice' ? [update.title] : []))
  const finish = (summary: string, goalMet: boolean): Step => ({ toolCalls: [{ name: 'finish', input: { summary, goal_met: goalMet } }] })

  test('没达成就自动开始下一轮，达成后结束；每轮都要过完成检查', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'edit_file', input: { path: 'a.txt', old_string: '', new_string: 'one\n' } }] },
      finish('还差 b.txt', false),
      { toolCalls: [{ name: 'edit_file', input: { path: 'b.txt', old_string: '', new_string: 'two\n' } }] },
      finish('都写好了', true),
    ])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: 'test -f a.txt' })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '写出 a.txt 和 b.txt' }, io, { goalMaxRounds: 3 })).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(4)
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain('Goal mode. Work toward the goal below on your own over up to 3 rounds')
    expect(JSON.stringify(model.doStreamCalls[2]?.prompt)).toContain('round 2 of 3')
    expect(notices(io)).toEqual(['目标模式第 2 轮', '目标已完成（用了 2 轮）'])
    // 两轮各跑了一次完成检查
    expect(io.updates.filter((update) => update.sessionUpdate === 'tool_call' && update.title.startsWith('完成检查'))).toHaveLength(2)
  })

  test('轮数用完还没达成就停下说明；只回文字时拉回来让它调 finish', async () => {
    const model = scriptedModel([{ text: '我想想' }, finish('第一轮做了一点', false), finish('第二轮还是没做完', false)])
    const session = await makeSession(model)
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '做完它' }, io, { goalMaxRounds: 2 })).resolves.toBe('end_turn')
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('call finish with goal_met')
    expect(notices(io)).toEqual(['目标模式第 2 轮', '目标模式已用完 2 轮，目标还没完成'])
  })

  test('不是目标模式时 finish 照常结束，不看 goal_met', async () => {
    const model = scriptedModel([finish('好了', false)])
    const session = await makeSession(model)
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '问个问题' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(1)
    expect(notices(io)).toEqual([])
  })
})

describe('MCP 工具', () => {
  let pool: McpPool
  beforeEach(() => {
    pool = new McpPool()
  })
  afterEach(async () => {
    await pool.closeAll()
  })

  const withMcp = (model: MockLanguageModelV4, servers = [testMcpServer()]) =>
    makeSession(model, undefined, [], undefined, undefined, undefined, {}, { mcpPool: pool, mcpServers: servers })
  const toolCallTitles = (io: { updates: SessionUpdate[] }) =>
    io.updates.flatMap((update) => (update.sessionUpdate === 'tool_call' ? [update.title] : []))

  test('MCP 工具和内置工具一起发给模型；声明只读的直接调，其他的先问，选了始终允许后本会话不再问', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'mcp__demo__echo', input: { text: 'hi' } }] },
      { toolCalls: [{ name: 'mcp__demo__write_note', input: { text: 'first' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '写好了' } }] },
      { toolCalls: [{ name: 'mcp__demo__write_note', input: { text: 'second' } }] },
      { text: '又写了一遍' },
    ])
    const session = await withMcp(model)
    const io = recordingIO('allow_always')

    await expect(runTurn(session, { id: 'turn-1', text: '记一下' }, io)).resolves.toBe('end_turn')
    const tools = model.doStreamCalls[0]?.tools?.map((item) => item.name) ?? []
    expect(tools).toEqual(expect.arrayContaining(['read_file', 'finish', 'mcp__demo__echo', 'mcp__demo__write_note']))
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('echo: hi')
    expect(io.permissionRequests).toBe(1)
    expect(readFileSync(join(project, 'note.txt'), 'utf8')).toBe('first\n')
    expect(toolCallTitles(io)).toEqual(['MCP demo · echo', 'MCP demo · write_note', '完成'])

    await runTurn(session, { id: 'turn-2', text: '再记一下' }, io)
    expect(io.permissionRequests).toBe(1)
    expect(readFileSync(join(project, 'note.txt'), 'utf8')).toBe('second\n')
    expect(session.usageBreakdown(1000).tools).toBeGreaterThan(0)
  })

  test('用户拒绝时不调，告诉模型别再试；完全放行模式不问；工具报错原样给模型', async () => {
    const rejected = scriptedModel([{ toolCalls: [{ name: 'mcp__demo__write_note', input: { text: 'x' } }] }, { text: '好吧' }])
    const io = recordingIO('reject')
    await runTurn(await withMcp(rejected), { id: 'turn-1', text: '记一下' }, io)
    expect(JSON.stringify(rejected.doStreamCalls[1]?.prompt)).toContain('The user rejected this tool call')
    expect(() => readFileSync(join(project, 'note.txt'))).toThrow()

    const full = scriptedModel([
      { toolCalls: [{ name: 'mcp__demo__write_note', input: { text: 'y' } }] },
      { toolCalls: [{ name: 'mcp__demo__fail', input: {} }] },
      { text: '完成' },
    ])
    const session = await withMcp(full)
    session.permissionMode = 'full'
    const fullIO = recordingIO('reject')
    await runTurn(session, { id: 'turn-1', text: '记一下' }, fullIO)
    expect(fullIO.permissionRequests).toBe(0)
    expect(readFileSync(join(project, 'note.txt'), 'utf8')).toBe('y\n')
    expect(JSON.stringify(full.doStreamCalls[2]?.prompt)).toContain('something broke')
    expect(toolUpdates(fullIO, 'failed')).toHaveLength(1)
  })

  test('连不上的服务器开始时提示一下，照常做', async () => {
    const model = scriptedModel([{ text: '好' }])
    const io = recordingIO()
    await runTurn(await withMcp(model, [{ name: 'broken', command: 'diffra-no-such-command', args: [], env: [] }]), { id: 'turn-1', text: '你好' }, io)
    const notices = io.updates.flatMap((update) => (update.sessionUpdate === 'notice' ? [update.title] : []))
    expect(notices).toEqual(['MCP 服务器「broken」不可用，这一轮不用它的工具'])
    expect(model.doStreamCalls).toHaveLength(1)
  })
})

describe('图片', () => {
  test('提问带图片时作为图片发给模型；估算上下文时每张图按固定字数算，不按 base64 长度', async () => {
    const model = scriptedModel([{ text: '好' }])
    const session = await makeSession(model)
    const data = 'A'.repeat(200_000)
    await runTurn(session, { id: 'turn-1', text: '看图', images: [{ mimeType: 'image/webp', data }] }, recordingIO())
    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt)
    expect(prompt).toContain('"mediaType":"image/webp"')
    expect(prompt).toContain('看图')
    const withImage = messagesChars(session.messages)
    const textOnly = messagesChars([{ role: 'user', content: '看图' }, ...session.messages.slice(1)])
    expect(withImage - textOnly).toBeGreaterThan(IMAGE_CHARS - 200)
    expect(withImage - textOnly).toBeLessThan(IMAGE_CHARS + 200)
  })
})

describe('内置浏览器工具', () => {
  // 假的浏览器：记下收到的操作，按顺序回话
  function fakeBrowser(replies: Array<BrowserActionResult | Error>) {
    const actions: BrowserAction[] = []
    return {
      actions,
      browser: async (action: BrowserAction) => {
        actions.push(action)
        const reply = replies.shift() ?? { text: 'ok', image: null }
        if (reply instanceof Error) throw reply
        return reply
      },
    }
  }
  const withBrowser = async (model: MockLanguageModelV4, images = false) => {
    const session = await makeSession(model)
    session.config = { ...session.config, browser: true, model: { ...session.config.model, supportsImages: images } }
    return session
  }

  test('客户端有浏览器才给工具；截图只给能看图的模型', async () => {
    const plain = await makeSession(scriptedModel([]))
    expect(Object.keys(plain.toolSet()).filter((name) => name.startsWith('browser_'))).toEqual([])
    const text = await withBrowser(scriptedModel([]))
    expect(Object.keys(text.toolSet()).filter((name) => name.startsWith('browser_'))).toEqual([
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_press_key',
      'browser_console',
    ])
    expect(Object.keys((await withBrowser(scriptedModel([]), true)).toolSet())).toContain('browser_screenshot')
  })

  test('本地地址直接打开，外部网站先问，拒绝了告诉模型；读页面、点击的结果发给模型', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'browser_navigate', input: { url: 'localhost:5173' } }] },
      { toolCalls: [{ name: 'browser_snapshot', input: {} }] },
      { toolCalls: [{ name: 'browser_click', input: { ref: 'e2' } }] },
      { toolCalls: [{ name: 'browser_navigate', input: { url: 'example.com/docs' } }] },
      { text: '好' },
    ])
    const session = await withBrowser(model)
    const fake = fakeBrowser([
      { text: '已打开 http://localhost:5173/', image: null },
      { text: '- button "保存" [ref=e2]', image: null },
      new Error('页面上没有 e2，先重新读页面'),
    ])
    // recordingIO 的计数记在它自己身上，不能展开复制
    const io = Object.assign(recordingIO('reject'), { browser: fake.browser })
    await runTurn(session, { id: 'turn-1', text: '看看页面' }, io)

    expect(fake.actions).toEqual([{ action: 'navigate', url: 'http://localhost:5173/' }, { action: 'snapshot' }, { action: 'click', ref: 'e2' }])
    expect(io.permissionRequests).toBe(1)
    expect(JSON.stringify(model.doStreamCalls[2]?.prompt)).toContain('- button \\"保存\\" [ref=e2]')
    expect(JSON.stringify(model.doStreamCalls[3]?.prompt)).toContain('Browser action failed: 页面上没有 e2')
    expect(JSON.stringify(model.doStreamCalls[4]?.prompt)).toContain('did not allow opening example.com')
    const titles = io.updates.flatMap((update) => (update.sessionUpdate === 'tool_call' ? [update.title] : []))
    expect(titles).toEqual(['浏览器 打开 http://localhost:5173/', '浏览器 读取页面', '浏览器 点击 e2', '浏览器 打开 https://example.com/docs'])
  })

  test('截图跟在工具结果后面作为一条带图片的消息，工具结果里只有文字', async () => {
    const model = scriptedModel([{ toolCalls: [{ name: 'browser_screenshot', input: {} }] }, { text: '看到了' }])
    const session = await withBrowser(model, true)
    const fake = fakeBrowser([{ text: '截图 1280x800', image: { mimeType: 'image/jpeg', data: 'SCREENSHOTDATA' } }])
    await runTurn(session, { id: 'turn-1', text: '截个图' }, Object.assign(recordingIO(), { browser: fake.browser }))
    const tool = session.messages.find((message) => message.role === 'tool')
    expect(JSON.stringify(tool)).not.toContain('SCREENSHOTDATA')
    const next = session.messages[session.messages.indexOf(tool!) + 1]
    expect(next?.role).toBe('user')
    expect(JSON.stringify(next)).toContain('SCREENSHOTDATA')
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('"mediaType":"image/jpeg"')
  })

  test('网址补全：本地按 http，其他按 https，只能 http(s)', () => {
    expect(normalizeUrl('localhost:3000/a')).toBe('http://localhost:3000/a')
    expect(normalizeUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080/')
    expect(normalizeUrl('example.com')).toBe('https://example.com/')
    expect(normalizeUrl('http://example.com/x')).toBe('http://example.com/x')
    expect(() => normalizeUrl('file:///C:/secret.txt')).toThrow('Only http(s)')
  })
})
