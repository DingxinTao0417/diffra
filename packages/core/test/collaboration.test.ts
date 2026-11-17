import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { ModelMessage, ToolResultPart } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { COLLABORATION_PARALLELISM, type CollaborationRole, type CollaborationWorker } from '../src/collaboration-types.js'
import { findBash, findRipgrep } from '../src/environment.js'
import { AGENT_META_KEY, PARENT_TOOL_CALL_META_KEY, type SessionChecks, type SessionConfig } from '../src/protocol.js'
import { collaborationRuntime, collaborationView, type CollaborationRuntime } from '../src/session/collaboration.js'
import { disposeWorkerWorktree } from '../src/session/collaboration-worktrees.js'
import { runToolCall, type StepToolCall, type TurnIO } from '../src/session/loop.js'
import { buildSystemPrompt } from '../src/session/prompt.js'
import { Session, type SessionEnvironment } from '../src/session/session.js'
import type { SessionRecord } from '../src/session/store.js'

const GIT_TIMEOUT_MS = 15_000
const WORKER_TIMEOUT_MS = 15_000
const TEST_TIMEOUT_MS = 30_000
const CHECK_COMMAND = 'echo collaboration-check'
const CURRENT_REQUEST = '只在认领范围内修改；保留用户改动，运行实际命令验收。'
const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } }

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>
type StreamPart = StreamResult['stream'] extends ReadableStream<infer Part> ? Part : never
type PromptMessage = Parameters<MockLanguageModelV4['doStream']>[0]['prompt'][number]
type ToolCall = { name: string; input: unknown }
type Step = ({ toolCalls: ToolCall[] } | { text: string }) & { gate?: Gate }
interface Gate { entered: boolean; promise: Promise<void>; release(): void }

function gate(): Gate {
  let release = () => {}
  const promise = new Promise<void>((done) => { release = done })
  return { entered: false, promise, release }
}

async function awaitGate(pending: Gate, signal?: AbortSignal): Promise<void> {
  pending.entered = true
  signal?.throwIfAborted()
  let onAbort = () => {}
  const aborted = new Promise<never>((_done, reject) => {
    onAbort = () => reject(new DOMException('Aborted', 'AbortError'))
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([pending.promise, aborted])
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

function streamOf(step: Step, prefix: string): ReadableStream<StreamPart> {
  const chunks: StreamPart[] = 'text' in step
    ? [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'text' },
        { type: 'text-delta', id: 'text', delta: step.text },
        { type: 'text-end', id: 'text' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
      ]
    : [
        { type: 'stream-start', warnings: [] },
        ...step.toolCalls.map((call, index): StreamPart => ({ type: 'tool-call', toolCallId: `${prefix}-${index}`, toolName: call.name, input: JSON.stringify(call.input) })),
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
      ]
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

function promptText(message: PromptMessage): string {
  return message.role === 'user' ? message.content.map((part) => part.type === 'text' ? part.text : '').join('') : ''
}

function routedModel(scripts: Record<string, Step[]>) {
  const calls: string[] = []
  const used = new Map<string, number>()
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const task = options.prompt.map(promptText).find((text) => text.includes('Current user request and constraints')) ?? ''
      const route = Object.keys(scripts).find((marker) => task.includes(marker))
      if (!route) throw new Error(`没有匹配的工人剧本：${task}`)
      const index = used.get(route) ?? 0
      const step = scripts[route]?.[index]
      if (!step) throw new Error(`工人剧本被重复调用：${route}#${index}`)
      used.set(route, index + 1)
      calls.push(`${route}#${index}`)
      if (step.gate) await awaitGate(step.gate, options.abortSignal)
      return { stream: streamOf(step, `${route}-${index}`) }
    },
  })
  return { model, calls }
}

const exec = (cmd: string): ToolCall => ({ name: 'exec_command', input: { cmd, yield_time_ms: 1000, max_output_tokens: 2000 } })
const report = (summary: string, verdict?: 'passed' | 'changes_required' | 'blocked'): Step => ({ toolCalls: [{ name: 'report', input: { summary, ...(verdict ? { verdict } : {}) } }] })
const replace = (path: string, before: string, after: string): Step => ({ toolCalls: [{ name: 'apply_patch', input: { input: `*** Begin Patch\n*** Update File: ${path}\n-${before}\n+${after}\n*** End Patch` } }] })
const messagesText = (messages: ModelMessage[]) => JSON.stringify(messages)

function itemAt<T>(items: T[], index = 0): T {
  const value = items[index]
  if (value === undefined) throw new Error(`缺少第 ${index + 1} 项`)
  return value
}

function resultText(result: ToolResultPart): string {
  if (result.output.type !== 'text' && result.output.type !== 'error-text') throw new Error(`意外的工具结果：${result.output.type}`)
  return result.output.value
}

function successful(result: ToolResultPart): string {
  expect(result.output.type).toBe('text')
  return resultText(result)
}

function refused(result: ToolResultPart, reason: RegExp): void {
  expect(result.output.type).toBe('error-text')
  expect(resultText(result)).toMatch(reason)
}

function assertNoLinkAncestors(path: string): void {
  let current = resolve(path)
  for (;;) {
    expect(lstatSync(current).isSymbolicLink(), `不能经由链接访问 ${current}`).toBe(false)
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

function assertNoLinks(path: string): void {
  const info = lstatSync(path)
  expect(info.isSymbolicLink(), `不能递归操作链接 ${path}`).toBe(false)
  if (info.isDirectory()) for (const name of readdirSync(path)) assertNoLinks(join(path, name))
}

interface RecordingIO extends TurnIO {
  updates: SessionUpdate[]
  permissions: Array<Parameters<TurnIO['requestPermission']>[0]>
  saved: SessionRecord | null
  saves: number
}

interface Harness {
  session: Session
  runtime: CollaborationRuntime
  io: RecordingIO
  controller: AbortController
}

let scratch: string
let project: string
let worktreesRoot: string
let environment: SessionEnvironment
let harnesses: Harness[]
let callNumber: number

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: project, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_NAME: 'collaboration-test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'collaboration-test', GIT_COMMITTER_EMAIL: 'test@example.invalid', GIT_TERMINAL_PROMPT: '0' },
  })
}

