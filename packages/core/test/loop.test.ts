import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { APICallError, simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { Checkpoints } from '../src/checkpoint.js'
import { McpPool } from '../src/mcp.js'
import { findBash, findRipgrep } from '../src/environment.js'
import type { BrowserAction, BrowserActionResult, RulePack, SessionChecks, SessionLimits, SessionSecurity, SkillInfo, SkillSource, TaskProgressView, TurnOutcome } from '../src/protocol.js'
import { normalizeUrl } from '../src/urls.js'
import { runDiagnose } from '../src/session/diagnose.js'
import { runTurn, streamModelStep, type TurnIO } from '../src/session/loop.js'
import { formatPlan, runPlan } from '../src/session/plan.js'
import { compactManually } from '../src/session/compact.js'
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

const diffraMeta = (update: SessionUpdate) => (update._meta?.diffra ?? {}) as { result?: string; verification?: string }

// 标题以 title 开头的检查卡片，每次结束时记的 result，按出现顺序
function checkResults(io: { updates: SessionUpdate[] }, title: string) {
  const ids = new Set(io.updates.flatMap((update) => (update.sessionUpdate === 'tool_call' && update.title.startsWith(title) ? [update.toolCallId] : [])))
  return io.updates.flatMap((update) => (update.sessionUpdate === 'tool_call_update' && ids.has(update.toolCallId) ? [diffraMeta(update).result] : []))
}

// 完成卡和 verify_changes 卡的 verification，按出现顺序
function verifications(io: { updates: SessionUpdate[] }, title = '完成') {
  return io.updates.flatMap((update) => (update.sessionUpdate === 'tool_call' && update.title === title ? [diffraMeta(update).verification] : []))
}

const infoMeta = (update: SessionUpdate) =>
  (update.sessionUpdate === 'session_info_update' ? update._meta?.diffra ?? {} : {}) as { taskState?: TaskProgressView; turnOutcome?: TurnOutcome }

// 每轮结束时随任务状态发出的 turnOutcome，按出现顺序；一轮只发一次
function turnOutcomes(io: { updates: SessionUpdate[] }) {
  return io.updates.flatMap((update) => {
    const outcome = infoMeta(update).turnOutcome
    return outcome ? [outcome] : []
  })
}

function lastTaskState(io: { updates: SessionUpdate[] }) {
  return io.updates.flatMap((update) => {
    const state = infoMeta(update).taskState
    return state ? [state] : []
  }).at(-1)
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
    expect(verifications(io, '验证改动（不结束任务）')).toEqual(['verified'])
    // 完成条件没满足的 finish 也出一张打回卡；最后一次 finish 之前只跑了不改文件的命令，指纹没变，走无编辑短路
    expect(verifications(io)).toEqual(['failed', 'no-edits'])
    // verify_changes 通过不改变本轮结论
    expect(turnOutcomes(io)).toEqual([{ finish: 'no-edits', stop: null }])
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
    expect(verifications(io, '验证改动（不结束任务）')).toEqual(['verified', 'reused', 'verified'])
    expect(verifications(io)).toEqual(['reused'])
    // 复用的验证在本轮结论里算已验证
    expect(turnOutcomes(io)).toEqual([{ finish: 'verified', stop: null }])
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
    expect(turnOutcomes(cancelIO)).toEqual([{ finish: null, stop: 'cancelled' }])
  }, 30_000)

  test('发布任务没定义完整契约不能提前结束；暂停保留受阻状态', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'finish', input: { summary: '测试通过，稍后发布' } }] },
      { toolCalls: [{ name: 'pause_task', input: { status: 'waiting', reason: '等待 CI 完成' } }] },
    ])
    const session = await makeSession(model)
    const io = recordingIO()
    await runTurn(session, { id: 't', text: '提交推送打包发布 0.1.2' }, io)
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'paused' }])
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
    expect(checkResults(io, '快速检查')).toEqual(['failed', 'passed'])
    expect(checkResults(io, '完成检查')).toEqual(['passed'])
    expect(verifications(io)).toEqual(['verified'])
    expect(turnOutcomes(io)).toEqual([{ finish: 'verified', stop: null }])
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
    const io = recordingIO()
    await expect(runTurn(session, { id: 't', text: '写 new.txt' }, io)).resolves.toBe('end_turn')
    expect(readFileSync(join(project, 'new.txt'), 'utf8')).toBe('final\n')
    expect(model.doStreamCalls).toHaveLength(5)
    const finish = io.updates.findLast((update) => update.sessionUpdate === 'tool_call' && update.title === '完成')
    expect(finish).toMatchObject({ status: 'completed' })
    // 检查通过的完成卡只带 verification，不带未验证标记
    expect(finish?._meta).toEqual({ diffra: { verification: 'verified' } })
    expect(verifications(io)).toEqual(['failed', 'verified'])
    expect(checkResults(io, '完成检查')).toEqual(['failed', 'passed'])
    expect(turnOutcomes(io)).toEqual([{ finish: 'verified', stop: null }])
  })

  test('完成条件没满足、证据不合格时打回，各出一张 failed 完成卡', async () => {
    const pending = scriptedModel([
      { toolCalls: [{ name: 'task_progress', input: { action: 'define', requirements: [{ id: 'delivery', title: '执行交付', commandIncludes: 'deliver', outputIncludes: 'ok' }] } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '过早完成' } }] },
      { toolCalls: [{ name: 'pause_task', input: { status: 'blocked', reason: '还没交付' } }] },
    ])
    const pendingIO = recordingIO()
    await runTurn(await makeSession(pending), { id: 't', text: '交付' }, pendingIO)
    const card = (io: { updates: SessionUpdate[] }) => io.updates.find((update) => update.sessionUpdate === 'tool_call' && update.title === '完成')
    expect(card(pendingIO)).toMatchObject({
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: '完成条件未满足：执行交付' } }],
      _meta: { diffra: { verification: 'failed' } },
    })
    expect(turnOutcomes(pendingIO)).toEqual([{ finish: null, stop: 'paused' }])

    const evidence = scriptedModel([
      { toolCalls: [{ name: 'finish', input: { summary: '发布好了' } }] },
      { toolCalls: [{ name: 'pause_task', input: { status: 'blocked', reason: '缺少提交证据' } }] },
    ])
    const session = await makeSession(evidence)
    const receipt = { id: 'r', command: 'git rev-parse HEAD', output: 'no sha here', at: '2026-01-01T00:00:00.000Z' }
    session.taskState = {
      ...session.taskState,
      contractRequired: true,
      requirements: ['commit', 'push', 'ci', 'publish'].map((id) => ({ id, title: id, commandIncludes: 'git', outputIncludes: 'sha', receiptId: 'r' })),
      receipts: [receipt],
    }
    const evidenceIO = recordingIO()
    await runTurn(session, { id: 't', text: '发布' }, evidenceIO)
    expect(card(evidenceIO)).toMatchObject({
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: 'Commit evidence must contain the actual full 40-character SHA.' } }],
      _meta: { diffra: { verification: 'failed' } },
    })
    expect(JSON.stringify(session.messages)).toContain('Commit evidence must contain')
  })

  test('只用命令改了文件时 finish 不走无编辑短路，照样跑完成检查', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'run_command', input: { command: 'printf draft > out.txt' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '写好了' } }] },
      { toolCalls: [{ name: 'run_command', input: { command: 'printf final > out.txt' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '改好了' } }] },
    ])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: 'grep -q final out.txt' })
    const io = recordingIO()
    await expect(runTurn(session, { id: 't', text: '写 out.txt' }, io)).resolves.toBe('end_turn')
    expect(readFileSync(join(project, 'out.txt'), 'utf8')).toBe('final')
    expect(checkResults(io, '完成检查')).toEqual(['failed', 'passed'])
    expect(verifications(io)).toEqual(['failed', 'verified'])
    expect(turnOutcomes(io)).toEqual([{ finish: 'verified', stop: null }])
  })

  test('只用命令改了文件、完成检查打回后只回文字时被拉回，仍不调 finish 记 no-finish', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'run_command', input: { command: 'printf draft > out.txt' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '写好了' } }] },
      { text: '写好了' },
      { text: '真的写好了' },
      { text: '结束' },
      { text: '还是结束' },
    ])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: 'grep -q final out.txt' })
    const io = recordingIO()
    await expect(runTurn(session, { id: 't', text: '写 out.txt' }, io)).resolves.toBe('end_turn')
    // 检查命令不过的打回不占拉回的名额，只回文字照样拉回 3 次
    expect(model.doStreamCalls).toHaveLength(6)
    expect(JSON.stringify(session.messages)).toContain('You changed files but did not call finish')
    expect(verifications(io)).toEqual(['failed'])
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'no-finish' }])
    expect(lastTaskState(io)).toMatchObject({ status: 'blocked', needsVerification: true })
  })

  test('dev_server_start 也算跑过命令：没有检查点时 finish 记 unverified', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'dev_server_start', input: { command: 'pnpm gen' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '起好了' } }] },
    ])
    const session = await makeSession(model, undefined, [], undefined, undefined, undefined, {}, { checkpoints: null })
    session.config.browser = true
    session.permissionMode = 'full'
    const io = recordingIO()
    // 开发服务器启动时生成文件
    await runTurn(session, { id: 't', text: '起服务' }, { ...io, devServer: async () => {
      writeFileSync(join(project, 'out.txt'), 'x')
      return { text: 'started', url: null }
    } })
    expect(verifications(io)).toEqual(['unverified'])
  })

  test('没有检查点时跑过命令就 finish 记 unverified，不记 no-edits；没跑命令仍是 no-edits', async () => {
    const commanded = scriptedModel([
      { toolCalls: [{ name: 'run_command', input: { command: 'printf x > out.txt' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '写好了' } }] },
    ])
    const io = recordingIO()
    await runTurn(await makeSession(commanded, { afterEdit: null, beforeFinish: 'true' }, [], undefined, undefined, undefined, {}, { checkpoints: null }), { id: 't', text: '写 out.txt' }, io)
    const finish = io.updates.find((update) => update.sessionUpdate === 'tool_call' && update.title === '完成')
    expect(finish).toMatchObject({ status: 'completed' })
    // 检查命令配了，不带表示「没配检查命令」的 unverified 标记
    expect(finish?._meta).toEqual({ diffra: { verification: 'unverified' } })
    // 不知道有没有改动，不跑检查命令冒充验证
    expect(checkResults(io, '完成检查')).toEqual([])
    expect(commanded.doStreamCalls).toHaveLength(2)
    expect(turnOutcomes(io)).toEqual([{ finish: 'unverified', stop: null }])

    writeFileSync(join(project, 'a.txt'), 'a\n')
    const readOnly = scriptedModel([
      { toolCalls: [{ name: 'read_file', input: { path: 'a.txt' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '看过了' } }] },
    ])
    const readIO = recordingIO()
    await runTurn(await makeSession(readOnly, undefined, [], undefined, undefined, undefined, {}, { checkpoints: null }), { id: 't', text: '看看 a.txt' }, readIO)
    expect(verifications(readIO)).toEqual(['no-edits'])
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
    expect(finish).toMatchObject({ status: 'completed', _meta: { diffra: { unverified: true, verification: 'unverified' } } })
    // 未经验证是结构化字段，不再拼进模型写的总结
    expect(finish).toMatchObject({ content: [{ type: 'content', content: { type: 'text', text: '完成' } }] })
    expect(turnOutcomes(io)).toEqual([{ finish: 'unverified', stop: null }])
    expect(lastTaskState(io)).toMatchObject({ status: 'completed', needsVerification: false })
  })

  test('改了文件、拉回 3 次仍不调 finish 时停下，记 no-finish，任务状态带着待验证', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'edit_file', input: { path: 'b.txt', old_string: '', new_string: 'b\n' } }] },
      { text: '改好了' },
      { text: '真的改好了' },
      { text: '不用验证' },
      { text: '结束' },
    ])
    const session = await makeSession(model)
    const io = recordingIO()
    await expect(runTurn(session, { id: 't', text: '写 b.txt' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(5)
    expect(verifications(io)).toEqual([])
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'no-finish' }])
    expect(lastTaskState(io)).toMatchObject({ status: 'blocked', needsVerification: true })
    const outcomeUpdate = io.updates.find((update) => infoMeta(update).turnOutcome)
    expect(outcomeUpdate && infoMeta(outcomeUpdate).taskState).toMatchObject({ status: 'blocked', needsVerification: true })
  })

  test('没配检查命令时 verify_changes 卡片仍用文字说明未经验证', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'edit_file', input: { path: 'v.txt', old_string: '', new_string: 'v\n' } }] },
      { toolCalls: [{ name: 'verify_changes', input: { summary: '中间验证' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '完成' } }] },
    ])
    const io = recordingIO()
    await expect(runTurn(await makeSession(model), { id: 't', text: '写 v.txt' }, io)).resolves.toBe('end_turn')
    const verify = io.updates.find((update) => update.sessionUpdate === 'tool_call' && update.title === '验证改动（不结束任务）')
    // 界面还按通用工具行画验证卡片，未经验证仍要写在文本里；旧的 unverified 标记只给完成卡
    expect(verify).toMatchObject({ status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '中间验证\n\n未配置检查命令，改动未经自动验证。' } }] })
    expect(verify?._meta).toEqual({ diffra: { verification: 'unverified' } })
  })

  test('只回答问题、不改文件时不需要 finish', async () => {
    const model = scriptedModel([{ text: '这个项目是做什么的：……' }])
    const io = recordingIO()
    await expect(runTurn(await makeSession(model), { id: 't', text: '介绍一下' }, io)).resolves.toBe('end_turn')
    expect(io.updates.some((update) => update.sessionUpdate === 'agent_message_chunk')).toBe(true)
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: null }])
    expect(lastTaskState(io)).toMatchObject({ needsVerification: false })
  })

  test('之前轮次留下没验证的改动、本轮没改文件：拉回时说明是之前的改动，不说本轮改了文件', async () => {
    const model = scriptedModel([{ text: '这个函数负责解析配置' }, { text: '补充一点' }, { text: '没有了' }, { text: '结束' }])
    const session = await makeSession(model)
    session.taskState.needsVerification = true
    const io = recordingIO()
    await expect(runTurn(session, { id: 't', text: '这个函数是做什么的' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(4)
    expect(JSON.stringify(session.messages)).toContain('File changes from earlier turns have not been verified yet')
    expect(JSON.stringify(session.messages)).not.toContain('You changed files')
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'no-finish' }])
  })

  test('之前轮次留下没验证的改动、本轮又改了文件：拉回时说本轮改了文件', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'edit_file', input: { path: 'c.txt', old_string: '', new_string: 'c\n' } }] },
      { text: '写好了' },
      { text: '写好了' },
      { text: '写好了' },
      { text: '写好了' },
    ])
    const session = await makeSession(model)
    session.taskState.needsVerification = true
    const io = recordingIO()
    await expect(runTurn(session, { id: 't', text: '写 c.txt' }, io)).resolves.toBe('end_turn')
    expect(JSON.stringify(session.messages)).toContain('You changed files but did not call finish')
    expect(JSON.stringify(session.messages)).not.toContain('earlier turns')
  })

  test('没有检查点时重新生成不回滚文件，待验证保留重新生成前的值', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'edit_file', input: { path: 'a.txt', old_string: '', new_string: 'a\n' } }] },
      { text: '写好了' },
      { text: '写好了' },
      { text: '写好了' },
      { text: '写好了' },
    ])
    const session = await makeSession(model, undefined, [], undefined, undefined, undefined, {}, { checkpoints: null })
    session.startTurn('turn-1', '写 a.txt')
    await runTurn(session, { id: 'turn-1', text: '写 a.txt' }, recordingIO())
    session.endTurn('end_turn')
    expect(session.taskState.needsVerification).toBe(true)
    await expect(session.rewind('turn-1')).resolves.toEqual({ filesRestored: false })
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('a\n')
    expect(session.taskState).toMatchObject({ status: 'running', needsVerification: true })
  })

  test('之前轮次留下没验证的改动、本轮只用命令改了文件：拉回时两者都说；命令没改文件时只说之前的', async () => {
    const commanded = scriptedModel([
      { toolCalls: [{ name: 'run_command', input: { command: 'printf x > out.txt' } }] },
      { text: '写好了' },
      { text: '写好了' },
      { text: '写好了' },
      { text: '写好了' },
    ])
    const session = await makeSession(commanded)
    session.taskState.needsVerification = true
    const io = recordingIO()
    await expect(runTurn(session, { id: 't', text: '写 out.txt' }, io)).resolves.toBe('end_turn')
    const messages = JSON.stringify(session.messages)
    expect(messages).toContain('File changes from earlier turns, and the files your commands or MCP tools changed in this turn, have not been verified yet')
    expect(messages).not.toContain('File changes from earlier turns have not been verified yet')
    expect(messages).not.toContain('You changed files')
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'no-finish' }])

    const readOnly = scriptedModel([
      { toolCalls: [{ name: 'run_command', input: { command: 'ls' } }] },
      { text: '看过了' },
      { text: '看过了' },
      { text: '看过了' },
      { text: '看过了' },
    ])
    const readSession = await makeSession(readOnly)
    readSession.taskState.needsVerification = true
    await runTurn(readSession, { id: 't', text: '看看目录' }, recordingIO())
    expect(JSON.stringify(readSession.messages)).toContain('File changes from earlier turns have not been verified yet')
    expect(JSON.stringify(readSession.messages)).not.toContain('commands or MCP tools changed')
  })

  test('只用命令改了文件、没调 finish 就只回文字时被拉回，仍不调 finish 记 no-finish；命令没改文件时不拉回', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'run_command', input: { command: 'printf draft > out.txt' } }] },
      { text: '写好了' },
      { text: '真的写好了' },
      { text: '不用验证' },
      { text: '结束' },
    ])
    const io = recordingIO()
    await expect(runTurn(await makeSession(model), { id: 't', text: '写 out.txt' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(5)
    expect(JSON.stringify(model.doStreamCalls[2]?.prompt)).toContain('You changed files but did not call finish')
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'no-finish' }])
    expect(lastTaskState(io)).toMatchObject({ status: 'blocked', needsVerification: true })

    const readOnly = scriptedModel([{ toolCalls: [{ name: 'run_command', input: { command: 'ls' } }] }, { text: '看过了' }])
    const readIO = recordingIO()
    await expect(runTurn(await makeSession(readOnly), { id: 't', text: '看看目录' }, readIO)).resolves.toBe('end_turn')
    expect(readOnly.doStreamCalls).toHaveLength(2)
    expect(turnOutcomes(readIO)).toEqual([{ finish: null, stop: null }])
    expect(lastTaskState(readIO)).toMatchObject({ needsVerification: false })
  })

  test('撤销时有完成条件：证据作废，原因写要重新验证完成条件', async () => {
    const session = await makeSession(scriptedModel([{ text: '好' }]))
    session.startTurn('turn-1', '看看')
    await runTurn(session, { id: 'turn-1', text: '看看' }, recordingIO())
    session.endTurn('end_turn')
    session.taskState = {
      ...session.taskState,
      requirements: [{ id: 'test', title: '测试通过', commandIncludes: 'pnpm test', outputIncludes: 'passed', receiptId: 'r1' }],
      receipts: [{ id: 'r1', command: 'pnpm test', output: 'passed', at: '2026-01-01T00:00:00.000Z' }],
    }
    await session.restoreCheckpoint('turn-1')
    expect(session.taskState).toMatchObject({ status: 'blocked', reason: '文件已撤销，需要重新验证完成条件。', receipts: [], requirements: [{ id: 'test', receiptId: null }] })

    // 发布类任务还没定义完成条件时也一样：下一次 finish 仍要先定义
    session.taskState = { ...session.taskState, requirements: [], contractRequired: true }
    await session.restoreCheckpoint('turn-1')
    expect(session.taskState).toMatchObject({ status: 'blocked', reason: '文件已撤销，需要重新验证完成条件。' })
  })

  test('重新生成时，这一轮里才定下的完成条件和证据一起作废', async () => {
    const session = await makeSession(scriptedModel([{ text: '好' }]))
    session.startTurn('turn-1', '看看')
    await runTurn(session, { id: 'turn-1', text: '看看' }, recordingIO())
    session.endTurn('end_turn')
    session.taskState = {
      ...session.taskState,
      requirements: [{ id: 'test', title: '测试通过', commandIncludes: 'pnpm test', outputIncludes: 'passed', receiptId: 'r1' }],
      receipts: [{ id: 'r1', command: 'pnpm test', output: 'passed', at: '2026-01-01T00:00:00.000Z' }],
    }
    await session.rewind('turn-1')
    expect(session.taskState).toMatchObject({ status: 'running', reason: null, receipts: [], requirements: [] })
  })

  test('edit_file 失败、没改到文件时，不要求 finish，也不标成需要验证', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'edit_file', input: { path: 'missing.txt', old_string: 'x', new_string: 'y' } }] },
      { text: '文件不存在，没有改动' },
    ])
    const io = recordingIO()
    await expect(runTurn(await makeSession(model), { id: 't', text: '改 missing.txt' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(2)
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: null }])
    expect(lastTaskState(io)).toMatchObject({ needsVerification: false })
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

  test('命令结果的 _meta 带上是否成功：退出码非 0 时工具调用仍是 completed，但 commandSucceeded 为 false', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'run_command', input: { command: 'echo ok' } }] },
      { toolCalls: [{ name: 'run_command', input: { command: 'exit 3' } }] },
      { toolCalls: [{ name: 'read_file', input: { path: 'missing.txt' } }] },
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
    // 不是命令的工具不带这个字段
    expect(metaOf('call-2-0')?.meta).toBeUndefined()
  })

  test('工具开始时的标题就带上目标，跑完后换成工具返回的标题；失败的保留开始时的标题', async () => {
    writeFileSync(join(project, 'a.txt'), 'hello\n')
    const model = scriptedModel([
      { toolCalls: [{ name: 'run_command', input: { command: 'echo ok' } }] },
      { toolCalls: [{ name: 'read_file', input: { path: './a.txt' } }] },
      { toolCalls: [{ name: 'read_file', input: { path: 'missing.txt' } }] },
      { toolCalls: [{ name: 'search', input: { pattern: 'hello' } }] },
      { toolCalls: [{ name: 'list_files', input: {} }] },
      { toolCalls: [{ name: 'edit_file', input: { path: 'b.txt', old_string: '', new_string: 'b\n' } }] },
      { toolCalls: [{ name: 'edit_file', input: { path: 'a.txt', old_string: 'hello', new_string: 'hi' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '完成' } }] },
    ])
    const io = recordingIO()
    await runTurn(await makeSession(model), { id: 't', text: '看看' }, io)
    const startTitles = io.updates.flatMap((update) => (update.sessionUpdate === 'tool_call' && update.title !== '完成' ?[update.title] : []))
    expect(startTitles).toEqual(['执行 echo ok', '读取 ./a.txt', '读取 missing.txt', '搜索 hello', '列出 .', '新建 b.txt', '编辑 a.txt'])
    const finalTitle = (toolCallId: string) => {
      const update = io.updates.findLast((item) => item.sessionUpdate === 'tool_call_update' && item.toolCallId === toolCallId)
      return update?.sessionUpdate === 'tool_call_update' ? { status: update.status, title: update.title } : null
    }
    expect(finalTitle('call-1-0')).toEqual({ status: 'completed', title: '读取 a.txt' })
    expect(finalTitle('call-2-0')).toEqual({ status: 'failed', title: undefined })
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
    const io = recordingIO()
    const started = Date.now()
    const running = runTurn(session, { id: 't', text: '等' }, io)
    setTimeout(() => session.cancel(), 500)
    await expect(running).resolves.toBe('cancelled')
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(session.running).toBe(false)
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'cancelled' }])
  })

  test('模型调用失败时停下，记 model-error', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error('coder down')
      },
    })
    const io = recordingIO()
    await expect(runTurn(await makeSession(model), { id: 't', text: '介绍一下' }, io)).resolves.toBe('end_turn')
    expect(io.updates.some((update) => update.sessionUpdate === 'notice' && update.title === '模型调用失败')).toBe(true)
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'model-error', errorKind: 'unknown' }])
  })
})

