import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, sep } from 'node:path'
import type { PermissionOption, SessionUpdate, ToolCallUpdate } from '@agentclientprotocol/sdk'
import { APICallError, type ToolResultPart } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { McpPool } from '../src/mcp.js'
import { runTurn } from '../src/session/loop.js'
import { IMAGE_CHARS, messagesChars, type Session } from '../src/session/session.js'
import {
  addFile,
  exec,
  failingStream,
  lastTaskState,
  makeSession,
  project,
  read,
  recordingIO,
  replaceLines,
  scriptedModel,
  serviceError,
  type Step,
  stepStream,
  toolUpdates,
  turnOutcomes,
  useTempProject,
  verifications,
  withoutContext,
} from './loop-helpers.js'
import { testMcpServer } from './mcp-fixture.js'

// 主循环里的工具：项目钩子、步骤清单和提问、同一步的只读调用、命令输出、模型出错重试、参数写法、MCP、图片、后台命令
type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer Part> ? Part : never

useTempProject()

// 交给模型的工具结果，按顺序
const toolResults = (session: Session) =>
  session.messages.flatMap((message) => (message.role === 'tool' ? message.content.filter((part): part is ToolResultPart => part.type === 'tool-result') : []))
// 工具结果的文字，成功和出错都取
const resultText = (part: ToolResultPart | undefined) => (part && (part.output.type === 'text' || part.output.type === 'error-text') ? part.output.value : '')
const notices = (io: { updates: SessionUpdate[] }) => io.updates.flatMap((update) => (update.sessionUpdate === 'notice' ? [update.title] : []))
// 工具卡片的开始和结束，按出现顺序
const toolEvents = (io: { updates: SessionUpdate[] }, prefix = 'call-') =>
  io.updates.flatMap((update) =>
    (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') && update.toolCallId.startsWith(prefix)
      ? [`${update.sessionUpdate === 'tool_call' ? '开始' : '结束'} ${update.toolCallId}`]
      : [],
  )
const toolNames = (model: MockLanguageModelV4, call = 0) => model.doStreamCalls[call]?.tools?.map((item) => item.name) ?? []
// 跑完的工具卡片（结束时那条更新）
const completedCards = (io: { updates: SessionUpdate[] }) =>
  io.updates.flatMap((update) => (update.sessionUpdate === 'tool_call_update' && update.status === 'completed' ? [update] : []))

// 剧本的下一步要看前面的结果才定（比如 exec_command 返回的会话号）：next 拿到这次请求的对话文字和这是第几次调用
function reactiveModel(next: (prompt: string, call: number) => Step): MockLanguageModelV4 {
  let calls = 0
  return new MockLanguageModelV4({
    doStream: async (options) => {
      const index = calls++
      return stepStream(next(JSON.stringify(options.prompt), index), index)
    },
  })
}
// 对话里最近一次出现的后台进程会话号
const sessionIdIn = (prompt: string) => Number([...prompt.matchAll(/session ID (\d+)/g)].at(-1)?.[1])

// 1x1 的 PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

describe('项目钩子', () => {
  test('afterEdit 钩子改了刚写的文件时告诉模型重读；beforeCommand 退出码 2 拦下 exec_command、不执行，理由带上钩子的输出；别的命令照常跑', async () => {
    const model = scriptedModel([
      { toolCalls: [addFile('a.txt', 'x')] },
      { toolCalls: [exec('echo deploy > deployed.txt')] },
      { toolCalls: [exec('echo fine')] },
      { text: '好了' },
    ])
    const session = await makeSession(model)
    session.config = {
      ...session.config,
      hooks: { afterEdit: 'echo formatted >> "$DIFFRA_FILE"', beforeCommand: 'case "$DIFFRA_COMMAND" in *deploy*) echo "不许部署"; exit 2;; esac' },
    }
    session.permissionMode = 'full'
    const io = recordingIO()
    await expect(runTurn(session, { id: 't', text: '做一下' }, io)).resolves.toBe('end_turn')

    const results = toolResults(session)
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('x\nformatted\n')
    expect(results[0]?.output).toEqual({
      type: 'text',
      value: "Success. Updated the following files:\nA a.txt\n[The project's after-edit hook changed a.txt (for example a formatter). Read it again before patching it further.]",
    })
    expect(results[1]?.output).toEqual({ type: 'error-text', value: "Blocked by the project's before-command hook: 不许部署 Do not retry it unchanged." })
    expect(existsSync(join(project, 'deployed.txt'))).toBe(false)
    expect(resultText(results[2])).toMatch(/Process exited with code 0\nOutput:\nfine$/)
    expect(io.permissionRequests).toBe(0)
    expect(turnOutcomes(io)).toEqual([{ finish: 'unverified', stop: null }])
  }, 30_000)
})

describe('步骤清单和中途提问', () => {
  const plan = (statuses: Array<'pending' | 'in_progress' | 'completed'>, explanation?: string) => ({
    toolCalls: [{ name: 'update_plan', input: { ...(explanation ? { explanation } : {}), plan: statuses.map((status, index) => ({ step: `第 ${index + 1} 步`, status })) } }],
  })
  const stepCards = (io: { updates: SessionUpdate[] }) => io.updates.flatMap((update) => (update.sessionUpdate === 'tool_call' && update.title === '步骤' ? [update] : []))
  const cardText = (text: string) => [{ type: 'content', content: { type: 'text', text } }]

  test('update_plan：一轮一张步骤卡，每次更新整张替换；全部做完时卡片是完成；告诉模型做完了几步', async () => {
    const model = scriptedModel([plan(['in_progress', 'pending'], '先拆成两步'), plan(['completed', 'in_progress']), plan(['completed', 'completed']), { text: '做完了' }])
    const session = await makeSession(model)
    session.startTurn('turn-1', '分两步做')
    const io = recordingIO()
    await runTurn(session, { id: 'turn-1', text: '分两步做' }, io)

    expect(toolNames(model)).toContain('update_plan')
    expect(toolNames(model)).not.toContain('todo_write')
    const cards = stepCards(io)
    expect(cards.map((card) => card.toolCallId)).toEqual(['steps-turn-1', 'steps-turn-1', 'steps-turn-1'])
    expect(cards.map((card) => card.status)).toEqual(['in_progress', 'in_progress', 'completed'])
    expect(cards[1]?.content).toEqual(cardText('[x] 第 1 步\n[>] 第 2 步'))
    expect(toolResults(session).map(resultText)).toEqual(['Plan updated: 0 of 2 done.', 'Plan updated: 1 of 2 done.', 'Plan updated: 2 of 2 done.'])
    // 步骤卡不是改文件，结束门禁不出完成卡
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: null }])
  })

  test('过了结束门禁时步骤卡收尾：进行中的那步标成做完，没开始的照旧，不另花一次模型调用；没走完的上一轮的清单下一轮不动', async () => {
    const firstModel = scriptedModel([plan(['completed', 'in_progress', 'pending']), { text: '做完了' }])
    const session = await makeSession(firstModel)
    session.startTurn('turn-1', '分三步做')
    const first = recordingIO()
    await runTurn(session, { id: 'turn-1', text: '分三步做' }, first)
    expect(firstModel.doStreamCalls).toHaveLength(2)
    const settled = stepCards(first).at(-1)
    expect(stepCards(first)).toHaveLength(2)
    expect(settled?.toolCallId).toBe('steps-turn-1')
    expect(settled?.content).toEqual(cardText('[x] 第 1 步\n[x] 第 2 步\n[ ] 第 3 步'))

    // 第二轮列了清单后模型出错停下：没过结束门禁，清单停在进行中
    session.model = new MockLanguageModelV4({ doStream: [stepStream(plan(['in_progress']), 0), failingStream(null, serviceError(401))] })
    session.startTurn('turn-2', '列一步就停')
    const second = recordingIO()
    await runTurn(session, { id: 'turn-2', text: '列一步就停' }, second)
    expect(turnOutcomes(second)[0]?.stop).toBe('model-error')
    expect(stepCards(second).map((card) => [card.toolCallId, card.status, card.content])).toEqual([['steps-turn-2', 'in_progress', cardText('[>] 第 1 步')]])

    // 第三轮直接结束：不去动第二轮的卡
    const thirdModel = scriptedModel([{ text: '也做完了' }])
    session.model = thirdModel
    session.startTurn('turn-3', '收尾')
    const third = recordingIO()
    await runTurn(session, { id: 'turn-3', text: '收尾' }, third)
    expect(thirdModel.doStreamCalls).toHaveLength(1)
    expect(turnOutcomes(third)).toEqual([{ finish: null, stop: null }])
    expect(stepCards(third)).toEqual([])
  })

  test('ask_user：选项作为确认请求问用户，选了哪个告诉模型，这一轮接着跑；都不选时让它用文字说明后停下', async () => {
    const ask = { toolCalls: [{ name: 'ask_user', input: { questions: [{ question: '用哪种方案？', options: [{ label: '方案 A', description: '改得少' }, { label: '方案 B' }] }] } }] }
    const requests: Array<{ title: string; rawInput: unknown; options: string[] }> = []
    const answering = (pick: string | null) => {
      const io = recordingIO()
      io.requestPermission = async (toolCall: ToolCallUpdate, options: PermissionOption[]) => {
        requests.push({ title: toolCall.title ?? '', rawInput: toolCall.rawInput, options: options.map((option) => `${option.optionId}:${option.name}`) })
        return pick
      }
      return io
    }

    const model = scriptedModel([ask, { text: '按方案 B 做' }])
    const io = answering('ask-user-option-1')
    await expect(runTurn(await makeSession(model), { id: 't', text: '做一下' }, io)).resolves.toBe('end_turn')
    expect(requests[0]).toMatchObject({ title: '用哪种方案？', rawInput: { scope: 'ask-user', questions: [{ type: 'choice', question: '用哪种方案？', multiSelect: false }] } })
    expect(requests[0]?.options).toEqual(['ask-user-option-0:方案 A', 'ask-user-option-1:方案 B', 'ask-user-skip:都不选，我来说'])
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('The user chose: 方案 B')
    expect(JSON.stringify(io.updates)).toContain('选了：方案 B')
    expect(model.doStreamCalls).toHaveLength(2)

    const skipped = scriptedModel([ask, { text: '你想要哪种？' }])
    await runTurn(await makeSession(skipped), { id: 't', text: '做一下' }, answering('ask-user-skip'))
    expect(JSON.stringify(skipped.doStreamCalls[1]?.prompt)).toContain('The user did not answer')
  })

  // 第 673 步：一次问几个问题（选项卡），多选、滑块、选文件、预览图；答案按问题逐个校验
  test('ask_user 一次问几个：多选、滑块、选文件、预览图都交给界面，提交的答案逐个校验后告诉模型；答案不对当没答', async () => {
    mkdirSync(join(project, 'designs'), { recursive: true })
    writeFileSync(join(project, 'designs', 'a.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
    writeFileSync(join(project, 'src.ts'), 'export {}\n')
    const input = {
      questions: [
        { question: '要哪些页面？', header: '页面', multiSelect: true, options: [{ label: '首页', image: 'designs/a.png' }, { label: '设置' }, { label: '关于' }] },
        { question: '每页多少条？', header: '分页', type: 'slider', min: 10, max: 100, step: 10, unit: '条', default: 20 },
        { question: '改哪个文件？', header: '文件', type: 'file' },
      ],
    }
    const asking = (respond: (toolCall: ToolCallUpdate, options: PermissionOption[]) => { optionId: string; answers?: unknown } | null) => {
      const io = recordingIO()
      const requests: Array<{ rawInput: unknown; options: string[] }> = []
      io.requestAnswers = async (toolCall: ToolCallUpdate, options: PermissionOption[]) => {
        requests.push({ rawInput: toolCall.rawInput, options: options.map((option) => option.optionId) })
        return respond(toolCall, options)
      }
      return { io, requests }
    }

    const model = scriptedModel([{ toolCalls: [{ name: 'ask_user', input }] }, { text: '好' }])
    const { io, requests } = asking(() => ({ optionId: 'ask-user-submit', answers: [{ choice: [2, 0, 0] }, { value: 30 }, { files: ['./src.ts'] }] }))
    await runTurn(await makeSession(model), { id: 't', text: '做一下' }, io)
    expect(requests[0]?.options).toEqual(['ask-user-submit', 'ask-user-skip'])
    const questions = (requests[0]?.rawInput as { questions: Array<Record<string, unknown>> }).questions
    expect(questions.map((question) => question.type)).toEqual(['choice', 'slider', 'file'])
    expect(questions[0]).toMatchObject({ multiSelect: true, options: [{ label: '首页', image: { mimeType: 'image/png' } }, { label: '设置' }, { label: '关于' }] })
    expect(questions[1]).toEqual({ type: 'slider', question: '每页多少条？', header: '分页', min: 10, max: 100, step: 10, unit: '条', default: 20 })
    const prompt = JSON.stringify(model.doStreamCalls[1]?.prompt)
    expect(prompt).toContain('The user answered:')
    expect(prompt).toContain('要哪些页面？ 首页、关于')
    expect(prompt).toContain('每页多少条？ 30 条')
    expect(prompt).toContain('改哪个文件？ src.ts')
    expect(JSON.stringify(io.updates)).toContain('页面：首页、关于')

    // 不合规的答案：多选一个没选、滑块不在刻度上、超出范围、文件在项目外或不存在、少一个——都当没答
    for (const answers of [
      [{ choice: [] }, { value: 30 }, { files: ['src.ts'] }],
      [{ choice: [0] }, { value: 35 }, { files: ['src.ts'] }],
      [{ choice: [0] }, { value: 110 }, { files: ['src.ts'] }],
      [{ choice: [0] }, { value: 30 }, { files: ['../outside.ts'] }],
      [{ choice: [0] }, { value: 30 }, { files: ['missing.ts'] }],
      [{ choice: [0] }, { value: 30 }],
    ]) {
      const bad = scriptedModel([{ toolCalls: [{ name: 'ask_user', input }] }, { text: '你要什么？' }])
      await runTurn(await makeSession(bad), { id: 't', text: '做一下' }, asking(() => ({ optionId: 'ask-user-submit', answers })).io)
      expect(JSON.stringify(bad.doStreamCalls[1]?.prompt), JSON.stringify(answers)).toContain('The user did not answer')
    }
  })

  test('ask_user 的参数不对时不问：选择题没有选项、滑块范围反了或刻度太多、预览图不在项目里、太大或不是图片', async () => {
    writeFileSync(join(project, 'big.png'), Buffer.alloc(500_000))
    writeFileSync(join(project, 'note.txt'), 'x')
    for (const [question, reason] of [
      [{ question: '选哪个？' }, 'needs 2-6 options'],
      [{ question: '多少？', type: 'slider', min: 5, max: 1 }, 'min < max'],
      [{ question: '多少？', type: 'slider', min: 0, max: 100000, step: 1 }, 'at most 1000 steps'],
      [{ question: '哪个？', options: [{ label: 'A', image: '../x.png' }, { label: 'B' }] }, 'outside the project'],
      [{ question: '哪个？', options: [{ label: 'A', image: 'big.png' }, { label: 'B' }] }, 'larger than 400 KB'],
      [{ question: '哪个？', options: [{ label: 'A', image: 'note.txt' }, { label: 'B' }] }, 'PNG, JPEG, WebP or GIF'],
    ] as const) {
      const model = scriptedModel([{ toolCalls: [{ name: 'ask_user', input: { questions: [question] } }] }, { text: '好' }])
      const io = recordingIO()
      await runTurn(await makeSession(model), { id: 't', text: '做一下' }, io)
      expect(io.permissionRequests, reason).toBe(0)
      expect(JSON.stringify(model.doStreamCalls[1]?.prompt), reason).toContain(reason)
    }
  })
})