function call(toolName: string, input: unknown): StepToolCall {
  return { toolName, input, toolCallId: `lead-${++callNumber}`, invalid: null }
}

async function makeHarness(model: MockLanguageModelV4, options: { record?: SessionRecord; maxSteps?: number; checks?: SessionChecks } = {}): Promise<Harness> {
  const checks = options.checks ?? { afterEdit: null, beforeFinish: null }
  const rules = { packs: [] }
  const config: SessionConfig = {
    model: { endpoint: { protocol: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:1', apiKey: 'mock' }, modelId: 'mock', contextWindow: 100_000, provider: null },
    reviewModel: null, planModel: null, fallbackModel: null,
    collaboration: { enabled: true, isolation: 'worktree' as const, acceptance: 'required' as const, maxParallel: COLLABORATION_PARALLELISM },
    checks, readOnlyPaths: [], rules, permissionMode: 'ask' as const, security: {},
    limits: { compactAtPercent: 70, maxSteps: options.maxSteps ?? 12, goalMaxRounds: 5 }, plugins: [], checkpointDir: null,
  }
  const session = new Session({
    cwd: project, config, environment, checkpoints: null, rulePacks: [], worktreesRoot, model,
    systemPrompt: await buildSystemPrompt(environment.bashPath, { checks, readOnlyPaths: [], rules }, []),
    workerPrompt: await buildSystemPrompt(environment.bashPath, { checks, readOnlyPaths: [], rules }, [], { skills: [], frontend: null, worker: true }),
    ...(options.record ? { record: options.record } : {}),
  })
  if (!options.record) session.startTurn('turn-1', CURRENT_REQUEST)
  const io: RecordingIO = {
    updates: [], permissions: [], saved: null, saves: 0,
    update: async (update) => { io.updates.push(structuredClone(update)) },
    persist: async () => { io.saved = structuredClone(session.toRecord()); io.saves++ },
    requestPermission: async (request) => { io.permissions.push(structuredClone(request)); return 'allow_once' },
    recordUsage: async () => {},
  }
  const controller = new AbortController()
  const runtime = collaborationRuntime(session)
  const harness = { session, runtime, io, controller }
  harnesses.push(harness)
  await runtime.bind({ language: session.model, config: session.config.model }, controller.signal, io)
  return harness
}

async function delegate(harness: Harness, marker: string, options: { role?: CollaborationRole; files?: string[]; background?: boolean; context?: 'fresh' | 'fork' } = {}): Promise<CollaborationWorker> {
  const before = harness.session.collaboration.workers.length
  successful(await harness.runtime.delegate(call('delegate', { name: marker, task: `${marker}: 执行分配工作`, role: 'explorer', ...options })))
  return itemAt(harness.session.collaboration.workers, before)
}

async function settled(harness: Harness, workers: CollaborationWorker[]): Promise<void> {
  await harness.runtime.wait(workers.map((worker) => worker.id), WORKER_TIMEOUT_MS)
  expect(workers.map((worker) => worker.status)).not.toContain('running')
  expect(workers.map((worker) => worker.status)).not.toContain('queued')
}

function lastCard(harness: Harness, worker: CollaborationWorker) {
  return harness.io.updates.filter((update) => update.sessionUpdate === 'tool_call_update' && update.toolCallId === worker.cardId).at(-1)
}

beforeAll(async () => {
  environment = { bashPath: await findBash(), rgPath: await findRipgrep() }
})

beforeEach(() => {
  const temporary = realpathSync(tmpdir())
  assertNoLinkAncestors(temporary)
  scratch = mkdtempSync(join(temporary, 'diffra-collaboration-session-'))
  worktreesRoot = mkdtempSync(join(temporary, 'diffra-collaboration-managed-'))
  assertNoLinkAncestors(scratch)
  assertNoLinkAncestors(worktreesRoot)
  const fromScratch = relative(scratch, worktreesRoot)
  expect(isAbsolute(fromScratch) || fromScratch.startsWith(`..${sep}`)).toBe(true)
  expect(worktreesRoot).not.toBe(parse(worktreesRoot).root)
  project = join(scratch, 'project')
  mkdirSync(project)
  writeFileSync(join(project, 'a.txt'), 'alpha\n')
  writeFileSync(join(project, 'b.txt'), 'beta\n')
  assertNoLinks(scratch)
  assertNoLinks(worktreesRoot)
  git('init', '-q')
  git('config', 'core.autocrlf', 'false')
  git('add', '.')
  git('commit', '-qm', 'fixture')
  harnesses = []
  callNumber = 0
})

afterEach(async () => {
  for (const harness of harnesses) harness.controller.abort()
  for (const harness of harnesses) await harness.runtime.close()
  const worktrees = new Map(harnesses.flatMap(({ session }) => session.collaboration.workers.flatMap((worker) => worker.worktree ? [[worker.worktree.dir, worker.worktree] as const] : [])))
  assertNoLinks(scratch)
  assertNoLinks(worktreesRoot)
  for (const worktree of worktrees.values()) await disposeWorkerWorktree(worktree)
  for (const harness of harnesses) harness.session.execSessions.killAll()
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  rmSync(worktreesRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}, TEST_TIMEOUT_MS)

describe('真实 Session 的持久协作运行时', () => {
  test('后台委派立即返回，主智能体可继续执行；同时最多八个工人，第九个等空位后启动', async () => {
    const gates = Array.from({ length: COLLABORATION_PARALLELISM + 1 }, gate)
    const scripts = Object.fromEntries(gates.map((pending, index) => [`WORKER-${index}`, [{ ...report(`完成 ${index}`), gate: pending }]]))
    const { model, calls } = routedModel(scripts)
    const harness = await makeHarness(model)
    const workers: CollaborationWorker[] = []
    for (const index of gates.keys()) workers.push(await delegate(harness, `WORKER-${index}`))
    await vi.waitFor(() => expect(gates.slice(0, COLLABORATION_PARALLELISM).every((pending) => pending.entered)).toBe(true), { timeout: WORKER_TIMEOUT_MS })
    expect(workers.filter((worker) => worker.status === 'running')).toHaveLength(COLLABORATION_PARALLELISM)
    expect(itemAt(workers, COLLABORATION_PARALLELISM).status).toBe('queued')
    expect(itemAt(gates, COLLABORATION_PARALLELISM).entered).toBe(false)

    const main = await runToolCall(harness.session, call('exec_command', { cmd: 'echo main-can-continue', yield_time_ms: 1000 }), harness.controller.signal, harness.io)
    expect(successful(main.result)).toContain('main-can-continue')
    expect(workers.every((worker) => worker.summary === null)).toBe(true)
    successful(await harness.runtime.tool(call('wait_agents', { agents: workers.map((worker) => worker.id), timeout_ms: 10 })))
    expect(itemAt(workers, COLLABORATION_PARALLELISM).status).toBe('queued')

    itemAt(gates).release()
    await vi.waitFor(() => expect(itemAt(gates, COLLABORATION_PARALLELISM).entered).toBe(true), { timeout: WORKER_TIMEOUT_MS })
    expect(itemAt(workers).status).toBe('completed')
    expect(workers.filter((worker) => worker.status === 'running')).toHaveLength(COLLABORATION_PARALLELISM)
    for (const pending of gates) pending.release()
    await settled(harness, workers)
    expect(workers.every((worker) => worker.status === 'completed')).toBe(true)
    expect(calls).toHaveLength(COLLABORATION_PARALLELISM + 1)
    expect(harness.session.model).toBe(model)
    expect(harness.io.saves).toBeGreaterThan(workers.length)
  }, TEST_TIMEOUT_MS)

  test('运行中的消息先持久化再投递；工人可回信，report 后仍用原身份和上下文续聊', async () => {
    const pending = gate()
    const { model } = routedModel({
      'MESSENGER': [
        { text: '正在处理第一部分', gate: pending },
        { toolCalls: [{ name: 'send_message', input: { agent: 'lead', message: '第一封工人回信' } }] },
        report('第一次交回'),
        { toolCalls: [{ name: 'send_message', input: { agent: 'lead', message: '续聊回信' } }] },
        report('续聊交回'),
      ],
    })
    const harness = await makeHarness(model)
    const worker = await delegate(harness, 'MESSENGER')
    await vi.waitFor(() => expect(pending.entered).toBe(true), { timeout: WORKER_TIMEOUT_MS })
    const sent = await harness.runtime.tool(call('send_message', { agent: worker.id, message: '补充约束：保留 beta' }))
    expect(successful(sent)).toContain('accepted_and_saved')
    expect(harness.io.saved?.collaboration?.messages).toEqual(expect.arrayContaining([expect.objectContaining({ recipient: worker.id, content: '补充约束：保留 beta', status: 'pending' })]))
    expect(messagesText(worker.messages)).not.toContain('补充约束：保留 beta')
    pending.release()
    await settled(harness, [worker])
    expect(worker).toMatchObject({ status: 'completed', activation: 1, summary: '第一次交回' })
    expect(worker.messages.filter((message) => messagesText([message]).includes('补充约束：保留 beta'))).toHaveLength(1)
    expect(messagesText(harness.session.messages)).not.toContain('第一封工人回信')
    expect(await harness.runtime.collect()).toBe(true)
    expect(messagesText(harness.session.messages)).toContain('第一封工人回信')
    const count = harness.session.messages.length
    expect(await harness.runtime.collect()).toBe(false)
    expect(harness.session.messages).toHaveLength(count)

    await harness.runtime.control({ action: 'message', workerId: worker.id, message: '继续处理第二部分' })
    await settled(harness, [worker])
    expect(harness.session.collaboration.workers).toHaveLength(1)
    expect(worker).toMatchObject({ status: 'completed', activation: 2, summary: '续聊交回', resultRevision: 2 })
    const continued = itemAt(model.doStreamCalls, 3)
    expect(JSON.stringify(continued.prompt)).toContain('第一次交回')
    expect(JSON.stringify(continued.prompt)).toContain('Report recorded.')
    expect(JSON.stringify(continued.prompt)).toContain('继续处理第二部分')
    expect(JSON.stringify(continued.prompt)).toContain(CURRENT_REQUEST)
    expect(await harness.runtime.collect()).toBe(true)
    expect(messagesText(harness.session.messages)).toContain('续聊回信')
    expect(worker.notifiedRevision).toBe(worker.resultRevision)
    expect(harness.session.collaboration.messages.every((message) => message.status === 'delivered')).toBe(true)
  }, TEST_TIMEOUT_MS)

  test('续聊时模型重复使用工具调用 id，新的过程卡片仍属于本次激活且不会复写旧卡片', async () => {
    const script: Step[] = [{ toolCalls: [exec('cat a.txt')] }, report('第一轮报告'), { toolCalls: [exec('cat b.txt')] }, report('第二轮报告')]
    let position = 0
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const step = itemAt(script, position++)
        return { stream: streamOf(step, position % 2 === 0 ? 'reused-report' : 'reused-exec') }
      },
    })
    const harness = await makeHarness(model)
    const worker = await delegate(harness, 'REUSED-TOOL-ID')
    await settled(harness, [worker])
    const firstCard = worker.cardId
    await harness.runtime.control({ action: 'message', workerId: worker.id, message: '继续检查第二个文件' })
    await settled(harness, [worker])
    expect(worker).toMatchObject({ status: 'completed', activation: 2, summary: '第二轮报告' })
    expect(worker.cardId).not.toBe(firstCard)
    const nested = harness.io.updates.filter((update) => update.sessionUpdate === 'tool_call' && update.toolCallId.startsWith(`${worker.id}/`))
    const ids = nested.map((update) => 'toolCallId' in update ? update.toolCallId : '')
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    expect(nested.map((update) => update._meta?.diffra)).toEqual([
      expect.objectContaining({ [PARENT_TOOL_CALL_META_KEY]: firstCard }),
      expect.objectContaining({ [PARENT_TOOL_CALL_META_KEY]: worker.cardId }),
    ])
  }, TEST_TIMEOUT_MS)

  test('已整合的工人续聊会刷新基线，增量整合不重放旧修改，验收责任不丢失', async () => {
    const { model } = routedModel({ 'INCREMENTAL': [replace('a.txt', 'alpha', 'ALPHA'), report('第一批改动'), replace('b.txt', 'user beta', 'BETA'), report('第二批改动')] })
    const harness = await makeHarness(model)
    const worker = await delegate(harness, 'INCREMENTAL', { role: 'implementer', files: ['a.txt', 'b.txt'] })
    await settled(harness, [worker])
    await harness.runtime.integrate(worker.id)
    writeFileSync(join(project, 'b.txt'), 'user beta\n')
    await harness.runtime.control({ action: 'message', workerId: worker.id, message: '再修改 b.txt；保留已整合 a.txt 和用户最新修改。' })
    await settled(harness, [worker])
    expect(readFileSync(join(worker.worktree?.cwd ?? '', 'b.txt'), 'utf8')).toBe('BETA\n')
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('ALPHA\n')
    expect(readFileSync(join(project, 'b.txt'), 'utf8')).toBe('user beta\n')
    await harness.runtime.integrate(worker.id)
    expect(readFileSync(join(project, 'b.txt'), 'utf8')).toBe('BETA\n')
    expect(harness.session.collaboration.requiresAcceptance).toBe(true)
    expect(worker.activation).toBe(2)
  }, TEST_TIMEOUT_MS)

  test('工人停在消息等待时，单独中断能结束等待，不必取消主任务', async () => {
    const { model } = routedModel({ 'WAIT-INBOX': [{ toolCalls: [{ name: 'wait_agents', input: { timeout_ms: 60_000 } }] }, report('等待后完成')] })
    const harness = await makeHarness(model)
    const worker = await delegate(harness, 'WAIT-INBOX')
    await vi.waitFor(() => expect(harness.io.updates.some((update) => update.sessionUpdate === 'tool_call' && update.title === 'wait_agents')).toBe(true))
    await harness.runtime.control({ action: 'interrupt', workerId: worker.id })
    await settled(harness, [worker])
    expect(worker.status).toBe('interrupted')
    expect(harness.controller.signal.aborted).toBe(false)
  }, TEST_TIMEOUT_MS)

  test('fork 保留已完成历史但不复制父会话正在执行的工具批次，用户要求仍完整提供', async () => {
    const { model } = routedModel({ 'FORK-CONTEXT': [report('已接收历史与当前要求')] })
    const harness = await makeHarness(model)
    harness.session.messages.push({ role: 'user', content: '第一轮约束：金额必须使用最小单位。' }, { role: 'assistant', content: '已确认第一轮约束。' })
    harness.session.messageStarts.set('turn-1', harness.session.messages.length)
    harness.session.messages.push({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'unbalanced-parent', toolName: 'delegate', input: {} }] })
    const worker = await delegate(harness, 'FORK-CONTEXT', { context: 'fork' })
    await settled(harness, [worker])
    expect(messagesText(worker.messages)).toContain('金额必须使用最小单位')
    expect(messagesText(worker.messages)).toContain(CURRENT_REQUEST)
    expect(messagesText(worker.messages)).not.toContain('unbalanced-parent')
  }, TEST_TIMEOUT_MS)

  test('报告不是批次最后一个调用时，未执行调用有中断结果，续聊不会留下缺失的工具结果', async () => {
    const { model } = routedModel({ 'REPORT-BATCH': [{ toolCalls: [{ name: 'report', input: { summary: '本次结束' } }, { name: 'exec_command', input: { cmd: 'cat a.txt' } }] }, report('第二次结束')] })
    const harness = await makeHarness(model)
    const worker = await delegate(harness, 'REPORT-BATCH')
    await settled(harness, [worker])
    expect(messagesText(worker.messages)).toContain('Not executed: this activation ended with report')
    await harness.runtime.control({ action: 'message', workerId: worker.id, message: '继续复查，不重跑未执行批次。' })
    await settled(harness, [worker])
    const calls = worker.messages.flatMap((message) => message.role === 'assistant' && Array.isArray(message.content) ? message.content.flatMap((part) => part.type === 'tool-call' ? [part.toolCallId] : []) : [])
    const results = new Set(worker.messages.flatMap((message) => message.role === 'tool' ? message.content.flatMap((part) => part.type === 'tool-result' ? [part.toolCallId] : []) : []))
    expect(calls.every((id) => results.has(id))).toBe(true)
    expect(worker.activation).toBe(2)
  }, TEST_TIMEOUT_MS)

  test('工人等权限时传递独立取消信号，停止不挂住其它工人', async () => {
    const { model } = routedModel({ 'WAIT-PERMISSION': [{ toolCalls: [exec('echo own > own.txt')] }, report('不应正常完成')] })
    const harness = await makeHarness(model)
    let requested = false
    harness.io.requestPermission = async (_request, _options, signal) => {
      requested = true
      if (!signal) throw new Error('工人没有独立取消信号')
      await new Promise<void>((done) => { signal.addEventListener('abort', () => done(), { once: true }); if (signal.aborted) done() })
      return null
    }
    const worker = await delegate(harness, 'WAIT-PERMISSION', { role: 'implementer', files: ['own.txt'] })
    await vi.waitFor(() => expect(requested).toBe(true), { timeout: WORKER_TIMEOUT_MS })
    await harness.runtime.control({ action: 'interrupt', workerId: worker.id })
    await settled(harness, [worker])
    expect(worker.status).toBe('interrupted')
    expect(harness.controller.signal.aborted).toBe(false)
  }, TEST_TIMEOUT_MS)

  test('工人只改独立 worktree，显式整合才改主项目，并发出真实 diff；重复整合不重放', async () => {
    const { model } = routedModel({ 'IMPLEMENT': [{ toolCalls: [exec('cat a.txt')] }, replace('a.txt', 'alpha', 'ALPHA'), report('实现完成')] })
    const harness = await makeHarness(model)
    const worker = await delegate(harness, 'IMPLEMENT', { role: 'implementer', files: ['a.txt'] })
    await settled(harness, [worker])
    expect(worker.status).toBe('completed')
    expect(worker.worktree?.cwd).not.toBe(project)
    expect(readFileSync(join(worker.worktree?.cwd ?? '', 'a.txt'), 'utf8')).toBe('ALPHA\n')
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('alpha\n')
    expect(git('status', '--porcelain')).toBe('')
    expect(collaborationView(harness.session).workers).toEqual([expect.objectContaining({ id: worker.id, isolated: true, hasUnmergedChanges: true })])
    expect(await harness.runtime.accept()).toBe('continue')
    expect(harness.session.collaboration.workers).toHaveLength(1)
    successful(await harness.runtime.tool(call('integrate_agent', { agent: worker.id })))
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('ALPHA\n')
    expect(readFileSync(join(project, 'b.txt'), 'utf8')).toBe('beta\n')
    expect(worker.worktree?.integratedTree).not.toBeNull()
    expect(collaborationView(harness.session).workers).toEqual([expect.objectContaining({ hasUnmergedChanges: false })])
    const diffs = () => harness.io.updates.flatMap((update) => update.sessionUpdate === 'tool_call' && update.toolCallId.startsWith(`integrate-${worker.id}`) ? update.content ?? [] : [])
    expect(diffs()).toEqual([{ type: 'diff', path: join(project, 'a.txt'), oldText: 'alpha\n', newText: 'ALPHA\n' }])
    successful(await harness.runtime.tool(call('integrate_agent', { agent: worker.id })))
    expect(diffs()).toHaveLength(1)
    const nested = harness.io.updates.filter((update) => (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') && update._meta?.diffra && typeof update._meta.diffra === 'object' && PARENT_TOOL_CALL_META_KEY in update._meta.diffra && update._meta.diffra[PARENT_TOOL_CALL_META_KEY] === worker.cardId)
    expect(nested.length).toBeGreaterThan(0)
    for (const update of nested) expect('toolCallId' in update && update.toolCallId.startsWith(`${worker.id}/`)).toBe(true)
  }, TEST_TIMEOUT_MS)

  test('整合重新检查实际文件范围，超范围的 worktree 整批保留且不部分写入项目', async () => {
    const { model } = routedModel({ 'SCOPED': [replace('a.txt', 'alpha', 'ALPHA'), report('完成范围内实现')] })
    const harness = await makeHarness(model)
    const worker = await delegate(harness, 'SCOPED', { role: 'implementer', files: ['a.txt'] })
    await settled(harness, [worker])
    const worktree = worker.worktree
    if (!worktree) throw new Error('可写工人没有独立 worktree')
    assertNoLinks(worktree.dir)
    // 模拟命令或外部进程留下的越界产物，不能只信 worker 自报的 edited 列表。
    writeFileSync(join(worktree.cwd, 'b.txt'), 'out-of-scope\n')
    refused(await harness.runtime.tool(call('integrate_agent', { agent: worker.id })), /超出允许的写入范围/)
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('alpha\n')
    expect(readFileSync(join(project, 'b.txt'), 'utf8')).toBe('beta\n')
    expect(readFileSync(join(worktree.cwd, 'a.txt'), 'utf8')).toBe('ALPHA\n')
    expect(readFileSync(join(worktree.cwd, 'b.txt'), 'utf8')).toBe('out-of-scope\n')
    expect(worktree.integratedTree).toBeNull()
  }, TEST_TIMEOUT_MS)

  test('整合冲突不覆盖用户修改、不丢工人结果；其它工人的无冲突改动仍能整合', async () => {
    const { model } = routedModel({
      'CONFLICT': [replace('a.txt', 'alpha', 'worker alpha'), report('工人修改 a')],
      'INDEPENDENT': [replace('b.txt', 'beta', 'worker beta'), report('工人修改 b')],
    })
    const harness = await makeHarness(model)
    const first = await delegate(harness, 'CONFLICT', { role: 'implementer', files: ['a.txt'] })
    const second = await delegate(harness, 'INDEPENDENT', { role: 'implementer', files: ['b.txt'] })
    await settled(harness, [first, second])
    writeFileSync(join(project, 'a.txt'), 'user alpha\n')
    refused(await harness.runtime.tool(call('integrate_agent', { agent: first.id })), /冲突/)
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('user alpha\n')
    expect(readFileSync(join(first.worktree?.cwd ?? '', 'a.txt'), 'utf8')).toBe('worker alpha\n')
    expect(first.worktree?.integratedTree).toBeNull()
    successful(await harness.runtime.tool(call('integrate_agent', { agent: second.id })))
    expect(readFileSync(join(project, 'b.txt'), 'utf8')).toBe('worker beta\n')
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('user alpha\n')
  }, TEST_TIMEOUT_MS)

  test('只中断一个工人，其它工人继续；被中断的工人可以单独重试', async () => {
    const firstGate = gate()
    const secondGate = gate()
    const { model } = routedModel({
      'CANCEL-ME': [{ ...report('不应在取消后算完成'), gate: firstGate }, report('重试完成')],
      'KEEP-RUNNING': [{ ...report('另一工人正常完成'), gate: secondGate }],
    })
    const harness = await makeHarness(model)
    const first = await delegate(harness, 'CANCEL-ME')
    const second = await delegate(harness, 'KEEP-RUNNING')
    await vi.waitFor(() => expect(firstGate.entered && secondGate.entered).toBe(true), { timeout: WORKER_TIMEOUT_MS })
    successful(await harness.runtime.tool(call('interrupt_agent', { agent: first.id })))
    await settled(harness, [first])
    expect(first.status).toBe('interrupted')
    expect(lastCard(harness, first)).toMatchObject({ status: 'failed' })
    expect(second.status).toBe('running')
    expect(harness.controller.signal.aborted).toBe(false)
    secondGate.release()
    await settled(harness, [second])
    expect(second).toMatchObject({ status: 'completed', activation: 1, summary: '另一工人正常完成' })
    await harness.runtime.control({ action: 'retry', workerId: first.id })
    await settled(harness, [first])
    expect(first).toMatchObject({ status: 'completed', activation: 2, summary: '重试完成' })
  }, TEST_TIMEOUT_MS)

  test('权限确认归属于对应工人，拒绝写命令不会执行，另一个工人仍正常结束', async () => {
    const pending = gate()
    const { model } = routedModel({
      'DENIED': [{ toolCalls: [exec('echo rejected > a.txt')], gate: pending }, report('写入被拒绝，未修改文件')],
      'ALLOWED': [report('其它工人已完成')],
    })
    const harness = await makeHarness(model)
    harness.io.requestPermission = async (request) => { harness.io.permissions.push(structuredClone(request)); return 'reject' }
    const denied = await delegate(harness, 'DENIED', { role: 'implementer', files: ['a.txt'] })
    const other = await delegate(harness, 'ALLOWED')
    await vi.waitFor(() => expect(pending.entered).toBe(true), { timeout: WORKER_TIMEOUT_MS })
    pending.release()
    await settled(harness, [denied, other])
    expect(harness.io.permissions).toHaveLength(1)
    const request = itemAt(harness.io.permissions)
    expect(request).toMatchObject({
      title: '执行 echo rejected > a.txt',
      _meta: { diffra: { [AGENT_META_KEY]: { id: denied.id, name: denied.name }, [PARENT_TOOL_CALL_META_KEY]: denied.cardId } },
    })
    expect(request.toolCallId.startsWith(`${denied.id}/`)).toBe(true)
    expect(readFileSync(join(denied.worktree?.cwd ?? '', 'a.txt'), 'utf8')).toBe('alpha\n')
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('alpha\n')
    expect(denied.edited).toEqual([])
    expect(other).toMatchObject({ status: 'completed', summary: '其它工人已完成' })
    expect(denied.messages.some((message) => message.role === 'tool' && message.content.some((part) => part.type === 'tool-result' && part.output.type === 'error-text'))).toBe(true)
  }, TEST_TIMEOUT_MS)

  test('没有有效 report 就耗尽步数的工人失败，卡片不能显示 completed', async () => {
    const { model } = routedModel({ 'NO-REPORT': [{ text: '还没有结果' }, { toolCalls: [{ name: 'report', input: { summary: '' } }] }] })
    const harness = await makeHarness(model, { maxSteps: 2 })
    const worker = await delegate(harness, 'NO-REPORT')
    await settled(harness, [worker])
    expect(worker.status).toBe('failed')
    expect(worker.summary).toContain('step limit')
    expect(lastCard(harness, worker)).toMatchObject({ status: 'failed' })
    expect(await harness.runtime.collect()).toBe(true)
    expect(messagesText(harness.session.messages)).toContain('failed')
  }, TEST_TIMEOUT_MS)

  test('共享任务通过工具执行 DAG、修订号抢占和成员权限；未完成任务阻止验收', async () => {
    const { model } = routedModel({ 'OWNER-A': [report('等待任务')], 'OWNER-B': [report('等待任务')] })
    const harness = await makeHarness(model)
    const first = await delegate(harness, 'OWNER-A')
    const second = await delegate(harness, 'OWNER-B')
    await settled(harness, [first, second])
    const tool = (name: string, input: unknown, caller = 'lead') => harness.runtime.tool(call(name, input), caller)
    successful(await tool('team_task_create', { subject: '实现', writeScopes: ['src'] }))
    const implementation = itemAt(harness.session.collaboration.tasks)
    successful(await tool('team_task_create', { subject: '验证', blockedBy: [implementation.id], writeScopes: ['src/test.ts'] }, first.id))
    const verification = itemAt(harness.session.collaboration.tasks, 1)
    const update = (taskId: string, expectedRevision: number, action: string, extra = {}) => ({ taskId, expectedRevision, action, ...extra })
    refused(await tool('team_task_update', update(verification.id, 1, 'claim'), second.id), /依赖/)
    successful(await tool('team_task_update', update(implementation.id, 1, 'claim'), first.id))
    refused(await tool('team_task_update', update(implementation.id, 1, 'claim'), second.id), /修订号冲突/)
    refused(await tool('team_task_update', update(implementation.id, 2, 'edit', { subject: '越权修改' }), second.id), /自己负责/)
    refused(await tool('team_task_update', update(implementation.id, 2, 'reassign', { owner: second.id }), first.id), /只有主智能体/)
    refused(await tool('team_task_update', update(implementation.id, 2, 'set_dependencies', { blockedBy: [verification.id] })), /环|循环/)
    expect(implementation).toMatchObject({ revision: 2, owner: first.id, blockedBy: [] })
    refused(await tool('team_task_create', { subject: '冒充成员' }, 'unknown-member'), /成员不存在/)
    refused(await tool('interrupt_agent', { agent: first.id }, second.id), /只有主智能体/)
    refused(await tool('integrate_agent', { agent: first.id }, second.id), /只有主智能体/)
    refused(await tool('wait_agents', { agents: [first.id], timeout_ms: 10 }, first.id), /不能等待自己/)
    refused(await tool('send_message', { agent: first.id, message: '自发消息' }, first.id), /不能给自己/)

    successful(await tool('team_task_update', update(implementation.id, 2, 'complete'), first.id))
    expect(JSON.parse(successful(await tool('team_task_list', {})))).toEqual(expect.arrayContaining([expect.objectContaining({ id: verification.id, ready: true })]))
    successful(await tool('team_task_update', update(verification.id, 1, 'claim'), second.id))
    expect(await harness.runtime.accept()).toBe('blocked')
    expect(harness.session.collaboration.acceptance.reason).toContain('验证')
    successful(await tool('team_task_update', update(verification.id, 2, 'complete'), second.id))
    expect(verification).toMatchObject({ owner: second.id, status: 'completed', revision: 3 })
    expect(await harness.runtime.accept()).toBe('passed')
    expect(harness.session.collaboration.workers.map((worker) => worker.activation)).toEqual([1, 1])
  }, TEST_TIMEOUT_MS)

  test('保存使用深拷贝；恢复把 running 变 interrupted，不自动重跑，续聊和结果回执均不重复', async () => {
    const pending = gate()
    const { model, calls } = routedModel({
      'RESTORE': [
        { text: '恢复前已完成的思考' },
        { text: '尚未完成的模型请求', gate: pending },
        { toolCalls: [{ name: 'send_message', input: { agent: 'lead', message: '恢复后的唯一回信' } }] },
        report('恢复后完成'),
      ],
    })
    const original = await makeHarness(model)
    const worker = await delegate(original, 'RESTORE')
    await vi.waitFor(() => expect(pending.entered).toBe(true), { timeout: WORKER_TIMEOUT_MS })
    successful(await original.runtime.tool(call('send_message', { agent: worker.id, message: '待恢复投递的消息' })))
    const record = original.io.saved
    if (!record?.collaboration) throw new Error('协作没有持久化')
    expect(record.collaboration).not.toBe(original.session.collaboration)
    expect(record.collaboration.messages).not.toBe(original.session.collaboration.messages)
    expect(itemAt(record.collaboration.workers).status).toBe('running')
    expect(messagesText(itemAt(record.collaboration.workers).messages)).toContain('恢复前已完成的思考')
    original.controller.abort()
    await original.runtime.close()
    expect(itemAt(record.collaboration.workers).status).toBe('running')

    const restored = await makeHarness(model, { record })
    const recovered = itemAt(restored.session.collaboration.workers)
    expect(recovered).toMatchObject({ id: worker.id, activation: 1, status: 'interrupted' })
    expect(calls).toHaveLength(2)
    expect(restored.runtime.hasWork()).toBe(false)
    await restored.runtime.control({ action: 'retry', workerId: recovered.id })
    await settled(restored, [recovered])
    expect(recovered).toMatchObject({ status: 'completed', activation: 2, summary: '恢复后完成' })
    const continuation = itemAt(model.doStreamCalls, 2)
    expect(JSON.stringify(continuation.prompt)).toContain('恢复前已完成的思考')
    expect(recovered.messages.filter((message) => message.role === 'user' && messagesText([message]).includes('待恢复投递的消息'))).toHaveLength(1)
    expect(await restored.runtime.collect()).toBe(true)
    const receipts = messagesText(restored.session.messages)
    expect(receipts.match(/Worker result/g)).toHaveLength(1)
    expect(receipts.match(/恢复后的唯一回信/g)).toHaveLength(1)
    expect(await restored.runtime.collect()).toBe(false)
    expect(messagesText(restored.session.messages)).toBe(receipts)
    const finalRecord = restored.io.saved
    if (!finalRecord) throw new Error('恢复后的结果没有持久化')
    const reopened = await makeHarness(model, { record: finalRecord })
    expect(await reopened.runtime.collect()).toBe(false)
    expect(messagesText(reopened.session.messages)).toBe(receipts)
    expect(calls).toHaveLength(4)
    expect(recovered.notifiedRevision).toBe(recovered.resultRevision)
  }, TEST_TIMEOUT_MS)
})