describe('系统提示词', () => {
  test('配了检查命令时告诉模型会自动跑、不用自己跑', async () => {
    const prompt = await buildSystemPrompt(project, null, { checks: { afterEdit: 'pnpm typecheck', beforeFinish: 'pnpm test' }, readOnlyPaths: [], rules: NO_RULES }, [])
    expect(prompt).toContain('automatically runs `pnpm typecheck`')
    expect(prompt).toContain('Do not run it yourself')
    expect(prompt).toContain('Diffra then runs `pnpm test`')
  })

  test('约定牵动多个文件的改动在同一步一起改', async () => {
    const prompt = await buildSystemPrompt(project, null, { checks: { afterEdit: null, beforeFinish: null }, readOnlyPaths: [], rules: NO_RULES }, [])
    expect(prompt).toContain('edit all affected files in the same step')
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

describe('系统提示词里的 Skill 索引和前端做法', () => {
  const base = { checks: { afterEdit: null, beforeFinish: null }, readOnlyPaths: [], rules: NO_RULES }
  const skill = (name: string, source: SkillSource, description = '说明'): SkillInfo => ({ name, description, source, dir: `C:\\skills\\${name}` })

  test('没有 Skill、不是前端项目时都不写', async () => {
    const prompt = await buildSystemPrompt(project, null, base, [])
    expect(prompt).not.toContain('Skills: instructions')
    expect(prompt).not.toContain('Front-end work')
  })

  test('Skill 索引：名称、截短的描述和 SKILL.md 的位置；项目和内置的排在兼容读取的前面；放不下的只写条数', async () => {
    const long = 'x'.repeat(400)
    const skills = [
      skill('zeta', 'claude', long),
      skill('frontend-design', 'builtin', 'Guidance\nfor design'),
      skill('mine', 'project'),
      ...Array.from({ length: 30 }, (_, index) => skill(`extra-${index}`, 'codex', long)),
    ]
    const prompt = await buildSystemPrompt(project, null, base, [], { skills, frontend: null })
    const index = prompt.slice(prompt.indexOf('Skills: instructions'))
    expect(index).toContain('- mine: 说明 (C:/skills/mine/SKILL.md)')
    expect(index).toContain('- frontend-design: Guidance for design (C:/skills/frontend-design/SKILL.md)')
    expect(index.indexOf('- mine:')).toBeLessThan(index.indexOf('- frontend-design:'))
    expect(index.indexOf('- frontend-design:')).toBeLessThan(index.indexOf('- zeta:'))
    expect(index).toContain(`- zeta: ${'x'.repeat(150)}… (C:/skills/zeta/SKILL.md)`)
    const entries = index.split('\n').filter((line) => line.startsWith('- '))
    expect(entries.join('\n').length).toBeLessThanOrEqual(2000)
    expect(index).toContain(`(${skills.length - entries.length} more skills are installed but not listed here`)
  })

  test('前端项目：先跟着项目已有的设计走；开了浏览器才让它检查页面，能看图才让它截图', async () => {
    const off = await buildSystemPrompt(project, null, base, [], { skills: [], frontend: { browser: false, screenshots: false } })
    expect(off).toContain('Front-end work (this project has UI code):')
    expect(off).toContain('Reuse those components, colors, spacing and font sizes')
    expect(off).toContain('The built-in browser is off')
    expect(off).not.toContain('browser_check_layout')
    expect(off).not.toContain('frontend-design skill')

    const text = await buildSystemPrompt(project, null, base, [], { skills: [skill('frontend-design', 'builtin')], frontend: { browser: true, screenshots: false } })
    expect(text).toContain('run browser_check_layout')
    expect(text).toContain('(read the frontend-design skill listed below)')
    expect(text).not.toContain('browser_screenshot with width')
    expect(text.indexOf('Front-end work')).toBeLessThan(text.indexOf('Skills: instructions'))

    const vision = await buildSystemPrompt(project, null, base, [], { skills: [], frontend: { browser: true, screenshots: true } })
    expect(vision).toContain('browser_screenshot with width 1280 and with width 375')
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
    expect(checkResults(io, '规范审查')).toEqual(['failed', 'passed'])
    expect(io.updates.findLast((update) => update.sessionUpdate === 'tool_call' && update.title === '完成')).toMatchObject({ status: 'completed' })
    expect(verifications(io)).toEqual(['failed', 'unverified'])
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
    expect(checkResults(io, '规范审查')).toEqual(['error'])
    expect(io.updates.findLast((update) => update.sessionUpdate === 'tool_call' && update.title === '完成')).toMatchObject({ status: 'completed' })
  })

  test('改动太多被截断时只审查了一部分，记 partial', async () => {
    const code = Array.from({ length: 2000 }, (_, index) => `export const value${index} = ${index} // 用来撑大改动的一行\n`).join('')
    const model = scriptedModel([
      { toolCalls: [{ name: 'edit_file', input: { path: 'big.ts', old_string: '', new_string: code } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '加了常量' } }] },
    ])
    const reviewer = scriptedModel([{ text: 'NO_VIOLATIONS' }])
    const session = await makeSession(model, undefined, [], { packs: [pack], model: reviewer })
    const io = recordingIO()
    await expect(runTurn(session, { id: 't', text: '加常量' }, io)).resolves.toBe('end_turn')
    expect(JSON.stringify(toolUpdates(io, 'completed'))).toContain('只审查了前面一部分')
    expect(checkResults(io, '规范审查')).toEqual(['partial'])
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
    io.updates.filter((update) => update.sessionUpdate === 'tool_call' && update.title === '静态检查')

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
    expect(checkResults(io, '静态检查')).toEqual(['failed', 'passed'])
    expect(verifications(io)).toEqual(['failed', 'unverified'])

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
    // 放行的地方要让用户看到，不算干净
    expect(checkResults(io, '静态检查')).toEqual(['warned'])
    expect(io.updates.findLast((update) => update.sessionUpdate === 'tool_call' && update.title === '完成')).toMatchObject({ status: 'completed' })
  })
})

describe('完成前的轻量安全扫描', () => {
  const scanCards = (io: { updates: SessionUpdate[] }) =>
    io.updates.filter((update) => update.sessionUpdate === 'tool_call' && update.title === '轻量扫描')

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
    expect(checkResults(io, '轻量扫描')).toEqual(['failed', 'passed'])
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

  test('只有提醒时记 warned；模型调用失败时不拦截，记 error', async () => {
    // 两个会话共用一个项目目录，各写各的文件
    const edit = (path: string) => ({ toolCalls: [{ name: 'edit_file', input: { path, old_string: '', new_string: 'export const read = (name: string) => load(name)\n' } }] })
    const finish = { toolCalls: [{ name: 'finish', input: { summary: '加了读文件' } }] }
    const warned = await makeSession(scriptedModel([edit('files.ts'), finish]), undefined, [], { packs: [], model: scriptedModel([{ text: 'medium | SEC-INJ-4 | files.ts:1 | 确认 name 不含 ../' }]) }, { staticCheck: false, lightScan: true })
    const warnedIO = recordingIO()
    await runTurn(warned, { id: 't1', text: '加读文件' }, warnedIO)
    expect(checkResults(warnedIO, '轻量扫描')).toEqual(['warned'])
    expect(toolUpdates(warnedIO, 'failed')).toHaveLength(0)

    const failing = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error('reviewer down')
      },
    })
    const errored = await makeSession(scriptedModel([edit('load.ts'), finish]), undefined, [], { packs: [], model: failing }, { staticCheck: false, lightScan: true })
    const erroredIO = recordingIO()
    await runTurn(errored, { id: 't1', text: '加读文件' }, erroredIO)
    expect(JSON.stringify(erroredIO.updates)).toContain('模型扫描没有完成，这次不拦截')
    expect(checkResults(erroredIO, '轻量扫描')).toEqual(['error'])
    expect(verifications(erroredIO)).toEqual(['unverified'])
  })

  test('依赖审计没跑完时记 partial', async () => {
    const manifest = JSON.stringify({ packageManager: 'yarn@4.0.0', dependencies: { axios: '1.6.0' } }, null, 2)
    const model = scriptedModel([
      { toolCalls: [{ name: 'edit_file', input: { path: 'package.json', old_string: '', new_string: `${manifest}\n` } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '加了 axios' } }] },
    ])
    const reviewer = scriptedModel([{ text: 'NO_FINDINGS' }])
    const session = await makeSession(model, undefined, [], { packs: [], model: reviewer }, { staticCheck: false, lightScan: true })
    const io = recordingIO()
    await runTurn(session, { id: 't1', text: '加依赖' }, io)
    expect(JSON.stringify(io.updates)).toContain('yarn 项目暂不支持依赖审计')
    expect(checkResults(io, '轻量扫描')).toEqual(['partial'])
  })

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
        { toolCalls: [{ name: 'edit_file', input: { path: 'package.json', old_string: '', new_string: `${manifest}\n` } }] },
        { toolCalls: [{ name: 'edit_file', input: { path: 'package-lock.json', old_string: '', new_string: '{}\n' } }] },
        { toolCalls: [{ name: 'finish', input: { summary: '加了 axios' } }] },
      ])
      const reviewer = scriptedModel([{ text: 'NO_FINDINGS' }])
      const session = await makeSession(model, undefined, [], { packs: [], model: reviewer }, { staticCheck: false, lightScan: true })
      const io = recordingIO()
      await runTurn(session, { id: 't1', text: '加依赖' }, io)
      expect(JSON.stringify(io.updates)).toContain('项目原有 1 个依赖漏洞')
      expect(checkResults(io, '轻量扫描')).toEqual(['warned'])
      expect(toolUpdates(io, 'failed')).toHaveLength(0)
    } finally {
      process.env.PATH = savedPath
      rmSync(bin, { recursive: true, force: true })
    }
  })
})