describe('同一步里的只读调用', () => {
  test('连续的只读命令一起开跑，结果按原来的顺序交给模型；要确认的命令、项目外的工作目录照旧一个一个来', async () => {
    for (const name of ['a', 'b', 'c']) writeFileSync(join(project, `${name}.txt`), `${name}\n`)
    const model = scriptedModel([{ toolCalls: [read('a.txt'), read('b.txt'), exec('grep -n c c.txt')] }, { text: '看完了' }])
    const session = await makeSession(model)
    const io = recordingIO()
    await runTurn(session, { id: 't', text: '看看' }, io)
    // 三个都开始了才有第一个结束
    expect(toolEvents(io).slice(0, 3)).toEqual(['开始 call-0-0', '开始 call-0-1', '开始 call-0-2'])
    const results = toolResults(session)
    expect(results.map((part) => part.toolCallId)).toEqual(['call-0-0', 'call-0-1', 'call-0-2'])
    expect(results.map((part) => resultText(part).split('Output:\n')[1])).toEqual(['a', 'b', '1:c'])
    expect(io.permissionRequests).toBe(0)

    // ask 模式下 touch 要确认：一个问完跑完再下一个
    const asking = scriptedModel([{ toolCalls: [exec('touch n1.txt'), exec('touch n2.txt')] }, { text: '建好了' }])
    const askingIO = recordingIO()
    await runTurn(await makeSession(asking), { id: 't', text: '建两个文件' }, askingIO)
    expect(askingIO.permissionRequests).toBe(2)
    expect(toolEvents(askingIO).slice(0, 4)).toEqual(['开始 call-0-0', '结束 call-0-0', '开始 call-0-1', '结束 call-0-1'])
    expect(existsSync(join(project, 'n1.txt')) && existsSync(join(project, 'n2.txt'))).toBe(true)

    const outside = scriptedModel([{ toolCalls: [exec('cat x.txt', { workdir: '..' }), exec('cat y.txt', { workdir: '..' })] }, { text: '看完了' }])
    const outsideIO = recordingIO()
    await runTurn(await makeSession(outside), { id: 't', text: '看看' }, outsideIO)
    expect(toolEvents(outsideIO).slice(0, 4)).toEqual(['开始 call-0-0', '结束 call-0-0', '开始 call-0-1', '结束 call-0-1'])
    // 在项目外的目录读文件，每次询问模式下每条都要确认（第 549 步）
    expect(outsideIO.permissionRequests).toBe(2)
  }, 30_000)

  test('轮询后台命令、看项目里的图片也和只读命令一起开跑；看项目外的图片照旧一个一个来', async () => {
    writeFileSync(join(project, 'a.txt'), 'a\n')
    writeFileSync(join(project, 'shot.png'), Buffer.from(PNG, 'base64'))
    const model = reactiveModel((prompt, call) =>
      call === 0
        ? { toolCalls: [exec('sleep 1; echo bg-done', { yield_time_ms: 250 })] }
        : call === 1
          ? { toolCalls: [{ name: 'write_stdin', input: { session_id: sessionIdIn(prompt) } }, { name: 'view_image', input: { path: 'shot.png' } }, read('a.txt')] }
          : { text: '看完了' },
    )
    const session = await makeSession(model)
    session.config = { ...session.config, model: { ...session.config.model, supportsImages: true } }
    session.permissionMode = 'full'
    const io = recordingIO()
    await runTurn(session, { id: 't', text: '等它跑完再看图' }, io)

    expect(toolEvents(io, 'call-1-').slice(0, 3)).toEqual(['开始 call-1-0', '开始 call-1-1', '开始 call-1-2'])
    const results = toolResults(session).filter((part) => part.toolCallId.startsWith('call-1-'))
    expect(results.map((part) => part.toolCallId)).toEqual(['call-1-0', 'call-1-1', 'call-1-2'])
    expect(resultText(results[0])).toMatch(/Process exited with code 0\nOutput:\nbg-done$/)
    expect(resultText(results[1])).toBe('shot.png is attached in the next message.')
    expect(resultText(results[2])).toMatch(/Output:\na$/)

    const outside = scriptedModel([{ toolCalls: [{ name: 'view_image', input: { path: '../x.png' } }, { name: 'view_image', input: { path: '../y.png' } }] }, { text: '算了' }])
    const outsideSession = await makeSession(outside)
    outsideSession.config = { ...outsideSession.config, model: { ...outsideSession.config.model, supportsImages: true } }
    const outsideIO = recordingIO('reject')
    await runTurn(outsideSession, { id: 't', text: '看图' }, outsideIO)
    expect(outsideIO.permissionRequests).toBe(2)
    expect(toolEvents(outsideIO).slice(0, 4)).toEqual(['开始 call-0-0', '结束 call-0-0', '开始 call-0-1', '结束 call-0-1'])
  }, 30_000)

  test('改项目外的文件（授权写的临时脚本）不算本轮改动：不跑完成检查，只回文字就结束', async () => {
    const outside = join(project, '..', `diffra-outside-${basename(project)}.py`)
    const model = scriptedModel([{ toolCalls: [addFile(outside, 'print(1)')] }, { text: '统计完了' }])
    const session = await makeSession(model, { afterEdit: null, beforeFinish: 'false' })
    const io = recordingIO()
    try {
      await runTurn(session, { id: 't', text: '写个脚本统计一下' }, io)
      expect(io.permissionRequests).toBe(1)
      expect(readFileSync(outside, 'utf8')).toBe('print(1)\n')
      expect(model.doStreamCalls).toHaveLength(2)
      expect(io.updates.some((update) => update.sessionUpdate === 'tool_call' && update.title.startsWith('完成检查'))).toBe(false)
      expect(turnOutcomes(io)).toEqual([{ finish: null, stop: null }])
      expect(session.taskState.needsVerification).toBe(false)
    } finally {
      rmSync(outside, { force: true })
    }
  })

  test('排在只读调用前面的改动先做完：同一步里先改再读，读到的是改过的内容', async () => {
    writeFileSync(join(project, 'a.txt'), 'old\n')
    const model = scriptedModel([
      { toolCalls: [read('a.txt')] },
      { toolCalls: [replaceLines('a.txt', 'old', 'new'), read('a.txt'), exec('grep -n new a.txt')] },
      { text: '改好了' },
    ])
    const session = await makeSession(model)
    await runTurn(session, { id: 't', text: '改一下' }, recordingIO())
    const results = toolResults(session)
    expect(resultText(results[0])).toMatch(/Output:\nold$/)
    expect(resultText(results[1])).toBe('Success. Updated the following files:\nM a.txt')
    expect(resultText(results[2])).toMatch(/Process exited with code 0\nOutput:\nnew$/)
    expect(resultText(results[3])).toMatch(/Process exited with code 0\nOutput:\n1:new$/)
  })
})

