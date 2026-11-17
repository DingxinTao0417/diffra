import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { Checkpoints } from '../src/checkpoint.js'
import { findBash, findRipgrep } from '../src/environment.js'
import { AGENT_META_KEY, type AgentCardMeta, type AgentTag, PARENT_TOOL_CALL_META_KEY } from '../src/protocol.js'
import { DELEGATE_TOOL, MAX_WORKERS_PER_TURN } from '../src/session/agents.js'
import { runTurn, type TurnIO } from '../src/session/loop.js'
import { buildSystemPrompt } from '../src/session/prompt.js'
import { Session } from '../src/session/session.js'
import { type AgentType, EXPLORE_AGENT, loadAgentTypes } from '../src/subagents.js'
import type { ModelCallUsage } from '../src/usage/log.js'
import { addFile, exec, read, replaceLines, serviceError } from './loop-helpers.js'

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>
type StreamPart = StreamResult['stream'] extends ReadableStream<infer Part> ? Part : never
type Step = ({ toolCalls: Array<{ name: string; input: unknown }> } | { text: string }) & { delayMs?: number; onStart?: () => void }

const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } }

function streamOf(step: Step, idPrefix: string): ReadableStream<StreamPart> {
  const chunks: StreamPart[] =
    'text' in step
      ? [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: step.text },
          { type: 'text-end', id: 't' },
          { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
        ]
      : [
          { type: 'stream-start', warnings: [] },
          ...step.toolCalls.map((call, index): StreamPart => ({ type: 'tool-call', toolCallId: `${idPrefix}-${index}`, toolName: call.name, input: JSON.stringify(call.input) })),
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
        ]
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

type PromptMessage = Parameters<MockLanguageModelV4['doStream']>[0]['prompt'][number]
const messageText = (message: PromptMessage | undefined) =>
  message && message.role === 'user' ? message.content.map((part) => (part.type === 'text' ? part.text : '')).join('') : ''
const isContext = (message: PromptMessage) => messageText(message).startsWith('[Diffra] Context')

// 按对话里第一条不是上下文的用户消息分派剧本：工人和主智能体的对话都从一条全量上下文消息开始，
// 接着工人的是它的任务，主智能体的是用户的话。每次调用记一行（谁、第几步），用来看工人是不是同时在跑
function routedModel(scripts: Record<string, Step[]>, main: Step[]) {
  const calls: string[] = []
  const used: Record<string, number> = {}
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const text = messageText(options.prompt.find((message) => message.role === 'user' && !isContext(message)))
      const key = Object.keys(scripts).find((marker) => text.includes(marker)) ?? 'main'
      const steps = key === 'main' ? main : scripts[key]!
      const index = used[key] ?? 0
      used[key] = index + 1
      const step = steps[index] ?? { text: '（剧本已结束）' }
      calls.push(`${key}#${index}`)
      step.onStart?.()
      if (step.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, step.delayMs)
          options.abortSignal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new DOMException('Aborted', 'AbortError'))
          })
        })
      }
      return { stream: streamOf(step, `${key}-${index}`) }
    },
  })
  return { model, calls }
}