describe('上下文压缩', () => {
  test('手动压缩不受百分比限制，保留原记录及最近完整步骤，任务状态不变，之后可继续聊', async () => {
    const model = scriptedModel([{ text: '保留用户约束及已读文件，继续待办。' }, { text: '按摘要接着做' }])
    const session = await makeSession(model)
    session.messages.push({ role: 'user', content: `早期需求 ${'历史细节'.repeat(3000)}` })
    for (let index = 0; index < 6; index++) {
      session.messages.push({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: `read-${index}`, toolName: 'read_file', input: { path: `f${index}.txt` } }] })
      session.messages.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: `read-${index}`, toolName: 'read_file', output: { type: 'text', value: 'old tool result' } }] })
    }
    session.lastContext = { inputTokens: 100, chars: messagesChars(session.messages) + session.systemPrompt.length + session.toolChars(), cacheRead: null, cacheWrite: null }
    const original = JSON.stringify(session.messages)
    const taskState = JSON.stringify(session.taskState)
    const io = recordingIO()
    expect(await compactManually(session, io)).toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(1)
    expect(model.doStreamCalls[0]?.toolChoice).toEqual({ type: 'none' })
    expect(session.compaction?.upTo).toBe(5)
    expect(JSON.stringify(session.messages)).toBe(original)
    expect(JSON.stringify(session.taskState)).toBe(taskState)
    expect(session.contextMessages().filter((message) => message.role === 'assistant')).toHaveLength(4)
    expect(session.contextMessages().filter((message) => message.role === 'tool')).toHaveLength(4)
    expect(io.updates.some((update) => update.sessionUpdate === 'usage_update')).toBe(true)
    expect(session.running).toBe(false)
    await runTurn(session, { id: 'after-compact', text: '继续' }, recordingIO())
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('保留用户约束及已读文件')
  })

  test('重启后没有 lastContext 时，手动压缩仍按存下来的最近用量更新上下文百分比', async () => {
    const model = scriptedModel([{ text: '摘要：保留项目偏好。' }])
    const session = await makeSession(model)
    session.messages.push({ role: 'user', content: `早期需求 ${'历史细节'.repeat(3000)}` }, { role: 'assistant', content: '早期回复' }, { role: 'user', content: '最新请求' })
    session.startTurn('old-turn', '早期需求')
    session.recordUpdate({ sessionUpdate: 'usage_update', used: 1000, size: 10_000, _meta: { diffra: { system: 10, rules: 10, tools: 10, messages: 970 }, cache: { read: 600, write: 20, input: 1000 } } })
    session.recordUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '早期回复' } })
    session.endTurn('end_turn')
    // 重启后 lastContext 只在内存里，加载会话时是空的
    session.lastContext = null
    const io = recordingIO()
    expect(await compactManually(session, io)).toBe('end_turn')
    const usage = io.updates.find((update) => update.sessionUpdate === 'usage_update')
    expect(usage?.sessionUpdate).toBe('usage_update')
    if (usage?.sessionUpdate !== 'usage_update') throw new Error('没有更新上下文用量')
    expect(usage.used).toBeGreaterThan(0)
    expect(usage.used).toBeLessThan(1000)
    expect(usage._meta).toMatchObject({ cache: { read: 600, write: 20, input: 1000 } })
  })

  test('短会话不调用模型，正在运行不能并发手动压缩', async () => {
    const model = scriptedModel([])
    const session = await makeSession(model)
    session.messages.push({ role: 'user', content: '只有一轮' }, { role: 'assistant', content: '答复' })
    expect(await compactManually(session, recordingIO())).toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(0)
    expect(session.compaction).toBeNull()
    session.activeTurn = new AbortController()
    await expect(compactManually(session, recordingIO())).rejects.toThrow('任务还在进行中')
    session.activeTurn = null
  })

  test('手动压缩失败或取消时已有摘要、消息原文保持不变', async () => {
    const model = scriptedModel([{ text: '' }])
    const session = await makeSession(model)
    session.messages.push({ role: 'user', content: '早期'.repeat(3000) }, { role: 'assistant', content: '回复' }, { role: 'user', content: '最新请求' }, { role: 'assistant', content: '最新回复' })
    const original = JSON.stringify(session.messages)
    const io = recordingIO()
    expect(await compactManually(session, io)).toBe('end_turn')
    expect(session.compaction).toBeNull()
    expect(JSON.stringify(session.messages)).toBe(original)
    expect(JSON.stringify(io.updates)).toContain('压缩失败')
    const cancelledIO = recordingIO()
    cancelledIO.update = async (update) => { cancelledIO.updates.push(update); if (update.sessionUpdate === 'tool_call') session.cancel() }
    expect(await compactManually(session, cancelledIO)).toBe('cancelled')
    expect(session.compaction).toBeNull()
    expect(JSON.stringify(session.messages)).toBe(original)
    expect(session.running).toBe(false)
  })

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
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'context-limit' }])
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
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'context-limit' }])
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
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'stuck' }])
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
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'step-limit' }])
  })

  test('快速检查连续 3 次失败且输出一样（没有进展）、没配兜底模型时停下，记 check-exhausted', async () => {
    writeFileSync(join(project, 'a.txt'), 'value = broken\n')
    const model = scriptedModel([
      { toolCalls: [{ name: 'read_file', input: { path: 'a.txt' } }] },
      { toolCalls: [{ name: 'edit_file', input: { path: 'a.txt', old_string: 'broken', new_string: 'try1' } }] },
      { toolCalls: [{ name: 'edit_file', input: { path: 'a.txt', old_string: 'try1', new_string: 'try2' } }] },
      { toolCalls: [{ name: 'edit_file', input: { path: 'a.txt', old_string: 'try2', new_string: 'try3' } }] },
      { text: '不会走到这里' },
    ])
    const session = await makeSession(model, { afterEdit: 'grep -q "value = fixed" a.txt', beforeFinish: null })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '修复 a.txt' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(4)
    expect(notices(io)).toEqual(['快速检查连续 3 次没有进展，已停止'])
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'check-exhausted' }])
    expect(lastTaskState(io)).toMatchObject({ status: 'blocked', needsVerification: true })
  })

  test('完成检查连续 3 次不过且输出一样（没有进展）、没配兜底模型时停下，记 gate-exhausted', async () => {
    const finish: Step = { toolCalls: [{ name: 'finish', input: { summary: '完成' } }] }
    const model = scriptedModel([
      { toolCalls: [{ name: 'edit_file', input: { path: 'new.txt', old_string: '', new_string: 'draft\n' } }] },
      finish,
      finish,
      finish,
      { text: '不会走到这里' },
    ])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: 'grep -q final new.txt' })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '写 new.txt' }, io)).resolves.toBe('end_turn')
    expect(notices(io)).toEqual(['完成检查连续 3 次没有进展，已停止'])
    expect(verifications(io)).toEqual(['failed', 'failed', 'failed'])
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'gate-exhausted' }])
  })

  const noticesWithText = (io: { updates: SessionUpdate[] }) =>
    io.updates.flatMap((update) => (update.sessionUpdate === 'notice' ? [{ title: update.title, description: update.description ?? '' }] : []))
  const tscError = (file: string, line: number, name: string) => `src/${file}.ts(${line},1): error TS2304: Cannot find name '${name}'.`
  const tscCheck = 'cat errors.txt; ! grep -q "error TS" errors.txt'

  test('快速检查前 3 次失败但每次都修好一部分时不停，第 4 步通过后正常完成；失败信息带进展摘要和一步改完的引导', async () => {
    const errors = ['a', 'b', 'c', 'd'].map((name) => tscError(name, 1, name))
    writeFileSync(join(project, 'errors.txt'), `${errors.join('\n')}\n`)
    const fix = (index: number) => ({ name: 'edit_file', input: { path: 'errors.txt', old_string: errors[index], new_string: `// fixed ${index}` } })
    const model = scriptedModel([
      { toolCalls: [{ name: 'read_file', input: { path: 'errors.txt' } }, fix(0)] },
      { toolCalls: [fix(1)] },
      { toolCalls: [fix(2)] },
      { toolCalls: [fix(3)] },
      { toolCalls: [{ name: 'finish', input: { summary: '都修好了' } }] },
    ])
    const session = await makeSession(model, { afterEdit: tscCheck, beforeFinish: null })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '修类型错误' }, io)).resolves.toBe('end_turn')
    expect(notices(io)).toEqual([])
    expect(checkResults(io, '快速检查')).toEqual(['failed', 'failed', 'failed', 'passed'])
    expect(turnOutcomes(io)).toEqual([{ finish: 'verified', stop: null }])
    const prompt = (index: number) => JSON.stringify(model.doStreamCalls[index]?.prompt)
    expect(prompt(1)).toContain('The check reported 3 errors.')
    expect(prompt(2)).toContain('Since the last check: 1 of 3 errors fixed, 0 new, 2 remaining.')
    expect(prompt(2)).toContain('edit_file can be called several times in one step')
  }, 30_000)

  test('同样的错误连续 3 次没有进展（只是行号变了）时停下，提示里列出剩余错误；下一轮开始时模型收到上次剩余的错误', async () => {
    writeFileSync(join(project, 'errors.txt'), `${tscError('task', 1, 'draftKey')}\n`)
    const shift = (from: number) => ({ name: 'edit_file', input: { path: 'errors.txt', old_string: `(${from},1)`, new_string: `(${from + 1},1)` } })
    const model = scriptedModel([
      { toolCalls: [{ name: 'read_file', input: { path: 'errors.txt' } }, shift(1)] },
      { toolCalls: [shift(2)] },
      { toolCalls: [shift(3)] },
      { toolCalls: [{ name: 'edit_file', input: { path: 'errors.txt', old_string: tscError('task', 4, 'draftKey'), new_string: '// fixed' } }] },
      { toolCalls: [{ name: 'finish', input: { summary: '修好了' } }] },
    ])
    const session = await makeSession(model, { afterEdit: tscCheck, beforeFinish: null })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '修类型错误' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(3)
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'check-exhausted' }])
    const [stopped] = noticesWithText(io)
    expect(stopped?.title).toBe('快速检查连续 3 次没有进展，已停止')
    expect(stopped?.description).toContain(tscError('task', 4, 'draftKey'))
    expect(stopped?.description).toContain('发「继续」可以接着修')

    const next = recordingIO()
    await expect(runTurn(session, { id: 'turn-2', text: '继续' }, next)).resolves.toBe('end_turn')
    const resumed = JSON.stringify(model.doStreamCalls[3]?.prompt)
    expect(resumed).toContain('were still unresolved')
    expect(resumed).toContain("Cannot find name 'draftKey'")
    expect(turnOutcomes(next)).toEqual([{ finish: 'verified', stop: null }])
    // 只带一次：这一轮的检查已经通过，下一轮不再说
    expect(session.unresolvedCheck).toBeNull()
  }, 30_000)

  test('错误来回变、每次都算有进展时，本轮快速检查失败满 12 次停下', async () => {
    writeFileSync(join(project, 'errors.txt'), `${tscError('a', 1, 'x0')}\n`)
    const rename = (from: number) => ({ name: 'edit_file', input: { path: 'errors.txt', old_string: `x${from}'`, new_string: `x${from + 1}'` } })
    const model = scriptedModel([
      { toolCalls: [{ name: 'read_file', input: { path: 'errors.txt' } }, rename(0)] },
      ...Array.from({ length: 11 }, (_, index): Step => ({ toolCalls: [rename(index + 1)] })),
      { text: '不会走到这里' },
    ])
    const session = await makeSession(model, { afterEdit: tscCheck, beforeFinish: null })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '修类型错误' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(12)
    expect(checkResults(io, '快速检查')).toHaveLength(12)
    expect(notices(io)).toEqual(['检查失败次数到上限，已停止'])
    expect(noticesWithText(io)[0]?.description).toContain(tscError('a', 1, 'x12'))
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'check-exhausted' }])
  }, 60_000)

  test('快速检查和完成检查共用每轮的失败上限：每步都改了又 finish、每次都有进展，合计失败满 12 次停下', async () => {
    writeFileSync(join(project, 'errors.txt'), `${tscError('a', 1, 'x0')}\n`)
    const rename = (from: number) => ({ name: 'edit_file', input: { path: 'errors.txt', old_string: `x${from}'`, new_string: `x${from + 1}'` } })
    const finish = { name: 'finish', input: { summary: '修好了' } }
    const model = scriptedModel([
      { toolCalls: [{ name: 'read_file', input: { path: 'errors.txt' } }, rename(0), finish] },
      ...Array.from({ length: 5 }, (_, index): Step => ({ toolCalls: [rename(index + 1), finish] })),
      { text: '不会走到这里' },
    ])
    const session = await makeSession(model, { afterEdit: tscCheck, beforeFinish: tscCheck })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '修类型错误' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(6)
    expect(checkResults(io, '快速检查')).toEqual(Array.from({ length: 6 }, () => 'failed'))
    expect(checkResults(io, '完成检查')).toEqual(Array.from({ length: 6 }, () => 'failed'))
    expect(notices(io)).toEqual(['检查失败次数到上限，已停止'])
    expect(noticesWithText(io)[0]?.description).toContain('快速检查和完成检查一共失败了 12 次')
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'check-exhausted' }])
  }, 60_000)

  test('检查输出超过给模型看的行数时按完整输出比较：500 个错误一个没修、每步只多一个，算没进展', async () => {
    const errors = Array.from({ length: 500 }, (_, index) => tscError(`f${index}`, 1, `x${index}`))
    writeFileSync(join(project, 'errors.txt'), `${errors.join('\n')}\n`)
    const add = (index: number) => ({ name: 'edit_file', input: { path: 'errors.txt', old_string: errors[0], new_string: `${tscError(`new${index}`, 1, 'n')}\n${errors[0]}` } })
    const model = scriptedModel([
      { toolCalls: [{ name: 'read_file', input: { path: 'errors.txt' } }, add(1)] },
      { toolCalls: [add(2)] },
      { toolCalls: [add(3)] },
      { text: '不会走到这里' },
    ])
    const session = await makeSession(model, { afterEdit: tscCheck, beforeFinish: null })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '修类型错误' }, io)).resolves.toBe('end_turn')
    const prompt = (index: number) => JSON.stringify(model.doStreamCalls[index]?.prompt)
    expect(prompt(1)).toContain('The check reported 501 errors.')
    expect(prompt(2)).toContain('Since the last check: 0 of 501 errors fixed, 1 new, 502 remaining.')
    expect(model.doStreamCalls).toHaveLength(3)
    expect(notices(io)).toEqual(['快速检查连续 3 次没有进展，已停止'])
    expect(noticesWithText(io)[0]?.description).toContain('还剩 503 个错误')
  }, 60_000)

  test('完成检查有进展地打回 3 次后只回一次文字，照样拉回接着修，最后通过', async () => {
    const failures = Array.from({ length: 10 }, (_, index) => `FAILED tests/test_app.py::test_${index + 1} - AssertionError: assert 0 == 1`)
    writeFileSync(join(project, 'results.txt'), `# results\n${failures.join('\n')}\n`)
    const remove = (from: number, to: number): Step => ({
      toolCalls: [{ name: 'edit_file', input: { path: 'results.txt', old_string: `${failures.slice(from, to).join('\n')}\n`, new_string: '' } }],
    })
    const finish: Step = { toolCalls: [{ name: 'finish', input: { summary: '测试都过了' } }] }
    const model = scriptedModel([
      { toolCalls: [{ name: 'read_file', input: { path: 'results.txt' } }, { name: 'edit_file', input: { path: 'results.txt', old_string: '# results', new_string: '# run' } }] },
      finish,
      remove(0, 3),
      finish,
      remove(3, 6),
      finish,
      { text: '还剩几个，我接着修' },
      remove(6, 10),
      finish,
    ])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: 'cat results.txt; ! grep -q FAILED results.txt' })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '修测试' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(9)
    expect(JSON.stringify(model.doStreamCalls[7]?.prompt)).toContain('You changed files but did not call finish')
    expect(notices(io)).toEqual([])
    expect(verifications(io)).toEqual(['failed', 'failed', 'failed', 'verified'])
    expect(turnOutcomes(io)).toEqual([{ finish: 'verified', stop: null }])
  }, 30_000)

  test('重新生成收到剩余错误的那一轮时，重发的那一轮照样收到；说明里写的是最近一次因检查卡住停下', async () => {
    writeFileSync(join(project, 'errors.txt'), `${tscError('task', 1, 'draftKey')}\n`)
    const shift = (from: number) => ({ name: 'edit_file', input: { path: 'errors.txt', old_string: `(${from},1)`, new_string: `(${from + 1},1)` } })
    const fix = { name: 'edit_file', input: { path: 'errors.txt', old_string: tscError('task', 4, 'draftKey'), new_string: '// fixed' } }
    const finish: Step = { toolCalls: [{ name: 'finish', input: { summary: '修好了' } }] }
    const model = scriptedModel([
      { toolCalls: [{ name: 'read_file', input: { path: 'errors.txt' } }, shift(1)] },
      { toolCalls: [shift(2)] },
      { toolCalls: [shift(3)] },
      { toolCalls: [fix] },
      finish,
      { toolCalls: [{ name: 'read_file', input: { path: 'errors.txt' } }, fix] },
      finish,
    ])
    const session = await makeSession(model, { afterEdit: tscCheck, beforeFinish: null })
    const run = async (id: string, text: string) => {
      session.startTurn(id, text)
      const io = recordingIO()
      await runTurn(session, { id, text }, io)
      session.endTurn('end_turn')
      return io
    }

    expect(turnOutcomes(await run('turn-1', '修类型错误'))).toEqual([{ finish: null, stop: 'check-exhausted' }])
    expect(turnOutcomes(await run('turn-2', '继续'))).toEqual([{ finish: 'verified', stop: null }])
    const resumed = JSON.stringify(model.doStreamCalls[3]?.prompt)
    expect(resumed).toContain('When the most recent turn stopped because a check was stuck')
    expect(resumed).not.toContain('When the previous turn stopped')

    await session.rewind('turn-2')
    expect(turnOutcomes(await run('turn-3', '继续'))).toEqual([{ finish: 'verified', stop: null }])
    expect(JSON.stringify(model.doStreamCalls[5]?.prompt).split('were still unresolved')).toHaveLength(2)
  }, 60_000)

  test('完成检查的失败测试从 10 个修到 0 个时不停，正常完成', async () => {
    const failures = Array.from({ length: 10 }, (_, index) => `FAILED tests/test_app.py::test_${index + 1} - AssertionError: assert 0 == 1`)
    writeFileSync(join(project, 'results.txt'), `# results\n${failures.join('\n')}\n`)
    const remove = (from: number, to: number): Step => ({
      toolCalls: [{ name: 'edit_file', input: { path: 'results.txt', old_string: `${failures.slice(from, to).join('\n')}\n`, new_string: '' } }],
    })
    const finish: Step = { toolCalls: [{ name: 'finish', input: { summary: '测试都过了' } }] }
    const model = scriptedModel([
      { toolCalls: [{ name: 'read_file', input: { path: 'results.txt' } }, { name: 'edit_file', input: { path: 'results.txt', old_string: '# results', new_string: '# run' } }] },
      finish,
      remove(0, 4),
      finish,
      remove(4, 7),
      finish,
      remove(7, 10),
      finish,
    ])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: 'cat results.txt; ! grep -q FAILED results.txt' })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '修测试' }, io)).resolves.toBe('end_turn')
    expect(notices(io)).toEqual([])
    expect(verifications(io)).toEqual(['failed', 'failed', 'failed', 'verified'])
    expect(turnOutcomes(io)).toEqual([{ finish: 'verified', stop: null }])
    const prompt = (index: number) => JSON.stringify(model.doStreamCalls[index]?.prompt)
    expect(prompt(2)).toContain('The check reported 10 errors.')
    expect(prompt(4)).toContain('Since the last check: 4 of 10 errors fixed, 0 new, 6 remaining.')
  }, 30_000)
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
    expect(notices(io)).toEqual(['已换用备用模型 兜底供应商 / fallback'])
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
    expect(notices(io)).toEqual(['已换用备用模型 兜底供应商 / fallback'])
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
    expect(notices(io)).toEqual(['已换用备用模型 兜底供应商 / fallback', '智能体在重复同样的操作，已停止'])
  })

  test('换备用模型后检查计数一起清零：快速检查和完成检查同一条命令、每步都改了又 finish，备用模型还有完整的 3 次没进展名额', async () => {
    writeFileSync(join(project, 'a.txt'), 'v0\n')
    const step = (index: number): Step => ({
      toolCalls: [{ name: 'edit_file', input: { path: 'a.txt', old_string: `v${index}`, new_string: `v${index + 1}` } }, { name: 'finish', input: { summary: '改好了' } }],
    })
    const coder = scriptedModel([{ toolCalls: [{ name: 'read_file', input: { path: 'a.txt' } }] }, step(0), step(1), step(2), { text: '不会走到这里' }])
    const fallback = scriptedModel([step(3), step(4), step(5), { text: '不会走到这里' }])
    const check = 'echo "src/a.ts(1,1): error TS2304: Cannot find name \'x\'."; exit 1'
    const session = await makeSession(coder, { afterEdit: check, beforeFinish: check }, [], undefined, undefined, undefined, { fallback })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '修 a.txt' }, io)).resolves.toBe('end_turn')
    expect(coder.doStreamCalls).toHaveLength(4)
    expect(fallback.doStreamCalls).toHaveLength(3)
    expect(notices(io)).toEqual(['已换用备用模型 兜底供应商 / fallback', '快速检查连续 3 次没有进展，已停止'])
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'check-exhausted' }])
  }, 60_000)

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

  test('服务不接受指定工具的 tool_choice（DeepSeek 思考模式）：要求交计划的那一步改用 auto 再发一次', async () => {
    const planner = scriptedModel([{ toolCalls: [{ name: 'search', input: { pattern: 'x' } }], inputTokens: 85_000 }, { toolCalls: [{ name: 'submit_plan', input: plan }] }])
    const forward = planner.doStream.bind(planner)
    let rejected = 0
    planner.doStream = async (options) => {
      if (options.toolChoice?.type === 'tool') {
        rejected++
        throw new APICallError({ message: 'Thinking mode does not support this tool_choice', url: 'http://model', requestBodyValues: {}, statusCode: 400, isRetryable: false })
      }
      return forward(options)
    }
    const session = await makeSession(scriptedModel([]), undefined, [], undefined, undefined, undefined, { plan: planner })
    const io = recordingIO()

    await expect(runPlan(session, { id: 'plan-1', text: '修复 a.txt' }, io)).resolves.toBe('end_turn')
    expect(rejected).toBe(1)
    expect(planner.doStreamCalls.map((call) => call.toolChoice)).toEqual([{ type: 'auto' }, { type: 'auto' }])
    expect(planCards(io)).toHaveLength(1)
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
    expect(turnOutcomes(io)).toEqual([{ finish: 'verified', stop: null }])
  })

  test('轮数用完还没达成就停下说明；只回文字时拉回来让它调 finish', async () => {
    const model = scriptedModel([{ text: '我想想' }, finish('第一轮做了一点', false), finish('第二轮还是没做完', false)])
    const session = await makeSession(model)
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '做完它' }, io, { goalMaxRounds: 2 })).resolves.toBe('end_turn')
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('call finish with goal_met')
    expect(notices(io)).toEqual(['目标模式第 2 轮', '目标模式已用完 2 轮，目标还没完成'])
    expect(turnOutcomes(io)).toEqual([{ finish: 'no-edits', stop: 'goal-exhausted' }])
  })

  test('最后一轮改了文件后 finish 被接受、轮数用完：门禁跑过了，不再留待验证', async () => {
    const model = scriptedModel([
      finish('第一轮先看看', false),
      { toolCalls: [{ name: 'edit_file', input: { path: 'a.txt', old_string: '', new_string: 'one\n' } }] },
      finish('第二轮写了一点', false),
    ])
    const session = await makeSession(model)
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '做完它' }, io, { goalMaxRounds: 2 })).resolves.toBe('end_turn')
    expect(turnOutcomes(io)).toEqual([{ finish: 'unverified', stop: 'goal-exhausted' }])
    expect(lastTaskState(io)).toMatchObject({ needsVerification: false })
  })

  test('第 1 轮的改动未经验证，第 2 轮没改文件就完成：本轮结论仍是 unverified', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'edit_file', input: { path: 'a.txt', old_string: '', new_string: 'one\n' } }] },
      finish('还要确认一下', false),
      finish('确认过了', true),
    ])
    const session = await makeSession(model)
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '写出 a.txt' }, io, { goalMaxRounds: 3 })).resolves.toBe('end_turn')
    expect(verifications(io)).toEqual(['unverified', 'no-edits'])
    expect(turnOutcomes(io)).toEqual([{ finish: 'unverified', stop: null }])
  })

  test('换轮后只用命令改了文件、finish 被完成检查打回后只回文字：按本轮改了文件拉回，停下时带着待验证', async () => {
    const model = scriptedModel([
      finish('第一轮先看看', false),
      { toolCalls: [{ name: 'run_command', input: { command: 'printf draft > out.txt' } }] },
      finish('第二轮写了草稿', false),
      { text: '写好了' },
      { text: '真的写好了' },
      { text: '结束' },
      { text: '还是结束' },
    ])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: 'grep -q final out.txt' })
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '写出 out.txt' }, io, { goalMaxRounds: 3 })).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(7)
    expect(verifications(io)).toEqual(['no-edits', 'failed'])
    const messages = JSON.stringify(session.messages)
    expect(messages).toContain('You changed files but did not call finish')
    expect(messages).not.toContain('earlier turns')
    expect(messages).not.toContain('Goal mode: keep working')
    expect(turnOutcomes(io)).toEqual([{ finish: 'no-edits', stop: 'no-finish' }])
    expect(lastTaskState(io)).toMatchObject({ status: 'blocked', needsVerification: true })
  })

  test('第 1 轮已验证、第 2 轮未经验证时结论是 unverified；第 2 轮没有改动时结论仍是 verified', async () => {
    const unverified = scriptedModel([
      { toolCalls: [{ name: 'edit_file', input: { path: 'a.txt', old_string: '', new_string: 'one\n' } }] },
      finish('还差 b.txt', false),
      { toolCalls: [{ name: 'edit_file', input: { path: 'b.txt', old_string: '', new_string: 'two\n' } }] },
      finish('都写好了', true),
    ])
    const session = await makeSession(unverified, { afterEdit: null, beforeFinish: 'test -f a.txt' })
    const io = recordingIO()
    const originalUpdate = io.update
    // 第 2 轮开始时去掉检查命令，让第 2 次 finish 未经验证
    io.update = async (update) => {
      await originalUpdate(update)
      if (update.sessionUpdate === 'notice' && update.title === '目标模式第 2 轮') session.config.checks = { afterEdit: null, beforeFinish: null }
    }
    await expect(runTurn(session, { id: 'turn-1', text: '写出 a.txt 和 b.txt' }, io, { goalMaxRounds: 3 })).resolves.toBe('end_turn')
    expect(verifications(io)).toEqual(['verified', 'unverified'])
    expect(turnOutcomes(io)).toEqual([{ finish: 'unverified', stop: null }])

    rmSync(join(project, 'a.txt'))
    const noEdits = scriptedModel([
      { toolCalls: [{ name: 'edit_file', input: { path: 'a.txt', old_string: '', new_string: 'one\n' } }] },
      finish('再看一遍', false),
      finish('没问题', true),
    ])
    const verifiedIO = recordingIO()
    await expect(runTurn(await makeSession(noEdits, { afterEdit: null, beforeFinish: 'test -f a.txt' }), { id: 'turn-1', text: '写出 a.txt' }, verifiedIO, { goalMaxRounds: 3 })).resolves.toBe('end_turn')
    expect(verifications(verifiedIO)).toEqual(['verified', 'no-edits'])
    expect(turnOutcomes(verifiedIO)).toEqual([{ finish: 'verified', stop: null }])
  }, 30_000)

  test('不是目标模式时 finish 照常结束，不看 goal_met', async () => {
    const model = scriptedModel([finish('好了', false)])
    const session = await makeSession(model)
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '问个问题' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(1)
    expect(notices(io)).toEqual([])
    expect(turnOutcomes(io)).toEqual([{ finish: 'no-edits', stop: null }])
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
      { toolCalls: [{ name: 'finish', input: { summary: '又写好了' } }] },
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
    // write_note 改了项目文件，指纹变了，不算没有改动
    expect(verifications(io)).toEqual(['unverified'])

    await runTurn(session, { id: 'turn-2', text: '再记一下' }, io)
    expect(io.permissionRequests).toBe(1)
    expect(readFileSync(join(project, 'note.txt'), 'utf8')).toBe('second\n')
    // 只回了文字，write_note 改了文件，拉回来调 finish
    expect(JSON.stringify(model.doStreamCalls[5]?.prompt)).toContain('You changed files but did not call finish')
    expect(turnOutcomes(io).at(-1)).toEqual({ finish: 'unverified', stop: null })
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
      { toolCalls: [{ name: 'finish', input: { summary: '记好了' } }] },
    ])
    const session = await withMcp(full)
    session.permissionMode = 'full'
    const fullIO = recordingIO('reject')
    await runTurn(session, { id: 'turn-1', text: '记一下' }, fullIO)
    expect(fullIO.permissionRequests).toBe(0)
    expect(readFileSync(join(project, 'note.txt'), 'utf8')).toBe('y\n')
    expect(JSON.stringify(full.doStreamCalls[2]?.prompt)).toContain('something broke')
    // 只回了文字，write_note 改了文件，拉回来调 finish
    expect(JSON.stringify(full.doStreamCalls[3]?.prompt)).toContain('You changed files but did not call finish')
    expect(turnOutcomes(fullIO)).toEqual([{ finish: 'unverified', stop: null }])
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
      'browser_check_layout',
      'browser_images',
    ])
    expect(Object.keys((await withBrowser(scriptedModel([]), true)).toolSet())).toContain('browser_screenshot')
  })

  test('截图可以指定视口宽度，不指定就是面板里的样子；布局检查的结果是文字', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'browser_screenshot', input: { width: 375 } }] },
      { toolCalls: [{ name: 'browser_screenshot', input: {} }] },
      { toolCalls: [{ name: 'browser_check_layout', input: {} }] },
      { text: '好' },
    ])
    const session = await withBrowser(model, true)
    const fake = fakeBrowser([
      { text: '截图 375x812', image: { mimeType: 'image/jpeg', data: 'PHONEPIC' } },
      { text: '截图 900x700', image: { mimeType: 'image/jpeg', data: 'PANELPIC' } },
      { text: '手机 375×812：\n- 横向溢出：页面内容宽 600px', image: null },
    ])
    const io = Object.assign(recordingIO(), { browser: fake.browser })
    await runTurn(session, { id: 'turn-1', text: '看看手机上的样子' }, io)
    expect(fake.actions).toEqual([{ action: 'screenshot', width: 375 }, { action: 'screenshot', width: null }, { action: 'layout' }])
    const titles = io.updates.flatMap((update) => (update.sessionUpdate === 'tool_call' ? [update.title] : []))
    expect(titles).toEqual(['浏览器 截图 375px 宽', '浏览器 截图', '浏览器 检查布局'])
    expect(JSON.stringify(model.doStreamCalls[3]?.prompt)).toContain('横向溢出：页面内容宽 600px')
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