describe('命令输出太长', () => {
  test('超过 max_output_tokens 时按 token 留头尾、说明原来多长，完整输出存成文件，模型用只读的 sed -n 读被省略的部分；没截短的不存', async () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'diffra-loop-outputs-'))
    try {
      const model = scriptedModel([
        { toolCalls: [exec('for i in $(seq 1 1000); do echo "line-$i"; done', { max_output_tokens: 500 })] },
        { toolCalls: [exec('echo short')] },
        { text: '看完了' },
      ])
      const session = await makeSession(model, undefined, [], undefined, undefined, undefined, {}, { outputRoot })
      session.permissionMode = 'full'
      await runTurn(session, { id: 't', text: '跑一下' }, recordingIO())

      const [long, short] = toolResults(session).map(resultText)
      // 输出 8892 字节，按 4 字节一个 token 是 2223 个；留 500 个，省掉 1723 个
      expect(long).toMatch(
        /^Wall time: \d+\.\d{4} seconds\nProcess exited with code 0\nOriginal token count: 2223\nOutput:\nWarning: truncated output \(original token count: 2223\)\nTotal output lines: 1000\nline-1\nline-2\n/,
      )
      expect(long).toContain('…1723 tokens truncated…')
      expect(long).toContain('line-999\nline-1000\n[The output above was shortened. The full output (1001 lines) is saved at ')
      expect(long).not.toContain('line-500\n')
      expect(short).toMatch(/Process exited with code 0\nOutput:\nshort$/)
      expect(short).not.toContain('saved at')
      const path = /saved at (\S+\.txt)/.exec(long ?? '')?.[1]
      expect(path).toBeDefined()
      expect(readFileSync(path!, 'utf8')).toBe(`${Array.from({ length: 1000 }, (_, index) => `line-${index + 1}`).join('\n')}\n`)

      // 下一轮模型按提示用 sed -n 读中间那段：只读命令，不用确认
      session.permissionMode = 'ask'
      session.model = scriptedModel([{ toolCalls: [exec(`sed -n '500,501p' '${path}'`)] }, { text: '读到了' }])
      const io = recordingIO()
      await runTurn(session, { id: 't2', text: '看中间' }, io)
      expect(io.permissionRequests).toBe(0)
      expect(resultText(toolResults(session).at(-1))).toMatch(/Process exited with code 0\nOutput:\nline-500\nline-501$/)
    } finally {
      rmSync(outputRoot, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('模型服务出错时', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // 连上了、说到这里（可以什么都没说）就再也没有数据的流
  const stalledStream = (text: string | null) => ({
    stream: new ReadableStream<StreamPart>({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] })
        if (text === null) return
        controller.enqueue({ type: 'text-start', id: 't' })
        controller.enqueue({ type: 'text-delta', id: 't', delta: text })
      },
    }),
  })

  test('回复说到一半连接断了：已经说的交回对话，让模型接着说，这一轮不停', async () => {
    const model = new MockLanguageModelV4({ doStream: [failingStream('前半句，', serviceError(502)), stepStream({ text: '后半句。' }, 1)] })
    const session = await makeSession(model)
    const io = recordingIO()

    await expect(runTurn(session, { id: 't', text: '说句话' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(2)
    const second = JSON.stringify(model.doStreamCalls[1]?.prompt)
    expect(second).toContain('前半句，')
    expect(second).toContain('cut off by a network error')
    expect(notices(io)).toEqual([])
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: null }])
  })

  test('还没说话就出错：等一会儿整步重发；鉴权错误不重发，直接停下', async () => {
    const model = new MockLanguageModelV4({ doStream: [failingStream(null, serviceError(503)), stepStream({ text: '好了' }, 1)] })
    const io = recordingIO()
    await expect(runTurn(await makeSession(model), { id: 't', text: '说句话' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(2)
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: null }])

    const denied = new MockLanguageModelV4({ doStream: [failingStream(null, serviceError(401)), stepStream({ text: '不会走到这里' }, 1)] })
    const deniedIO = recordingIO()
    await runTurn(await makeSession(denied), { id: 't', text: '说句话' }, deniedIO)
    expect(denied.doStreamCalls).toHaveLength(1)
    expect(turnOutcomes(deniedIO)).toMatchObject([{ stop: 'model-error', errorKind: 'auth' }])
  }, 30_000)

  // 评测里遇到过：网关在流里发来「输出中断，请重试」，没有 HTTP 状态码。以前归成未知错误、这一轮直接停下
  test('流里发来的没有状态码的错误：和连接中途断开一样重发，这一轮照常做完；带 4xx 状态码的照旧不重发', async () => {
    const model = new MockLanguageModelV4({ doStream: [failingStream(null, new Error('输出中断,请直接发送 继续 重试 (output interrupted, send continue to retry)')), stepStream({ text: '好了' }, 1)] })
    const io = recordingIO()
    await expect(runTurn(await makeSession(model), { id: 't', text: '说句话' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(2)
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: null }])

    const invalid = new MockLanguageModelV4({ doStream: [failingStream(null, serviceError(400)), stepStream({ text: '不会走到这里' }, 1)] })
    const invalidIO = recordingIO()
    await runTurn(await makeSession(invalid), { id: 't', text: '说句话' }, invalidIO)
    expect(invalid.doStreamCalls).toHaveLength(1)
    expect(turnOutcomes(invalidIO)).toMatchObject([{ stop: 'model-error' }])
  }, 30_000)

  test('回了 200 却没能读完回复（Failed to process successful response）：整步重发，这一轮照常做完（第 632 步）', async () => {
    const unreadable = new APICallError({ message: 'Failed to process successful response', url: 'http://127.0.0.1:1/chat/completions', requestBodyValues: {}, statusCode: 200, isRetryable: false })
    const model = new MockLanguageModelV4({ doStream: [failingStream(null, unreadable), stepStream({ text: '好了' }, 1)] })
    const io = recordingIO()
    await expect(runTurn(await makeSession(model), { id: 't', text: '说句话' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(2)
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: null }])
  }, 30_000)

  test('一直限流：自动重试 5 次，每次等的时间从 200 毫秒起翻倍；用完了没配备用模型就停下', async () => {
    const calledAt: number[] = []
    const coder = new MockLanguageModelV4({
      doStream: async () => {
        calledAt.push(Date.now())
        return failingStream(null, serviceError(429))
      },
    })
    const io = recordingIO()
    await runTurn(await makeSession(coder), { id: 't', text: '说句话' }, io)
    expect(coder.doStreamCalls).toHaveLength(6)
    const gaps = calledAt.slice(1).map((time, index) => time - calledAt[index]!)
    gaps.forEach((gap, index) => {
      const base = 200 * 2 ** index
      // 上下浮动一成，再留出这一步自己的开销
      expect(gap).toBeGreaterThanOrEqual(base * 0.9 - 5)
      expect(gap).toBeLessThan(base * 1.1 + 500)
    })
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'model-error', errorKind: 'rate-limit' }])
    expect(notices(io)).toEqual(['模型调用失败'])
    expect(lastTaskState(io)?.status).toBe('blocked')
  }, 30_000)

  test('一直限流：自动重试用完后换备用模型接着做', async () => {
    const limited = () => failingStream(null, serviceError(429))
    const coder = new MockLanguageModelV4({ doStream: [limited(), limited(), limited(), limited(), limited(), limited()] })
    const fallback = scriptedModel([{ text: '备用模型接着说' }])
    const io = recordingIO()
    await expect(runTurn(await makeSession(coder, undefined, [], undefined, undefined, undefined, { fallback }), { id: 't', text: '说句话' }, io)).resolves.toBe('end_turn')
    expect(coder.doStreamCalls).toHaveLength(6)
    expect(fallback.doStreamCalls).toHaveLength(1)
    expect(notices(io)).toEqual(['已换用备用模型 兜底供应商 / fallback'])
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: null }])
  }, 60_000)

  test('太久没有任何输出（默认 5 分钟）当成连接断了：中断这次请求，等一会儿整步重发，这一轮照常做完', async () => {
    vi.stubEnv('DIFFRA_MODEL_IDLE_MS', '300')
    const model = new MockLanguageModelV4({ doStream: [stalledStream(null), stepStream({ text: '好了' }, 1)] })
    const io = recordingIO()
    const started = Date.now()
    await expect(runTurn(await makeSession(model), { id: 't', text: '说句话' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(2)
    // 先等满 300 毫秒没输出，再退避约 200 毫秒
    expect(Date.now() - started).toBeGreaterThanOrEqual(300 + 180)
    expect(notices(io)).toEqual([])
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: null }])
  }, 30_000)

  test('说了一半后太久没有输出：和连接中途断开一样，已经说的交回对话，让模型接着说', async () => {
    vi.stubEnv('DIFFRA_MODEL_IDLE_MS', '300')
    const model = new MockLanguageModelV4({ doStream: [stalledStream('前半句，'), stepStream({ text: '后半句。' }, 1)] })
    const io = recordingIO()
    await expect(runTurn(await makeSession(model), { id: 't', text: '说句话' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(2)
    const second = JSON.stringify(model.doStreamCalls[1]?.prompt)
    expect(second).toContain('前半句，')
    expect(second).toContain('cut off by a network error')
    expect(notices(io)).toEqual([])
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: null }])
  }, 30_000)
})