describe('独立审查和实际测试验收', () => {
  test.each(['actual-command', 'tester-claim-only', 'tester-command-failed', 'tester-modified-source', 'configured-check-omitted', 'reviewer-claim-only', 'reviewer-changes-required'] as const)('%s：同一份已整合改动不能仅凭 passed 声明完成', async (scenario) => {
    const reviewer = scenario === 'reviewer-claim-only'
      ? [report('声称已经审查', 'passed')]
      : [{ toolCalls: [exec('cat a.txt && git diff -- a.txt')] }, report('独立审查结果', scenario === 'reviewer-changes-required' ? 'changes_required' : 'passed')]
    const tester = scenario === 'tester-claim-only'
      ? [report('声称测试全部通过', 'passed')]
      : scenario === 'configured-check-omitted'
      ? [{ toolCalls: [exec('cat a.txt')] }, report('只读了源文件，未执行配置的验证命令', 'passed')]
      : [
          { toolCalls: [exec(scenario === 'tester-modified-source' ? "printf 'changed by tester\\n' > a.txt" : 'cat a.txt')] },
          { toolCalls: [exec(scenario === 'tester-command-failed' ? 'echo failed-check && false' : CHECK_COMMAND)] },
          report('实际验证结果', 'passed'),
        ]
    const { model } = routedModel({
      'ACCEPT-IMPL': [replace('a.txt', 'alpha', 'ALPHA'), report('实现完成')],
      'Independently review the integrated project': reviewer,
      'Independently verify the integrated project': tester,
    })
    const harness = await makeHarness(model, { checks: { afterEdit: null, beforeFinish: CHECK_COMMAND } })
    const implementer = await delegate(harness, 'ACCEPT-IMPL', { role: 'implementer', files: ['a.txt'] })
    await settled(harness, [implementer])
    expect(implementer.status).toBe('completed')
    await harness.runtime.integrate(implementer.id)
    expect(harness.session.collaboration.acceptance.status).toBe('pending')
    expect(await harness.runtime.accept()).toBe('continue')
    const reviewWorker = harness.session.collaboration.workers.find((worker) => worker.role === 'reviewer')
    expect(reviewWorker).toMatchObject({ status: 'completed', readOnly: true })
    expect(reviewWorker?.worktree).toBeNull()
    expect(harness.session.collaboration.workers.filter((worker) => worker.role === 'tester')).toHaveLength(0)
    if (scenario === 'reviewer-changes-required' || scenario === 'reviewer-claim-only') {
      expect(await harness.runtime.accept()).toBe('blocked')
      expect(harness.session.collaboration.acceptance.status).toBe('blocked')
      expect(harness.session.collaboration.acceptance.reason).toContain('独立审查')
      expect(harness.session.collaboration.workers.filter((worker) => worker.role === 'tester')).toHaveLength(0)
      return
    }
    expect(await harness.runtime.accept()).toBe('continue')
    const testWorker = harness.session.collaboration.workers.find((worker) => worker.role === 'tester')
    expect(testWorker).toMatchObject(scenario === 'tester-modified-source' ? { status: 'failed', verdict: 'changes_required' } : { status: 'completed', verdict: 'passed' })
    expect(testWorker?.worktree?.cwd).not.toBe(project)
    expect(readFileSync(join(testWorker?.worktree?.cwd ?? '', 'a.txt'), 'utf8')).toBe(scenario === 'tester-modified-source' ? 'changed by tester\n' : 'ALPHA\n')
    if (scenario === 'tester-modified-source') expect(testWorker?.issues).toContain('验证期间修改了文件')
    const expected = scenario === 'actual-command' ? 'passed' : 'blocked'
    expect(await harness.runtime.accept()).toBe(expected)
    expect(harness.session.collaboration.acceptance.status).toBe(expected)
    if (scenario === 'actual-command') {
      expect(reviewWorker?.checks).toEqual(expect.arrayContaining([expect.objectContaining({ succeeded: true })]))
      expect(testWorker?.checks).toEqual(expect.arrayContaining([expect.objectContaining({ command: expect.stringContaining(CHECK_COMMAND), succeeded: true })]))
      expect(testWorker?.checks.some((check) => !check.succeeded)).toBe(false)
      expect(messagesText(testWorker?.messages ?? [])).toContain('ALPHA')
      expect(await harness.runtime.accept()).toBe('passed')
      expect(harness.session.collaboration.workers).toHaveLength(3)
    } else if (scenario === 'tester-claim-only') expect(testWorker?.checks).toEqual([])
    else if (scenario === 'tester-command-failed') expect(testWorker?.checks).toEqual(expect.arrayContaining([expect.objectContaining({ succeeded: false })]))
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('ALPHA\n')
  }, TEST_TIMEOUT_MS)
})