describe('模型没有输出时的提示', () => {
  const silenceOf = (io: { updates: SessionUpdate[] }) =>
    io.updates.flatMap((update) => {
      const diffra = (update.sessionUpdate === 'session_info_update' ? update._meta?.diffra ?? {} : {}) as Record<string, unknown>
      return 'modelSilentSince' in diffra ? [diffra.modelSilentSince as string | null] : []
    })
  const textStream = (initialDelayInMs: number, chunkDelayInMs = 0, deltas = ['好了']) =>
    simulateReadableStream<StreamPart>({
      initialDelayInMs,
      chunkDelayInMs,
      chunks: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        ...deltas.map((delta) => ({ type: 'text-delta' as const, id: 't', delta })),
        { type: 'text-end', id: 't' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: usageOf() },
      ],
    })
  const step = (stream: ReadableStream<StreamPart>, io: TurnIO) =>
    streamModelStep(
      { model: new MockLanguageModelV4({ doStream: { stream } }), system: '', messages: [{ role: 'user', content: '你好' }], tools: {}, usage: { role: 'coder', provider: null, modelId: 'mock' } },
      new AbortController().signal,
      io,
    )

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('超过时限一点数据都没有，告诉界面从什么时候起没输出；又有数据时先撤掉提示再推文字，这一步照常跑完', async () => {
    vi.stubEnv('DIFFRA_MODEL_SILENCE_MS', '100')
    const io = recordingIO()
    const started = Date.now()
    await step(textStream(500), io)
    const silence = silenceOf(io)
    expect(silence).toHaveLength(2)
    expect(Date.parse(silence[0]!)).toBeGreaterThanOrEqual(started)
    expect(silence[1]).toBeNull()
    const kinds = io.updates.map((update) => update.sessionUpdate)
    expect(kinds.indexOf('agent_message_chunk')).toBeGreaterThan(kinds.lastIndexOf('session_info_update'))
    expect(io.updates.some((update) => update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' && update.content.text === '好了')).toBe(true)
  })

  test('点「重试这一步」只中断卡住的那次请求、原样再发一次，这一步照常跑完；提示随之撤掉', async () => {
    vi.stubEnv('DIFFRA_MODEL_SILENCE_MS', '100')
    const io = recordingIO()
    const handles = new Map<string, () => void>()
    const model = new MockLanguageModelV4({ doStream: [{ stream: textStream(20_000, 0, ['卡住的']) }, { stream: textStream(10, 0, ['重发后的']) }] })
    const pending = streamModelStep(
      { model, system: '', messages: [{ role: 'user', content: '你好' }], tools: {}, usage: { role: 'coder', provider: null, modelId: 'mock' } },
      new AbortController().signal,
      io,
      { key: 'main', handles },
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(silenceOf(io)).toHaveLength(1)
    handles.get('main')!()
    const result = await pending
    expect(model.doStreamCalls).toHaveLength(2)
    expect(JSON.stringify(result.responseMessages)).toContain('重发后的')
    expect(JSON.stringify(result.responseMessages)).not.toContain('卡住的')
    expect(silenceOf(io).at(-1)).toBeNull()
    // 这一步结束后不再能重试
    expect(handles.size).toBe(0)
  })

  test('模型没输出时被停止：不撤掉提示，记录里留着停下时已经多久没输出', async () => {
    vi.stubEnv('DIFFRA_MODEL_SILENCE_MS', '100')
    const io = recordingIO()
    const controller = new AbortController()
    const pending = streamModelStep(
      { model: new MockLanguageModelV4({ doStream: { stream: textStream(20_000) } }), system: '', messages: [{ role: 'user', content: '你好' }], tools: {}, usage: { role: 'coder', provider: null, modelId: 'mock' } },
      controller.signal,
      io,
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    controller.abort()
    await pending.catch(() => null)
    const silence = silenceOf(io)
    expect(silence).toHaveLength(1)
    expect(typeof silence[0]).toBe('string')
  })

  test('数据断断续续、每段间隔都不到时限就不提示：按最后一次收到数据的时间算，不按这一步开始的时间', async () => {
    vi.stubEnv('DIFFRA_MODEL_SILENCE_MS', '300')
    const io = recordingIO()
    const started = Date.now()
    await step(textStream(40, 40, ['一', '二', '三', '四', '五']), io)
    expect(Date.now() - started).toBeGreaterThan(300)
    expect(silenceOf(io)).toEqual([])
  })
})

describe('定位问题', () => {
  const toolStream = (toolCallId: string, toolName: string, input: unknown) =>
    simulateReadableStream<StreamPart>({
      chunks: [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: usageOf() },
      ],
    })
  // 先跑一轮：读了 hello.txt，然后模型报错停下；会话照 core 的做法把这一轮记下来
  async function stoppedTurn(diagnosisStep: ReadableStream<StreamPart> | 'throw') {
    writeFileSync(join(project, 'hello.txt'), 'hello\n')
    const steps: Array<ReadableStream<StreamPart> | 'throw'> = [toolStream('call-read', 'read_file', { path: 'hello.txt' }), 'throw', diagnosisStep]
    let call = 0
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const step = steps[call++]
        if (!step || step === 'throw') throw new Error('coder down')
        return { stream: step }
      },
    })
    const session = await makeSession(model)
    const io = recordingIO()
    const recorded: TurnIO = { ...io, update: async (update) => (session.recordUpdate(update), io.update(update)) }
    session.startTurn('t1', '读一下 hello.txt')
    session.endTurn(await runTurn(session, { id: 't1', text: '读一下 hello.txt' }, recorded))
    session.startTurn('d1', '定位问题：上一轮为什么停下', 'diagnose')
    return { session, model }
  }
  const diagnosisOf = (io: { updates: SessionUpdate[] }) =>
    io.updates.flatMap((update) => (update.sessionUpdate === 'tool_call' && update._meta?.diffra ? [(update._meta.diffra as { diagnosis?: Record<string, unknown> }).diagnosis] : [])).find(Boolean) as
      | { cause: string; evidence: Array<{ itemId: string }>; prompt: string; fallback: boolean; target: { turnId: string } }
      | undefined

  test('带着停下的原因、提示和每一步问当前模型；证据对回对话里那一步，默认答案那一行一定在提示词里', async () => {
    const { session, model } = await stoppedTurn(
      toolStream('call-diagnose', 'submit_diagnosis', {
        cause: '模型服务出错，任务本身没问题',
        evidence: [{ step: 's1', note: '文件已经读过' }, { step: 's9', note: '不存在的步骤' }],
        done: ['读过 hello.txt'],
        remaining: ['回答用户'],
        prompt: '继续，直接回答。',
        questions: [{ question: '要改文件吗？', options: [{ label: '不改', text: '只回答，不改文件。' }, { label: '改', text: '顺手把 hello 改成大写。' }] }],
      }),
    )
    const io = recordingIO()
    expect(await runDiagnose(session, { turnId: 't1', cardId: null }, io)).toBe('end_turn')
    const facts = JSON.stringify(model.doStreamCalls[2]?.prompt)
    expect(facts).toContain('How it ended: 模型调用出错（unknown）')
    expect(facts).toContain('s1 [completed]')
    expect(facts).toContain('coder down')
    const diagnosis = diagnosisOf(io)!
    expect(diagnosis.cause).toBe('模型服务出错，任务本身没问题')
    expect(diagnosis.evidence.map((item) => item.itemId)).toEqual(['call-read'])
    expect(diagnosis.prompt).toBe('继续，直接回答。\n只回答，不改文件。')
    expect(diagnosis.fallback).toBe(false)
    expect(diagnosis.target.turnId).toBe('t1')
    // 探索过程不进编码模型的对话
    expect(JSON.stringify(session.messages)).not.toContain('submit_diagnosis')
  })

  test('定位时模型也出错：提示定位失败，给一份按记录拼的通用提示词', async () => {
    const { session } = await stoppedTurn('throw')
    const io = recordingIO()
    expect(await runDiagnose(session, { turnId: 't1', cardId: null }, io)).toBe('end_turn')
    expect(io.updates.some((update) => update.sessionUpdate === 'notice' && update.title === '定位失败')).toBe(true)
    const diagnosis = diagnosisOf(io)!
    expect(diagnosis.fallback).toBe(true)
    expect(diagnosis.prompt).toContain('上一轮停在了')
    expect(diagnosis.prompt).toContain('已经完成的不要重做')
  })
})