describe('工具参数的字符串写法', () => {
  test('数字参数写成字符串时照样接受并生效，含糊的写法仍报参数错误、不执行', async () => {
    const model = reactiveModel((prompt, call) => {
      switch (call) {
        case 0:
          return { toolCalls: [exec("printf '%s\\n' one two three", { max_output_tokens: '3' })] }
        case 1:
          return { toolCalls: [exec('sleep 1; echo slept > slept.txt; echo slept', { yield_time_ms: '250' })] }
        case 2:
          return { toolCalls: [{ name: 'write_stdin', input: { session_id: String(sessionIdIn(prompt)), yield_time_ms: '5000' } }] }
        case 3:
          return { toolCalls: [exec('echo x > soon.txt', { yield_time_ms: 'soon' })] }
        case 4:
          return { toolCalls: [{ name: 'write_stdin', input: { session_id: '12abc' } }] }
        default:
          return { text: '好' }
      }
    })
    const session = await makeSession(model)
    session.permissionMode = 'full'
    await runTurn(session, { id: 't', text: '跑' }, recordingIO())

    const results = toolResults(session)
    expect(results).toHaveLength(5)
    expect(resultText(results[0])).toContain('Warning: truncated output (original token count: 4)\nTotal output lines: 3\none\ntw…1 tokens truncated…\nthree')
    expect(resultText(results[1])).toMatch(/\nProcess running with session ID \d+\nOutput:\n$/)
    expect(resultText(results[2])).toMatch(/Process exited with code 0\nOutput:\nslept$/)
    expect(results[3]?.output.type).toBe('error-text')
    expect(resultText(results[3])).toMatch(/Invalid input for tool exec_command/)
    expect(existsSync(join(project, 'soon.txt'))).toBe(false)
    expect(results[4]?.output.type).toBe('error-text')
    expect(resultText(results[4])).toMatch(/Invalid input for tool write_stdin/)
  }, 30_000)

  test('发给模型的参数类型不变，仍是 integer', async () => {
    const model = scriptedModel([{ text: '好' }])
    await runTurn(await makeSession(model), { id: 't', text: '你好' }, recordingIO())
    const schemaOf = (name: string) => {
      const tool = model.doStreamCalls[0]?.tools?.find((item) => item.name === name)
      return (tool?.type === 'function' ? tool.inputSchema : undefined) as { properties: Record<string, { type?: string }>; required?: string[] } | undefined
    }
    expect(schemaOf('exec_command')?.properties.yield_time_ms?.type).toBe('integer')
    expect(schemaOf('exec_command')?.properties.max_output_tokens?.type).toBe('integer')
    expect(schemaOf('exec_command')?.required).toEqual(['cmd'])
    expect(schemaOf('write_stdin')?.properties.session_id?.type).toBe('integer')
    expect(schemaOf('write_stdin')?.properties.yield_time_ms?.type).toBe('integer')
    expect(schemaOf('write_stdin')?.required).toEqual(['session_id'])
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
  const toolCallTitles = (io: { updates: SessionUpdate[] }) => io.updates.flatMap((update) => (update.sessionUpdate === 'tool_call' ? [update.title] : []))

  test('MCP 工具和内置工具一起发给模型；声明只读的直接调，其他的先问，选了始终允许后本会话不再问；MCP 改了文件时结束门禁照常出完成卡', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'mcp__demo__echo', input: { text: 'hi' } }] },
      { toolCalls: [{ name: 'mcp__demo__write_note', input: { text: 'first' } }] },
      { text: '写好了' },
      { toolCalls: [{ name: 'mcp__demo__write_note', input: { text: 'second' } }] },
      { text: '又写好了' },
    ])
    const session = await withMcp(model)
    const io = recordingIO('allow_always')

    await expect(runTurn(session, { id: 'turn-1', text: '记一下' }, io)).resolves.toBe('end_turn')
    expect(toolNames(model)).toEqual(expect.arrayContaining(['exec_command', 'apply_patch', 'update_plan', 'mcp__demo__echo', 'mcp__demo__write_note']))
    expect(toolNames(model)).not.toContain('finish')
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('echo: hi')
    expect(io.permissionRequests).toBe(1)
    expect(readFileSync(join(project, 'note.txt'), 'utf8')).toBe('first\n')
    expect(toolCallTitles(io)).toEqual(['MCP demo · echo', 'MCP demo · write_note', '完成'])
    // write_note 改了项目文件，指纹变了，不算没有改动
    expect(verifications(io)).toEqual(['unverified'])
    expect(model.doStreamCalls).toHaveLength(3)

    await runTurn(session, { id: 'turn-2', text: '再记一下' }, io)
    expect(io.permissionRequests).toBe(1)
    expect(readFileSync(join(project, 'note.txt'), 'utf8')).toBe('second\n')
    // 只回了文字就结束：不再多调一次模型
    expect(model.doStreamCalls).toHaveLength(5)
    expect(verifications(io)).toEqual(['unverified', 'unverified'])
    expect(turnOutcomes(io).at(-1)).toEqual({ finish: 'unverified', stop: null })
    expect(session.usageBreakdown(1000).tools).toBeGreaterThan(0)
  }, 30_000)

  test('用户拒绝时不调，告诉模型别再试；完全放行模式不问；工具报错原样给模型', async () => {
    const rejected = scriptedModel([{ toolCalls: [{ name: 'mcp__demo__write_note', input: { text: 'x' } }] }, { text: '好吧' }])
    const io = recordingIO('reject')
    await runTurn(await withMcp(rejected), { id: 'turn-1', text: '记一下' }, io)
    expect(JSON.stringify(rejected.doStreamCalls[1]?.prompt)).toContain('The user rejected this tool call')
    expect(existsSync(join(project, 'note.txt'))).toBe(false)
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: null }])

    const full = scriptedModel([
      { toolCalls: [{ name: 'mcp__demo__write_note', input: { text: 'y' } }] },
      { toolCalls: [{ name: 'mcp__demo__fail', input: {} }] },
      { text: '记好了' },
    ])
    const session = await withMcp(full)
    session.permissionMode = 'full'
    const fullIO = recordingIO('reject')
    await runTurn(session, { id: 'turn-1', text: '记一下' }, fullIO)
    expect(fullIO.permissionRequests).toBe(0)
    expect(readFileSync(join(project, 'note.txt'), 'utf8')).toBe('y\n')
    expect(toolResults(session).at(-1)?.output).toEqual({ type: 'error-text', value: 'something broke' })
    expect(full.doStreamCalls).toHaveLength(3)
    expect(turnOutcomes(fullIO)).toEqual([{ finish: 'unverified', stop: null }])
    expect(toolUpdates(fullIO, 'failed')).toHaveLength(1)
  }, 30_000)

  test('声明只读的 MCP 工具和只读命令一起开跑；会改东西的 MCP 工具一个一个来', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'mcp__demo__echo', input: { text: 'a' } }, { name: 'mcp__demo__whoami', input: {} }, exec('echo b')] },
      { toolCalls: [{ name: 'mcp__demo__write_note', input: { text: 'one' } }, { name: 'mcp__demo__echo', input: { text: 'c' } }] },
      { text: '好' },
    ])
    const session = await withMcp(model)
    session.permissionMode = 'full'
    const io = recordingIO()
    await runTurn(session, { id: 'turn-1', text: '看看' }, io)

    expect(toolEvents(io, 'call-0-').slice(0, 3)).toEqual(['开始 call-0-0', '开始 call-0-1', '开始 call-0-2'])
    expect(toolEvents(io, 'call-1-')).toEqual(['开始 call-1-0', '结束 call-1-0', '开始 call-1-1', '结束 call-1-1'])
    const results = toolResults(session)
    expect(results.map((part) => part.toolCallId)).toEqual(['call-0-0', 'call-0-1', 'call-0-2', 'call-1-0', 'call-1-1'])
    expect(resultText(results[0])).toBe('echo: a')
    expect(resultText(results[1])).toMatch(/^token=secret-token cwd=/)
    expect(resultText(results[2])).toMatch(/Output:\nb$/)
    expect(resultText(results[3])).toBe('saved note.txt')
    expect(resultText(results[4])).toBe('echo: c')
  }, 30_000)

  test('连不上的服务器开始时提示一下，照常做', async () => {
    const model = scriptedModel([{ text: '好' }])
    const io = recordingIO()
    await runTurn(await withMcp(model, [{ name: 'broken', command: 'diffra-no-such-command', args: [], env: [] }]), { id: 'turn-1', text: '你好' }, io)
    expect(notices(io)).toEqual(['MCP 服务器「broken」不可用，这一轮不用它的工具'])
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
    // 上下文消息之后第一条是提问
    const asked = withoutContext(session.messages)[0]
    expect(asked).toEqual({ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', image: data, mediaType: 'image/webp' }] })
    const withImage = messagesChars(session.messages)
    const textOnly = messagesChars(session.messages.map((message) => (message === asked ? { role: 'user' as const, content: '看图' } : message)))
    expect(withImage - textOnly).toBeGreaterThan(IMAGE_CHARS - 200)
    expect(withImage - textOnly).toBeLessThan(IMAGE_CHARS + 200)
  })

  test('view_image 只给能看图的模型；看的图片跟在工具结果后面，作为一条带图片的用户消息发给模型；不是图片时报错', async () => {
    writeFileSync(join(project, 'shot.png'), Buffer.from(PNG, 'base64'))
    writeFileSync(join(project, 'notes.txt'), 'x\n')
    const plain = scriptedModel([{ text: '好' }])
    await runTurn(await makeSession(plain), { id: 't', text: '你好' }, recordingIO())
    expect(toolNames(plain)).not.toContain('view_image')

    const model = scriptedModel([{ toolCalls: [{ name: 'view_image', input: { path: 'shot.png' } }] }, { toolCalls: [{ name: 'view_image', input: { path: 'notes.txt' } }] }, { text: '看到了' }])
    const session = await makeSession(model)
    session.config = { ...session.config, model: { ...session.config.model, supportsImages: true } }
    const io = recordingIO()
    await runTurn(session, { id: 't', text: '看看截图' }, io)
    expect(toolNames(model)).toContain('view_image')

    const results = toolResults(session)
    expect(results[0]?.output).toEqual({ type: 'text', value: 'shot.png is attached in the next message.' })
    const at = session.messages.findIndex((message) => message.role === 'tool')
    const attached = session.messages[at + 1]
    expect(attached?.role).toBe('user')
    expect(Array.isArray(attached?.content) ? attached.content.filter((part) => part.type === 'image') : []).toEqual([{ type: 'image', image: PNG, mediaType: 'image/png' }])
    // 第二次请求里图片紧跟在工具结果后面
    const prompt = model.doStreamCalls[1]!.prompt
    const toolAt = prompt.findIndex((message) => message.role === 'tool')
    const next = prompt[toolAt + 1]
    expect(next?.role).toBe('user')
    expect(JSON.stringify(next?.content)).toContain('"mediaType":"image/png"')
    expect(completedCards(io).map((update) => update.title)).toContain('查看图片 shot.png')

    // 不是图片：报错，不附图片
    expect(results[1]?.output).toEqual({ type: 'error-text', value: 'notes.txt is not a supported image (png, jpg, gif, webp).' })
    expect(session.messages.filter((message) => message.role === 'user' && Array.isArray(message.content) && message.content.some((part) => part.type === 'image'))).toHaveLength(1)
  })
})

