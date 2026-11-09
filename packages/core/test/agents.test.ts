import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import type { ModelCallUsage } from '../src/usage/log.js'

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

// 按对话的第一条用户消息分派剧本：工人的对话从它的任务开始，主智能体的从用户的话开始。
// 每次调用记一行（谁、第几步），用来看工人是不是同时在跑
function routedModel(scripts: Record<string, Step[]>, main: Step[]) {
  const calls: string[] = []
  const used: Record<string, number> = {}
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const first = options.prompt.find((message) => message.role === 'user')
      const text = first && Array.isArray(first.content) ? first.content.map((part) => (part.type === 'text' ? part.text : '')).join('') : ''
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

async function makeSession(model: MockLanguageModelV4) {
  const bashPath = await findBash()
  const rules = { packs: [], review: false }
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
      security: { staticCheck: false, lightScan: false },
      limits: { compactAtPercent: 70, maxSteps: 30, goalMaxRounds: 5 },
      plugins: [],
      checkpointDir,
    },
    environment: { bashPath, rgPath: await findRipgrep() },
    checkpoints: await Checkpoints.open(checkpointDir, project, []),
    rulePacks: [],
    systemPrompt: await buildSystemPrompt(project, bashPath, { checks, readOnlyPaths: [], rules }, []),
    model,
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
          { toolCalls: [{ name: 'read_file', input: { path: 'a.txt' } }], delayMs: 50 },
          { toolCalls: [{ name: 'edit_file', input: { path: 'a.txt', old_string: 'alpha', new_string: 'ALPHA' } }] },
          { toolCalls: [{ name: 'report', input: { summary: '改好了 a.txt' } }] },
        ],
        'WORKER-B': [
          { toolCalls: [{ name: 'read_file', input: { path: 'b.txt' } }], delayMs: 50 },
          { toolCalls: [{ name: 'edit_file', input: { path: 'b.txt', old_string: 'beta', new_string: 'BETA' } }] },
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
        { toolCalls: [{ name: 'finish', input: { summary: '两个文件都改好了' } }] },
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

  test('认领：改别人认领的文件被拒，没人认领的自动认领；一开始就重叠的认领不派那个工人；主智能体不能借工人读过的记录直接改文件', async () => {
    const { model } = routedModel(
      {
        'WORKER-A': [
          { toolCalls: [{ name: 'read_file', input: { path: 'a.txt' } }] },
          // 乙试完之前甲一直占着 a.txt
          { toolCalls: [{ name: 'report', input: { summary: '看过了' } }], delayMs: 1500 },
        ],
        'WORKER-B': [
          { toolCalls: [{ name: 'read_file', input: { path: 'a.txt' } }] },
          { toolCalls: [{ name: 'edit_file', input: { path: 'a.txt', old_string: 'alpha', new_string: 'hacked' } }] },
          { toolCalls: [{ name: 'claim_files', input: { files: ['a.txt', 'docs'] } }] },
          { toolCalls: [{ name: 'edit_file', input: { path: 'c.txt', old_string: '', new_string: 'new\n' } }] },
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
        { toolCalls: [{ name: 'edit_file', input: { path: 'c.txt', old_string: 'new', new_string: 'main' } }] },
        { toolCalls: [{ name: 'finish', input: { summary: '好了' } }] },
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
    // 主智能体没读过 c.txt：不能借工人的记录直接改
    expect(results).toContain('Read c.txt with read_file before editing it.')
  })

  test('工人跑的命令改到别人认领的文件，告诉主智能体；权限确认带上是哪个工人', async () => {
    const { model } = routedModel(
      {
        'WORKER-A': [{ toolCalls: [{ name: 'report', input: { summary: '占着 a.txt' } }], delayMs: 4000 }],
        'WORKER-B': [
          { toolCalls: [{ name: 'run_command', input: { command: 'echo changed > a.txt' } }] },
          { toolCalls: [{ name: 'report', input: { summary: '跑了命令' } }] },
        ],
      },
      [
        {
          toolCalls: [
            { name: DELEGATE_TOOL, input: { name: '甲', task: 'WORKER-A：占着', files: ['a.txt'] } },
            { name: DELEGATE_TOOL, input: { name: '乙', task: 'WORKER-B：跑命令', files: ['b.txt'] } },
          ],
        },
        { toolCalls: [{ name: 'finish', input: { summary: '好了' } }] },
      ],
    )
    const session = await makeSession(model)
    const io = recordingIO()
    await runTurn(session, { id: 't1', text: '跑命令' }, io)
    expect(io.permissions).toHaveLength(1)
    expect((io.permissions[0]!.agent as AgentTag).name).toBe('乙')
    const results = toolResults(session)
    expect(results).toContain('Its commands also changed files owned by other workers: a.txt (owned by \\"甲\\")')
  })

  test('两个工人同时要确认权限时排队：同一时间只有一个请求在等用户（界面一个任务只显示一张确认卡）', async () => {
    const { model } = routedModel(
      {
        'WORKER-A': [
          { toolCalls: [{ name: 'run_command', input: { command: 'echo a > a2.txt' } }] },
          { toolCalls: [{ name: 'report', input: { summary: 'a 好了' } }] },
        ],
        'WORKER-B': [
          { toolCalls: [{ name: 'run_command', input: { command: 'echo b > b2.txt' } }] },
          { toolCalls: [{ name: 'report', input: { summary: 'b 好了' } }] },
        ],
      },
      [
        {
          toolCalls: [
            { name: DELEGATE_TOOL, input: { name: '甲', task: 'WORKER-A：写 a2.txt', files: ['a2.txt'] } },
            { name: DELEGATE_TOOL, input: { name: '乙', task: 'WORKER-B：写 b2.txt', files: ['b2.txt'] } },
          ],
        },
        { toolCalls: [{ name: 'finish', input: { summary: '都写好了' } }] },
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
        { toolCalls: [{ name: 'finish', input: { summary: '看过了' } }] },
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