describe('对话里的可视化', () => {
  test('show_visual 把标题和代码交给界面；参数不对时这一步失败、告诉模型原因', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'show_visual', input: { title: '对比', code: '<p>A</p>' } }] },
      { toolCalls: [{ name: 'show_visual', input: { title: '空的', code: '' } }] },
      { text: '画好了' },
    ])
    const session = await makeSession(model)
    expect(Object.keys(session.toolSet())).toContain('show_visual')
    const io = recordingIO()
    await runTurn(session, { id: 't', text: '画个图' }, io)
    const visual = io.updates.find((update) => update.sessionUpdate === 'tool_call' && update.title === '可视化 对比')
    expect((visual?._meta?.diffra as { visual?: unknown } | undefined)?.visual).toEqual({ title: '对比', code: '<p>A</p>' })
    // 参数不合法的调用走通用的失败卡片，模型拿到错误再改
    expect(io.updates.some((update) => update.sessionUpdate === 'tool_call' && update.title === 'show_visual' && update.status === 'failed')).toBe(true)
    expect(model.doStreamCalls).toHaveLength(3)
  })
})

describe('等外面的事做完', () => {
  test('wait_command 按间隔反复检查，期间不调模型；等到了把最后一次输出交给模型并记成证据', async () => {
    // 第一次检查还在跑，第二次成功
    const command = 'n=$(cat count 2>/dev/null || echo 0); n=$((n+1)); echo $n > count; if [ $n -ge 2 ]; then echo "conclusion: success"; else echo "status: in_progress"; fi'
    const model = scriptedModel([{ toolCalls: [{ name: 'wait_command', input: { command, success: 'success', failure: 'failure', interval_seconds: 10 } }] }, { text: 'CI 过了' }])
    const session = await makeSession(model)
    const io = recordingIO()
    await runTurn(session, { id: 't', text: '等 CI' }, io)
    expect(model.doStreamCalls).toHaveLength(2)
    expect(readFileSync(join(project, 'count'), 'utf8').trim()).toBe('2')
    const progress = io.updates.filter((update) => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'call-0-0')
    expect(JSON.stringify(progress)).toContain('第 1 次检查还没好')
    expect(progress.at(-1)).toMatchObject({ status: 'completed' })
    const result = JSON.stringify(model.doStreamCalls[1]?.prompt)
    expect(result).toContain('Done after 2 check(s)')
    expect(result).toContain('conclusion: success')
    expect(result).toContain('Evidence receipt id: call-0-0')
    expect(session.taskState.receipts.some((receipt) => receipt.id === 'call-0-0')).toBe(true)
  }, 30_000)

  test('输出里出现失败的字样就马上停，交给模型的是失败', async () => {
    const model = scriptedModel([{ toolCalls: [{ name: 'wait_command', input: { command: 'echo "conclusion: failure"', success: 'success', failure: 'failure' } }] }, { text: 'CI 挂了' }])
    const session = await makeSession(model)
    const io = recordingIO()
    await runTurn(session, { id: 't', text: '等 CI' }, io)
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('Failed after 1 check(s)')
    expect(session.taskState.receipts).toHaveLength(0)
  })
})