describe('等外面的事做完', () => {
  test('exec_command 到点还没结束就返回会话号、进程在后台接着跑；write_stdin 轮询到它结束，把结果和退出码交给模型', async () => {
    const model = reactiveModel((prompt, call) =>
      call === 0
        ? { toolCalls: [exec('sleep 1; echo "conclusion: success"', { yield_time_ms: 250 })] }
        : call === 1
          ? { toolCalls: [{ name: 'write_stdin', input: { session_id: sessionIdIn(prompt) } }] }
          : { text: 'CI 过了' },
    )
    const session = await makeSession(model)
    session.permissionMode = 'full'
    const io = recordingIO()
    await runTurn(session, { id: 't', text: '等 CI' }, io)

    expect(model.doStreamCalls).toHaveLength(3)
    const [started, polled] = toolResults(session).map(resultText)
    const id = /Process running with session ID (\d+)/.exec(started ?? '')?.[1]
    expect(id).toBeDefined()
    expect(started).not.toContain('Process exited')
    expect(started).not.toContain('conclusion')
    expect(polled).toMatch(/^Wall time: \d+\.\d{4} seconds\nProcess exited with code 0\nOutput:\nconclusion: success$/)
    // 进程结束后从后台进程表里拿掉
    expect(session.execSessions.size).toBe(0)

    const finished = completedCards(io)
    const startCard = finished.find((update) => update.toolCallId === 'call-0-0')
    const pollCard = finished.find((update) => update.toolCallId === 'call-1-0')
    expect(startCard?.content).toEqual([{ type: 'content', content: { type: 'text', text: `运行中（会话 ${id}）\n(no output)` } }])
    // 还在跑：没有成没成功，只有这次等了多久（第 659 步）
    expect(startCard?._meta?.diffra).toEqual({ commandDurationMs: expect.any(Number) })
    expect(pollCard?.title).toBe('查看 sleep 1; echo "conclusion: success"')
    expect(pollCard?.content).toEqual([{ type: 'content', content: { type: 'text', text: 'Exit code: 0\nconclusion: success' } }])
    expect(pollCard?._meta?.diffra).toEqual({ commandSucceeded: true, commandDurationMs: expect.any(Number) })
  }, 30_000)

  // 签名不算耗时和会话号之后，空轮询一个还没输出的进程每次结果都一样：这是在等它，不能当成原地打转
  test('反复轮询还在跑的命令、结果一样：不提醒、不停下；用 Ctrl-C 结束后这一轮照常完成', async () => {
    const model = reactiveModel((prompt, call) =>
      call === 0
        ? { toolCalls: [exec('sleep 30', { yield_time_ms: 250 })] }
        : call <= 3
          ? { toolCalls: [{ name: 'write_stdin', input: { session_id: sessionIdIn(prompt), yield_time_ms: 5000 } }] }
          : call === 4
            ? { toolCalls: [{ name: 'write_stdin', input: { session_id: sessionIdIn(prompt), chars: '\u0003' } }] }
            : { text: '等不了了，先停掉' },
    )
    const session = await makeSession(model)
    session.permissionMode = 'full'
    const io = recordingIO()
    await expect(runTurn(session, { id: 't', text: '等它跑完' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(6)
    expect(JSON.stringify(model.doStreamCalls.map((call) => call.prompt))).not.toContain('You made the same call')
    expect(io.updates.some((update) => update.sessionUpdate === 'notice' && update.title.includes('重复'))).toBe(false)
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: null }])
    expect(session.execSessions.size).toBe(0)
  }, 40_000)
})