function recordingIO(): TurnIO & { updates: SessionUpdate[]; permissions: Array<{ title: string; agent: unknown }>; usage: ModelCallUsage[] } {
  const io = {
    updates: [] as SessionUpdate[],
    permissions: [] as Array<{ title: string; agent: unknown }>,
    usage: [] as ModelCallUsage[],
    update: async (update: SessionUpdate) => {
      io.updates.push(update)
    },
    requestPermission: async (toolCall: { title?: string | null; _meta?: { [key: string]: unknown } | null }) => {
      io.permissions.push({ title: toolCall.title ?? '', agent: (toolCall._meta?.diffra as Record<string, unknown> | undefined)?.[AGENT_META_KEY] })
      return 'allow_once'
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
  project = mkdtempSync(join(tmpdir(), 'diffra-agents-'))
  checkpointDir = mkdtempSync(join(tmpdir(), 'diffra-agents-cp-'))
  writeFileSync(join(project, 'a.txt'), 'alpha\n')
  writeFileSync(join(project, 'b.txt'), 'beta\n')
})

afterEach(() => {
  rmSync(project, { recursive: true, force: true })
  rmSync(checkpointDir, { recursive: true, force: true })
})

async function makeSession(model: MockLanguageModelV4, agentTypes: AgentType[] = []) {
  const bashPath = await findBash()
  const rules = { packs: [] }
  const checks = { afterEdit: null, beforeFinish: null }
  return new Session({
    cwd: project,
    config: {
      model: { endpoint: { protocol: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', apiKey: 'k' }, modelId: 'mock', contextWindow: 100_000, provider: null },
      reviewModel: null,
      planModel: null,
      fallbackModel: null,
      checks,
      readOnlyPaths: [],
      rules,
      permissionMode: 'ask',
      security: {},
      limits: { compactAtPercent: 70, maxSteps: 30, goalMaxRounds: 5 },
      plugins: [],
      checkpointDir,
    },
    environment: { bashPath, rgPath: await findRipgrep() },
    checkpoints: await Checkpoints.open(checkpointDir, project, []),
    rulePacks: [],
    systemPrompt: await buildSystemPrompt(bashPath, { checks, readOnlyPaths: [], rules }, []),
    workerPrompt: await buildSystemPrompt(bashPath, { checks, readOnlyPaths: [], rules }, [], { skills: [], frontend: null, worker: true }),
    model,
    agentTypes,
  })
}

const diffraOf = (update: SessionUpdate) => (update._meta?.diffra ?? {}) as Record<string, unknown>
const cards = (io: { updates: SessionUpdate[] }) =>
  io.updates.flatMap((update) => (update.sessionUpdate === 'tool_call' && diffraOf(update)[AGENT_META_KEY] && !diffraOf(update)[PARENT_TOOL_CALL_META_KEY] ? [update] : []))
const nested = (io: { updates: SessionUpdate[] }, cardId: string) =>
  io.updates.filter((update) => (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') && diffraOf(update)[PARENT_TOOL_CALL_META_KEY] === cardId)
const lastCardUpdate = (io: { updates: SessionUpdate[] }, cardId: string) =>
  io.updates.flatMap((update) => (update.sessionUpdate === 'tool_call_update' && update.toolCallId === cardId && update.status ? [update] : [])).at(-1)
const textOf = (update: SessionUpdate | undefined) =>
  update && 'content' in update && Array.isArray(update.content) ? update.content.map((item) => (item.type === 'content' && item.content.type === 'text' ? item.content.text : '')).join('') : ''
const toolResults = (session: Session) =>
  session.messages.flatMap((message) => (message.role === 'tool' ? message.content.flatMap((part) => (part.type === 'tool-result' ? [JSON.stringify(part.output)] : [])) : [])).join('\n')

describe('子智能体', () => {
  test('两个工人同时改各自认领的文件，结果交回主智能体；工具调用带所属卡片和工人，用量记成子智能体', async () => {
    const { model, calls } = routedModel(
      {
        'WORKER-A': [
          { toolCalls: [read('a.txt')], delayMs: 50 },
          { toolCalls: [replaceLines('a.txt', 'alpha', 'ALPHA')] },
          { toolCalls: [{ name: 'report', input: { summary: '改好了 a.txt' } }] },
        ],
        'WORKER-B': [
          { toolCalls: [read('b.txt')], delayMs: 50 },
          { toolCalls: [replaceLines('b.txt', 'beta', 'BETA')] },
          { toolCalls: [{ name: 'report', input: { summary: '改好了 b.txt', issues: '没跑测试' } }] },
        ],
      },
      [
        {
          toolCalls: [
            { name: DELEGATE_TOOL, input: { name: '甲', task: 'WORKER-A：把 a.txt 改成大写', files: ['a.txt'] } },
            { name: DELEGATE_TOOL, input: { name: '乙', task: 'WORKER-B：把 b.txt 改成大写', files: ['b.txt'] } },
          ],
        },
        { text: '两个文件都改好了' },
      ],
    )
    const session = await makeSession(model)
    const io = recordingIO()
    expect(await runTurn(session, { id: 't1', text: '把两个文件都改成大写' }, io)).toBe('end_turn')
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('ALPHA\n')
    expect(readFileSync(join(project, 'b.txt'), 'utf8')).toBe('BETA\n')
    // 两个工人的第一步都在任何一个工人的第二步之前：同时在跑
    expect(calls.indexOf('WORKER-B#0')).toBeLessThan(calls.indexOf('WORKER-A#1'))
    expect(calls.indexOf('WORKER-A#0')).toBeLessThan(calls.indexOf('WORKER-B#1'))
    // 工人自己从头开对话：第一条是全量的上下文消息，第二条是任务
    const workerA = model.doStreamCalls.find((call) => call.prompt.some((message) => messageText(message).startsWith('WORKER-A')))!
    const [context, task] = workerA.prompt.filter((message) => message.role === 'user')
    expect(messageText(context)).toMatch(/^\[Diffra\] Context for this task/)
    expect(messageText(context)).toContain(`<cwd>${project}</cwd>`)
    expect(messageText(task)).toBe('WORKER-A：把 a.txt 改成大写\n\nFiles you own: a.txt')

    const [first, second] = cards(io)
    const firstMeta = diffraOf(first!)[AGENT_META_KEY] as AgentCardMeta
    const secondMeta = diffraOf(second!)[AGENT_META_KEY] as AgentCardMeta
    expect([firstMeta.name, secondMeta.name]).toEqual(['甲', '乙'])
    expect(firstMeta.files).toEqual(['a.txt'])
    expect(firstMeta.color).not.toBe(secondMeta.color)
    // 工人的工具调用：id 带工人前缀，标了所属卡片和工人
    const inner = nested(io, first!.toolCallId)
    expect(inner.length).toBeGreaterThan(0)
    for (const update of inner) {
      expect('toolCallId' in update && update.toolCallId.startsWith(`${firstMeta.id}/`)).toBe(true)
      expect((diffraOf(update)[AGENT_META_KEY] as AgentTag).name).toBe('甲')
    }
    expect(lastCardUpdate(io, first!.toolCallId)?.status).toBe('completed')
    expect(textOf(lastCardUpdate(io, second!.toolCallId))).toContain('待处理：没跑测试')
    const results = toolResults(session)
    expect(results).toContain('Worker \\"甲\\" reported')
    expect(results).toContain('Changed files: a.txt.')
    expect(io.usage.filter((call) => call.role === 'subagent')).toHaveLength(6)
    expect(io.usage.filter((call) => call.role === 'coder')).toHaveLength(2)
  })

  test('认领：改别人认领的文件被拒，没人认领的自动认领；一开始就重叠的认领不派那个工人', async () => {
    const { model } = routedModel(
      {
        'WORKER-A': [
          { toolCalls: [read('a.txt')] },
          // 乙试完之前甲一直占着 a.txt
          { toolCalls: [{ name: 'report', input: { summary: '看过了' } }], delayMs: 1500 },
        ],
        'WORKER-B': [
          { toolCalls: [read('a.txt')] },
          { toolCalls: [replaceLines('a.txt', 'alpha', 'hacked')] },
          { toolCalls: [{ name: 'claim_files', input: { files: ['a.txt', 'docs'] } }] },
          { toolCalls: [addFile('c.txt', 'new')] },
          { toolCalls: [{ name: 'report', input: { summary: '建了 c.txt' } }] },
        ],
      },
      [
        {
          toolCalls: [
            { name: DELEGATE_TOOL, input: { name: '甲', task: 'WORKER-A：看看 a.txt', files: ['a.txt'] } },
            { name: DELEGATE_TOOL, input: { name: '乙', task: 'WORKER-B：建 c.txt', files: ['b.txt'] } },
            { name: DELEGATE_TOOL, input: { name: '丙', task: 'WORKER-C：也要 a.txt', files: [process.platform === 'win32' ? './A.TXT' : './a.txt'] } },
          ],
        },
        { text: '好了' },
      ],
    )
    const session = await makeSession(model)
    const io = recordingIO()
    await runTurn(session, { id: 't1', text: '分工' }, io)
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('alpha\n')
    expect(readFileSync(join(project, 'c.txt'), 'utf8')).toBe('new\n')
    const [, second] = cards(io)
    const bText = nested(io, second!.toolCallId).map(textOf).join('\n')
    expect(bText).toContain('a.txt is owned by worker "甲"')
    expect(bText).toContain('已认领：docs')
    expect(bText).toContain('未认领：a.txt (owned by "甲")')
    // 卡片上的认领清单含自动认领的 c.txt
    const bMeta = diffraOf(lastCardUpdate(io, second!.toolCallId)!)[AGENT_META_KEY] as AgentCardMeta
    expect(bMeta.files).toEqual(['b.txt', 'docs', 'c.txt'])
    const results = toolResults(session)
    // Windows 上换个大小写也算同一个文件
    expect(results).toMatch(/Worker \\"丙\\" was not started: a\.txt is already owned by worker \\"甲\\"/i)
  })

  // 工人甲故意晚 4 秒才回（占着 a.txt 等乙跑命令），默认 5 秒只剩不到 1 秒给建会话、打检查点和经 bash 跑命令，Windows CI 上不够
  test('工人跑的命令改到别人认领的文件，告诉主智能体；权限确认带上是哪个工人', async () => {
    const { model } = routedModel(
      {
        'WORKER-A': [{ toolCalls: [{ name: 'report', input: { summary: '占着 a.txt' } }], delayMs: 4000 }],
        'WORKER-B': [{ toolCalls: [exec('echo changed > a.txt')] }, { toolCalls: [{ name: 'report', input: { summary: '跑了命令' } }] }],
      },
      [
        {
          toolCalls: [
            { name: DELEGATE_TOOL, input: { name: '甲', task: 'WORKER-A：占着', files: ['a.txt'] } },
            { name: DELEGATE_TOOL, input: { name: '乙', task: 'WORKER-B：跑命令', files: ['b.txt'] } },
          ],
        },
        { text: '好了' },
      ],
    )
    const session = await makeSession(model)
    const io = recordingIO()
    await runTurn(session, { id: 't1', text: '跑命令' }, io)
    expect(io.permissions).toHaveLength(1)
    expect(io.permissions[0]!.title).toBe('执行 echo changed > a.txt')
    expect((io.permissions[0]!.agent as AgentTag).name).toBe('乙')
    expect(readFileSync(join(project, 'a.txt'), 'utf8').trim()).toBe('changed')
    const results = toolResults(session)
    expect(results).toContain('Its commands also changed files owned by other workers: a.txt (owned by \\"甲\\")')
  }, 20_000)

  test('两个工人同时要确认权限时排队：同一时间只有一个请求在等用户（界面一个任务只显示一张确认卡）', async () => {
    const { model } = routedModel(
      {
        'WORKER-A': [{ toolCalls: [exec('echo a > a2.txt')] }, { toolCalls: [{ name: 'report', input: { summary: 'a 好了' } }] }],
        'WORKER-B': [{ toolCalls: [exec('echo b > b2.txt')] }, { toolCalls: [{ name: 'report', input: { summary: 'b 好了' } }] }],
      },
      [
        {
          toolCalls: [
            { name: DELEGATE_TOOL, input: { name: '甲', task: 'WORKER-A：写 a2.txt', files: ['a2.txt'] } },
            { name: DELEGATE_TOOL, input: { name: '乙', task: 'WORKER-B：写 b2.txt', files: ['b2.txt'] } },
          ],
        },
        { text: '都写好了' },
      ],
    )
    const session = await makeSession(model)
    let pending = 0
    let maxPending = 0
    const asked: string[] = []
    const io = {
      ...recordingIO(),
      requestPermission: async (toolCall: { _meta?: { [key: string]: unknown } | null }) => {
        pending++
        maxPending = Math.max(maxPending, pending)
        asked.push(((toolCall._meta?.diffra as Record<string, unknown>)[AGENT_META_KEY] as AgentTag).name)
        await new Promise((resolve) => setTimeout(resolve, 300))
        pending--
        return 'allow_once'
      },
    }
    await runTurn(session, { id: 't1', text: '写两个文件' }, io)
    expect(asked.sort()).toEqual(['乙', '甲'])
    expect(maxPending).toBe(1)
    expect(readFileSync(join(project, 'a2.txt'), 'utf8').trim()).toBe('a')
    expect(readFileSync(join(project, 'b2.txt'), 'utf8').trim()).toBe('b')
  })

  test('自定义的工人类型：说明接进工人的提示词，只读类型只有只读命令和交结果的工具，主智能体的工具说明里列出类型；不认识的类型不派', async () => {
    mkdirSync(join(project, '.diffra', 'agents'), { recursive: true })
    writeFileSync(join(project, '.diffra', 'agents', 'explorer.md'), ['---', 'name: explorer', 'description: 只读地查代码', 'mode: read-only', '---', '只查不改，报告里写清文件和行号。', ''].join('\n'))
    // 没有说明的不算
    writeFileSync(join(project, '.diffra', 'agents', 'empty.md'), ['---', 'name: empty', '---', '没写 description', ''].join('\n'))
    const types = (await loadAgentTypes(project)).filter((type) => type.name === 'explorer' || type.name === 'empty')
    expect(types).toEqual([{ name: 'explorer', description: '只读地查代码', readOnly: true, instructions: '只查不改，报告里写清文件和行号。' }])

    const { model } = routedModel({ 'WORKER-X': [{ toolCalls: [{ name: 'report', input: { summary: '查完了' } }] }] }, [
      {
        toolCalls: [
          { name: DELEGATE_TOOL, input: { name: '查', task: 'WORKER-X：查一下 a.txt', agent: 'explorer' } },
          { name: DELEGATE_TOOL, input: { name: '错', task: 'WORKER-Y：不会派出去', agent: 'nope' } },
        ],
      },
      { text: '查完了' },
    ])
    const session = await makeSession(model, types)
    expect(await runTurn(session, { id: 't1', text: '查一下' }, recordingIO())).toBe('end_turn')

    const toolNames = (call: (typeof model.doStreamCalls)[number]) => (call.tools ?? []).map((item) => item.name)
    const worker = model.doStreamCalls.find((call) => JSON.stringify(call.prompt).includes('WORKER-X'))!
    expect(JSON.stringify(worker.prompt)).toContain('只查不改，报告里写清文件和行号。')
    expect(JSON.stringify(worker.prompt)).toContain('You are read-only')
    // 没有 apply_patch 和认领；exec_command 只许跑只读命令
    expect(toolNames(worker).sort()).toEqual(['exec_command', 'report', 'write_stdin'])
    const delegate = (model.doStreamCalls[0]?.tools ?? []).find((item) => item.name === DELEGATE_TOOL)
    expect(JSON.stringify(delegate)).toContain('explorer (read-only) — 只读地查代码')
    expect(toolResults(session)).toContain('Unknown worker type')
    expect(model.doStreamCalls.some((call) => JSON.stringify(call.prompt).includes('WORKER-Y：不会派出去') && !JSON.stringify(call.prompt).includes('WORKER-X'))).toBe(false)
  })

  test('停止时工人一起停；每轮最多派 8 个', async () => {
    const workers = Object.fromEntries(Array.from({ length: MAX_WORKERS_PER_TURN + 1 }, (_, index) => [`W${index}-`, [{ toolCalls: [{ name: 'report', input: { summary: `第 ${index} 个` } }] }] as Step[]]))
    const { model } = routedModel(workers, [
      { toolCalls: Array.from({ length: MAX_WORKERS_PER_TURN + 1 }, (_, index) => ({ name: DELEGATE_TOOL, input: { name: `工人${index}`, task: `W${index}-：报个到` } })) },
      { text: '都报到了' },
    ])
    const session = await makeSession(model)
    const io = recordingIO()
    await runTurn(session, { id: 't1', text: '多派几个' }, io)
    const results = toolResults(session)
    expect(results).toContain(`At most ${MAX_WORKERS_PER_TURN} workers per turn`)
    expect(results.match(/reported after/g)).toHaveLength(MAX_WORKERS_PER_TURN)

    const slow = routedModel(
      { 'WORKER-A': [{ toolCalls: [{ name: 'report', input: { summary: '不会到这里' } }], delayMs: 5000, onStart: () => setTimeout(() => stopping.activeTurn?.abort(), 50) }] },
      [{ toolCalls: [{ name: DELEGATE_TOOL, input: { name: '甲', task: 'WORKER-A：慢慢来' } }] }],
    )
    const stopping = await makeSession(slow.model)
    const stopIO = recordingIO()
    expect(await runTurn(stopping, { id: 't1', text: '慢' }, stopIO)).toBe('cancelled')
    const [card] = cards(stopIO)
    expect(lastCardUpdate(stopIO, card!.toolCallId)?.status).toBe('failed')
    expect(textOf(lastCardUpdate(stopIO, card!.toolCallId))).toContain('已停止')
  })
})

describe('探索工人和工人的防护', () => {
  const systemOf = (call: { prompt: Array<{ role: string; content: unknown }> }) => String(call.prompt.find((message) => message.role === 'system')?.content ?? '')
  const toolNames = (call: { tools?: Array<{ name: string }> }) => (call.tools ?? []).map((item) => item.name)

  test('内置的 explore 类型：只读、用工人自己的提示词、不认领文件、同一步的读同时跑；主智能体那边写明什么时候派、什么时候不派', async () => {
    const types = await loadAgentTypes(project)
    expect(types.find((type) => type.name === EXPLORE_AGENT)).toMatchObject({ readOnly: true })

    const { model } = routedModel(
      {
        'WORKER-E': [
          { toolCalls: [read('a.txt'), read('b.txt')] },
          // 只读工人硬要改文件：没有 apply_patch，会改文件的命令不执行
          { toolCalls: [replaceLines('a.txt', 'alpha', 'CHANGED'), exec("sed -i 's/alpha/CHANGED/' a.txt")] },
          { toolCalls: [{ name: 'report', input: { summary: 'a.txt:1 是 alpha，b.txt:1 是 beta' } }] },
        ],
      },
      [{ toolCalls: [{ name: DELEGATE_TOOL, input: { name: '查', task: 'WORKER-E：两个文件里各写了什么', agent: EXPLORE_AGENT, files: ['a.txt'] } }] }, { text: '查完了' }],
    )
    const session = await makeSession(model, types)
    const io = recordingIO()
    expect(await runTurn(session, { id: 't1', text: '这两个文件里是什么' }, io)).toBe('end_turn')

    const workerCalls = model.doStreamCalls.filter((call) => systemOf(call).includes('a worker agent'))
    const worker = workerCalls[0]!
    // 工人的提示词是单独组装的：没有步骤清单、提问、派工这些它用不了的东西
    expect(systemOf(worker)).not.toMatch(/update_plan|ask_user|delegate/)
    expect(systemOf(worker)).toContain('You are read-only')
    expect(systemOf(worker)).toContain('Report conclusions, not file dumps')
    // 项目目录不在系统提示词里，在工人对话第一条的上下文消息里
    expect(systemOf(worker)).not.toContain(project)
    expect(messageText(worker.prompt.find((message) => message.role === 'user'))).toContain(`<cwd>${project}</cwd>`)
    expect(toolNames(worker).sort()).toEqual(['exec_command', 'report', 'write_stdin'])
    expect(JSON.stringify(worker.prompt)).not.toContain('Files you own')
    expect(JSON.stringify(worker.prompt)).not.toContain('claim_files')

    // 读的结果交给了工人；改文件的两种办法都被拒
    expect(JSON.stringify(workerCalls[1]!.prompt)).toContain('alpha')
    expect(JSON.stringify(workerCalls[1]!.prompt)).toContain('beta')
    expect(JSON.stringify(workerCalls[2]!.prompt)).toContain("unavailable tool 'apply_patch'")
    expect(JSON.stringify(workerCalls[2]!.prompt)).toContain('You can only run read-only commands here')

    // 没认领文件，也没改到文件
    const [card] = cards(io)
    expect((diffraOf(card!)[AGENT_META_KEY] as AgentCardMeta).files).toEqual([])
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('alpha\n')
    expect(toolResults(session)).toContain('a.txt:1 是 alpha，b.txt:1 是 beta')

    // 两个读同时发起：都开始了才有第一个结果
    const inner = nested(io, card!.toolCallId).map((update) => update.sessionUpdate)
    expect(inner.slice(0, 2)).toEqual(['tool_call', 'tool_call'])

    const main = model.doStreamCalls[0]!
    const delegate = JSON.stringify((main.tools ?? []).find((item) => item.name === DELEGATE_TOOL))
    expect(delegate).toContain('explore (read-only)')
    expect(delegate).toContain('Do not use it when')
    expect(delegate).toContain('When unsure, do the work yourself')
    expect(systemOf(main)).toContain('explore worker')
    // 第 519 步：先自己看一眼项目，看出跨很多模块才派；评测里小题一开始就派了探索工人
    expect(delegate).toContain('you have not looked at the project yourself yet (list the files first: a small project does not need a worker)')
    expect(systemOf(main)).toContain('Start by looking at the project yourself: list the files (rg --files)')
    expect(systemOf(main)).toContain('for a small project or a change in a few files, do it yourself')
  })

  test('项目里同名的类型文件盖过内置的 explore', async () => {
    mkdirSync(join(project, '.diffra', 'agents'), { recursive: true })
    writeFileSync(join(project, '.diffra', 'agents', 'explore.md'), ['---', 'name: explore', 'description: 项目自己的探索', '---', '按项目的办法查。', ''].join('\n'))
    const types = (await loadAgentTypes(project)).filter((type) => type.name === EXPLORE_AGENT)
    expect(types).toEqual([{ name: EXPLORE_AGENT, description: '项目自己的探索', readOnly: false, instructions: '按项目的办法查。' }])
  })

  // 剧本：先说一句话，然后同一个调用连发 6 次；第 3 次之后提醒，提醒后再 3 次就该停下，走不到最后的 report
  async function runSpinningWorker(repeated: Step) {
    const { model } = routedModel(
      { 'WORKER-S': [{ text: '我先看 a.txt，里面应该是 alpha' }, ...Array.from({ length: 6 }, () => repeated), { toolCalls: [{ name: 'report', input: { summary: '不会走到这里' } }] }] },
      [{ toolCalls: [{ name: DELEGATE_TOOL, input: { name: '转', task: 'WORKER-S：看看 a.txt', agent: EXPLORE_AGENT } }] }, { text: '工人没查完' }],
    )
    const session = await makeSession(model, await loadAgentTypes(project))
    const io = recordingIO()
    expect(await runTurn(session, { id: 't1', text: '看看 a.txt' }, io)).toBe('end_turn')
    // 主智能体第二次请求的对话里也有这段任务文字（它自己那次 delegate 调用），按系统提示词认工人的请求
    return { session, io, workerCalls: model.doStreamCalls.filter((call) => systemOf(call).includes('a worker agent')) }
  }

  test('工人原地打转：同一个调用、同样的结果连着 3 次先提醒，提醒后还犯就停下这个工人，它写过的话带回给主智能体', async () => {
    // 轮询一个不存在的后台进程：每次的结果都一样
    const { session, io, workerCalls } = await runSpinningWorker({ toolCalls: [{ name: 'write_stdin', input: { session_id: 1 } }] })
    // 第 1 步说话、第 2–4 步三次同样的调用，第 5 步的请求里有提醒；再调三次后停下，不会有第 8 步
    expect(workerCalls).toHaveLength(7)
    expect(JSON.stringify(workerCalls[3]!.prompt)).not.toContain('You made the same call 3 times')
    expect(JSON.stringify(workerCalls[4]!.prompt)).toContain('You made the same call 3 times')
    expect(toolResults(session)).toContain('kept making the same call')
    expect(toolResults(session)).toContain('What it wrote before it stopped')
    expect(toolResults(session)).toContain('我先看 a.txt，里面应该是 alpha')
    const [card] = cards(io)
    expect(lastCardUpdate(io, card!.toolCallId)?.status).toBe('failed')
    expect(textOf(lastCardUpdate(io, card!.toolCallId))).toContain('停下前写的：我先看 a.txt，里面应该是 alpha')
  })

  test('工人反复跑同一条只读命令、输出一样（只有耗时不同）也算原地打转：提醒后还犯就停下', async () => {
    const { session, workerCalls } = await runSpinningWorker({ toolCalls: [read('a.txt')] })
    expect(JSON.stringify(workerCalls[4]!.prompt)).toContain('You made the same call 3 times')
    expect(workerCalls).toHaveLength(7)
    expect(toolResults(session)).toContain('kept making the same call')
  })

  // 流里没有状态码的错误会自动重发（第 513 步），这里用重发也没用的鉴权错误
  test('工人中途出错（重发也没用的错误）：出错前写的话带回给主智能体', async () => {
    const { model } = routedModel(
      {
        'WORKER-F': [
          { text: '入口在 a.txt 第 1 行' },
          {
            toolCalls: [],
            onStart: () => {
              throw serviceError(401)
            },
          },
        ],
      },
      [{ toolCalls: [{ name: DELEGATE_TOOL, input: { name: '错', task: 'WORKER-F：找入口', agent: EXPLORE_AGENT } }] }, { text: '工人出错了' }],
    )
    const session = await makeSession(model, await loadAgentTypes(project))
    const io = recordingIO()
    expect(await runTurn(session, { id: 't1', text: '入口在哪' }, io)).toBe('end_turn')
    expect(toolResults(session)).toContain('failed')
    expect(toolResults(session)).toContain('入口在 a.txt 第 1 行')
  })
})

describe('设计任务的子智能体', () => {
  test('派工人前在设计页认领节点，认领不到就不派；工人结束、这一轮结束都让设计页收尾；设计调用带上是哪个工人', async () => {
    const { model } = routedModel(
      {
        'WORKER-HEAD': [
          { toolCalls: [{ name: 'design_get_node', input: { id: '1:2' } }] },
          { toolCalls: [{ name: 'report', input: { summary: '看过页眉了' } }] },
        ],
      },
      [
        {
          toolCalls: [
            { name: DELEGATE_TOOL, input: { name: '头', task: 'WORKER-HEAD：画页眉', nodes: ['1:2'] } },
            { name: DELEGATE_TOOL, input: { name: '列', task: 'WORKER-LIST：画列表', nodes: ['1:9'] } },
          ],
        },
        { text: '好了' },
      ],
    )
    const session = await makeSession(model)
    session.design = { tools: [{ name: 'get_node', description: 'Get a node', inputSchema: { type: 'object' }, readOnly: true }], instructions: '' }
    const calls: Array<{ tool: string; agent: string | null }> = []
    const io = {
      ...recordingIO(),
      design: async (tool: string, args: unknown, _signal: AbortSignal, agent?: AgentTag) => {
        calls.push({ tool, agent: agent?.name ?? null })
        // 1:9 已经被别的工人占着
        if (tool === '__agent_claim') return { text: JSON.stringify({ refused: (args as { nodes: string[] }).nodes.includes('1:9') ? ['node 1:9 overlaps nodes owned by worker "别人"'] : [] }), image: null }
        return { text: JSON.stringify({ id: '1:2', name: '页眉' }), image: null }
      },
    }
    await runTurn(session, { id: 't1', text: '画首页' }, io)
    expect(calls).toEqual([
      { tool: '__agent_claim', agent: '头' },
      { tool: '__agent_claim', agent: '列' },
      // 认领不到的工人也收一次尾，释放可能认领到的部分
      { tool: '__agent_done', agent: '列' },
      { tool: 'get_node', agent: '头' },
      { tool: '__agent_done', agent: '头' },
      // 这一轮结束：收起主智能体的光标
      { tool: '__agent_done', agent: null },
    ])
    const results = toolResults(session)
    expect(results).toContain('Worker \\"列\\" was not started: node 1:9 overlaps nodes owned by worker \\"别人\\"')
    const [card] = cards(io)
    expect((diffraOf(card!)[AGENT_META_KEY] as AgentCardMeta).nodes).toEqual(['1:2'])
  })
})

describe('子智能体的模型没有输出', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('工人的模型很久没有输出时，提示和撤掉提示都带上是哪个工人，界面按工人分开记', async () => {
    vi.stubEnv('DIFFRA_MODEL_SILENCE_MS', '100')
    const { model } = routedModel(
      { 'WORKER-A': [{ toolCalls: [{ name: 'report', input: { summary: '看过了' } }], delayMs: 500 }] },
      [
        { toolCalls: [{ name: DELEGATE_TOOL, input: { name: '甲', task: 'WORKER-A：看一眼 a.txt' } }] },
        { text: '看过了' },
      ],
    )
    const session = await makeSession(model)
    const io = recordingIO()
    await runTurn(session, { id: 't1', text: '看一眼 a.txt' }, io)
    const silence = io.updates.filter((update) => update.sessionUpdate === 'session_info_update' && 'modelSilentSince' in diffraOf(update) && diffraOf(update)[AGENT_META_KEY])
    expect(silence.map((update) => diffraOf(update).modelSilentSince === null)).toEqual([false, true])
    for (const update of silence) expect((diffraOf(update)[AGENT_META_KEY] as AgentTag).name).toBe('甲')
  })
})