describe('任务之间互通', () => {
  const otherTurn = (prompt: string, reply: string, endedAt: string | null) => ({
    id: 'o1',
    kind: 'prompt' as const,
    prompt,
    startedAt: '2026-11-09T00:00:00.000Z',
    endedAt,
    stopReason: endedAt ? ('end_turn' as const) : null,
    updates: [{ sessionUpdate: 'agent_message_chunk' as const, content: { type: 'text' as const, text: reply } }],
    skills: [],
    images: [],
  })
  // 发出消息后对方跑起来，下一次查的时候已经做完
  function bridge(selfId: string) {
    const acted: unknown[] = []
    let busy = 0
    const running = () => busy-- > 0
    return {
      acted,
      tasks: {
        list: async () => [
          { id: selfId, cwd: project, title: '我自己', createdAt: '', updatedAt: '2026-11-09T01:00:00.000Z', archived: false, turnCount: 1, design: false, noProject: false },
          { id: 'other', cwd: project, title: '别的任务', createdAt: '', updatedAt: '2026-11-09T00:00:00.000Z', archived: false, turnCount: 1, design: false, noProject: false },
        ],
        record: async (id: string) => (id === 'other' ? { title: '别的任务', cwd: project, running: running(), turns: [otherTurn('把 README 写完', 'README 写好了', running() ? null : '2026-11-09T00:05:00.000Z')] } : null),
        act: async (params: unknown) => {
          acted.push(params)
          busy = 1
          return { ok: true as const, sessionId: 'other', title: '别的任务', queued: false }
        },
      },
    }
  }

  test('列出（不含自己）、读别的任务、发消息要确认并带上来源、等它做完；被别的任务叫起来的一轮不能再往外发', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'tasks_list', input: {} }] },
      { toolCalls: [{ name: 'task_read', input: { task_id: 'other' } }] },
      { toolCalls: [{ name: 'task_send', input: { task_id: 'other', message: '顺便加个目录' } }] },
      { toolCalls: [{ name: 'task_wait', input: { task_id: 'other' } }] },
      { text: '都好了' },
      { toolCalls: [{ name: 'task_send', input: { task_id: 'other', message: '再来一次' } }] },
      { text: '不能发' },
    ])
    const session = await makeSession(model)
    const { acted, tasks } = bridge(session.id)
    // 计数在 recordingIO 返回的对象上，不能展开成新对象
    const io = Object.assign(recordingIO(), { tasks })
    session.startTurn('t1', '协调一下')
    await runTurn(session, { id: 't1', text: '协调一下' }, io)
    const prompts = model.doStreamCalls.map((call) => JSON.stringify(call.prompt))
    expect(prompts[1]).toContain('other · \\"别的任务\\"')
    expect(prompts[1]).not.toContain('我自己')
    expect(prompts[2]).toContain('README 写好了')
    expect(io.permissionRequests).toBe(1)
    expect(acted).toEqual([{ sessionId: session.id, action: 'send', target: 'other', message: '顺便加个目录', from: { sessionId: session.id, title: session.title } }])
    // 等到对方这一轮结束，拿回它的回复
    expect(prompts[4]).toContain('task_wait')
    expect(prompts[4].split('task_wait').at(-1)).toContain('README 写好了')
    // 这一轮是别的任务发来的：发送直接被拒，不问用户
    session.startTurn('t2', '来自任务的消息', 'prompt', [], [], { sessionId: 'x', title: '上游' })
    await runTurn(session, { id: 't2', text: '来自任务的消息' }, io)
    expect(JSON.stringify(model.doStreamCalls[6]?.prompt)).toContain('started by a message from another task')
    expect(acted).toHaveLength(1)
    expect(io.permissionRequests).toBe(1)
  }, 20_000)
})