describe('命令输出里的密钥值（第 625 步）', () => {
  test('完全访问模式下 cat .env 不问，但密钥的值不进模型上下文、界面上也看不到', async () => {
    writeFileSync(join(project, '.env'), 'API_TOKEN=tok_live_9f8e7d6c5b4a\nDEBUG=true\n')
    const model = scriptedModel([{ toolCalls: [exec('echo ---ENV--- && cat .env')] }, { text: '看过了' }])
    const session = await makeSession(model)
    session.permissionMode = 'full'
    const io = recordingIO()
    await runTurn(session, { id: 't', text: '看看配置' }, io)
    const result = resultText(toolResults(session)[0])
    expect(result).toContain('API_TOKEN=[hidden by Diffra: value of API_TOKEN in .env]')
    expect(result).toContain('DEBUG=true')
    expect(JSON.stringify(model.doStreamCalls)).not.toContain('tok_live_9f8e7d6c5b4a')
    expect(JSON.stringify(io.updates)).not.toContain('tok_live_9f8e7d6c5b4a')
  }, 30_000)
})

describe('git 历史里的密钥文件（第 629 步）', () => {
  test('命令写了受保护文件的名字，输出里像密钥的赋值也换掉，即使那份文件已经不在工作区', async () => {
    const run = (args: string[]) => execFileSync('git', args, { cwd: project, stdio: 'ignore' })
    const identity = ['-c', 'user.name=t', '-c', 'user.email=t@t']
    run(['init', '-q'])
    writeFileSync(join(project, '.env'), 'WEATHER_API_KEY=wk_live_0a1b2c3d4e5f\nCITY=Shanghai\n')
    run(['add', '.env'])
    run([...identity, 'commit', '-q', '-m', 'add env'])
    run(['rm', '-q', '.env'])
    run([...identity, 'commit', '-q', '-m', 'remove env'])
    const model = scriptedModel([{ toolCalls: [exec('git show HEAD~1:.env')] }, { text: '看过了' }])
    const session = await makeSession(model)
    session.permissionMode = 'full'
    await runTurn(session, { id: 't', text: '看看以前的配置' }, recordingIO())
    const result = resultText(toolResults(session)[0])
    expect(result).toContain('WEATHER_API_KEY=[hidden by Diffra: value of WEATHER_API_KEY in the protected file this command reads]')
    expect(result).toContain('CITY=Shanghai')
    expect(JSON.stringify(model.doStreamCalls)).not.toContain('wk_live_0a1b2c3d4e5f')
  }, 30_000)

  test('命令没写文件名（git show 某次提交、git log -p、git grep 历史），输出里受保护文件那段的值也换掉（第 631 步）', async () => {
    const run = (args: string[]) => execFileSync('git', args, { cwd: project, stdio: 'ignore' })
    const identity = ['-c', 'user.name=t', '-c', 'user.email=t@t']
    run(['init', '-q'])
    writeFileSync(join(project, 'app.py'), 'RETRIES = 2\n')
    writeFileSync(join(project, '.env'), 'WEATHER_API_KEY=wk_live_0a1b2c3d4e5f\nCITY=Shanghai\n')
    run(['add', '.'])
    run([...identity, 'commit', '-q', '-m', 'add env'])
    run(['rm', '-q', '.env'])
    run([...identity, 'commit', '-q', '-m', 'remove env'])
    const model = scriptedModel([
      { toolCalls: [exec('git show HEAD~1'), exec('git log -p'), exec('git grep -n WEATHER HEAD~1')] },
      { text: '看过了' },
    ])
    const session = await makeSession(model)
    session.permissionMode = 'full'
    await runTurn(session, { id: 't', text: '翻翻历史' }, recordingIO())
    const results = toolResults(session).map(resultText)
    expect(results).toHaveLength(3)
    for (const result of results) expect(result).toContain('WEATHER_API_KEY=[hidden by Diffra: value of WEATHER_API_KEY in .env]')
    expect(results[0]).toContain('+CITY=Shanghai')
    expect(results[0]).toContain('+RETRIES = 2')
    expect(results[1]).toContain('-CITY=Shanghai')
    expect(JSON.stringify(model.doStreamCalls)).not.toContain('wk_live_0a1b2c3d4e5f')
  }, 30_000)
})

describe('项目外写入的确认', () => {
  test('确认卡带上要写的那段补丁：补丁里写的路径经过目录联接（符号链接）、写成相对路径或 Git Bash 写法时也对得上', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'diffra-outside-'))
    const link = `${outside}-link`
    symlinkSync(outside, link, 'junction')
    const file = join(outside, 'note.txt')
    writeFileSync(file, 'before\n')
    const written = [join(link, 'note.txt'), relative(project, file)]
    if (process.platform === 'win32') written.push(`/${file[0]!.toLowerCase()}${file.slice(2).split(sep).join('/')}`)
    try {
      for (const path of written) {
        const rawInputs: unknown[] = []
        const io = recordingIO()
        io.requestPermission = async (toolCall: ToolCallUpdate) => {
          rawInputs.push(toolCall.rawInput)
          return null
        }
        await runTurn(await makeSession(scriptedModel([{ toolCalls: [replaceLines(path, 'before', 'after')] }, { text: '没改' }])), { id: 't', text: '改外面的文件' }, io)
        expect(rawInputs, path).toEqual([expect.objectContaining({ scope: 'exact-path', access: 'write', patch: expect.stringContaining('+after') })])
        expect(readFileSync(file, 'utf8')).toBe('before\n')
      }
    } finally {
      rmSync(link, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
