import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { BrowserAction, BrowserActionResult } from '../src/protocol.js'
import { normalizeUrl } from '../src/urls.js'
import { runTurn, streamModelStep, type TurnIO } from '../src/session/loop.js'
import { makeSession, project, recordingIO, scriptedModel, usageOf, useTempProject } from './loop-helpers.js'

// 主循环的其余部分：内置浏览器、模型没有输出时的提示、可视化、任务之间互通。
// 结束门禁、工具、审查、上下文、检查进展各在 loop-*.test.ts 里，共用的辅助在 loop-helpers.ts
type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer Part> ? Part : never

useTempProject()

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
      'browser_history',
      'browser_tabs',
      'browser_snapshot',
      'browser_find',
      'browser_get_text',
      'browser_click',
      'browser_hover',
      'browser_drag',
      'browser_scroll',
      'browser_type',
      'browser_press_key',
      'browser_select_option',
      'browser_upload_file',
      'browser_wait_for',
      'browser_handle_dialog',
      'browser_console',
      'browser_network',
      'browser_evaluate',
      'browser_check_layout',
      'browser_images',
      'browser_switch',
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
    expect(fake.actions).toEqual([{ action: 'screenshot', width: 375, fullPage: false }, { action: 'screenshot', width: null, fullPage: false }, { action: 'layout' }])
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

    expect(fake.actions).toEqual([
      { action: 'navigate', url: 'http://localhost:5173/' },
      { action: 'snapshot' },
      { action: 'click', at: { ref: 'e2' }, button: 'left', double: false, modifiers: [] },
    ])
    expect(io.permissionRequests).toBe(1)
    expect(JSON.stringify(model.doStreamCalls[2]?.prompt)).toContain('- button \\"保存\\" [ref=e2]')
    expect(JSON.stringify(model.doStreamCalls[3]?.prompt)).toContain('Browser action failed: 页面上没有 e2')
    expect(JSON.stringify(model.doStreamCalls[4]?.prompt)).toContain('did not allow opening example.com')
    const titles = io.updates.flatMap((update) => (update.sessionUpdate === 'tool_call' ? [update.title] : []))
    expect(titles).toEqual(['浏览器 打开 http://localhost:5173/', '浏览器 读取页面', '浏览器 点击 e2', '浏览器 打开 https://example.com/docs'])
  })

  test('按坐标点、拖动、滚动、组合键、等待都转成浏览器操作；没有 ref 也没有完整坐标时告诉模型', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'browser_click', input: { x: 120, y: 80, double: true, modifiers: ['Shift'] } }] },
      { toolCalls: [{ name: 'browser_drag', input: { from_ref: 'e3', to_x: 400, to_y: 300 } }] },
      { toolCalls: [{ name: 'browser_scroll', input: {} }] },
      { toolCalls: [{ name: 'browser_press_key', input: { key: 'ArrowUp', repeat: 3, hold_ms: 200 } }] },
      { toolCalls: [{ name: 'browser_wait_for', input: { text: '加载完成' } }] },
      { toolCalls: [{ name: 'browser_tabs', input: { action: 'new', url: 'localhost:3000' } }] },
      { toolCalls: [{ name: 'browser_click', input: { x: 10 } }] },
      { text: '好' },
    ])
    const session = await withBrowser(model)
    const fake = fakeBrowser([])
    const io = Object.assign(recordingIO(), { browser: fake.browser })
    await runTurn(session, { id: 'turn-1', text: '玩一下' }, io)
    expect(fake.actions).toEqual([
      { action: 'click', at: { x: 120, y: 80 }, button: 'left', double: true, modifiers: ['Shift'] },
      { action: 'drag', from: { ref: 'e3' }, to: { x: 400, y: 300 } },
      { action: 'scroll', at: null, deltaX: 0, deltaY: 600 },
      { action: 'press', key: 'ArrowUp', repeat: 3, holdMs: 200 },
      { action: 'wait', text: '加载完成', textGone: null, seconds: 10 },
      { action: 'tabs', op: 'new', url: 'http://localhost:3000/', index: null },
    ])
    // 本地地址的新标签页不用问
    expect(io.permissionRequests).toBe(0)
    expect(JSON.stringify(model.doStreamCalls[7]?.prompt)).toContain('give ref, or both x and y')
    const titles = io.updates.flatMap((update) => (update.sessionUpdate === 'tool_call' ? [update.title] : []))
    expect(titles.slice(0, 6)).toEqual(['浏览器 双击 (120, 80)', '浏览器 拖动 e3 → (400, 300)', '浏览器 滚动', '浏览器 按键 ArrowUp ×3', '浏览器 等待「加载完成」出现', '浏览器 新标签页 http://localhost:3000/'])
  })

  test('上传文件：路径解析成项目里的绝对路径，先问用户；拒绝了不上传', async () => {
    writeFileSync(join(project, 'avatar.png'), 'png')
    const model = scriptedModel([
      { toolCalls: [{ name: 'browser_upload_file', input: { ref: 'e5', paths: ['avatar.png'] } }] },
      { toolCalls: [{ name: 'browser_upload_file', input: { ref: 'e5', paths: ['avatar.png'] } }] },
      { text: '好' },
    ])
    const session = await withBrowser(model)
    const fake = fakeBrowser([])
    const choices = ['allow_once', 'reject_once']
    const asked: string[] = []
    const io = Object.assign(recordingIO(), {
      browser: fake.browser,
      requestPermission: async (call: { title?: string | null }) => {
        asked.push(call.title ?? '')
        return choices.shift() ?? null
      },
    })
    await runTurn(session, { id: 'turn-1', text: '传头像' }, io)
    expect(asked).toEqual(['在浏览器里上传文件：avatar.png', '在浏览器里上传文件：avatar.png'])
    expect(fake.actions).toEqual([{ action: 'upload', ref: 'e5', paths: [join(project, 'avatar.png')] }])
    expect(JSON.stringify(model.doStreamCalls[2]?.prompt)).toContain('did not allow uploading these files')
  })

  test('在页面里运行脚本：先问用户，选了本会话允许后不再问；完全放行模式不问', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'browser_evaluate', input: { expression: 'document.title' } }] },
      { toolCalls: [{ name: 'browser_evaluate', input: { expression: 'location.href' } }] },
      { text: '好' },
    ])
    const session = await withBrowser(model)
    const fake = fakeBrowser([])
    const io = Object.assign(recordingIO('allow_always'), { browser: fake.browser })
    await runTurn(session, { id: 'turn-1', text: '看标题' }, io)
    expect(io.permissionRequests).toBe(1)
    expect(fake.actions).toEqual([
      { action: 'evaluate', expression: 'document.title' },
      { action: 'evaluate', expression: 'location.href' },
    ])

    const full = await withBrowser(scriptedModel([{ toolCalls: [{ name: 'browser_evaluate', input: { expression: '1 + 1' } }] }, { text: '好' }]))
    full.permissionMode = 'full'
    const fullIO = Object.assign(recordingIO(), { browser: fakeBrowser([]).browser })
    await runTurn(full, { id: 'turn-1', text: '算一下' }, fullIO)
    expect(fullIO.permissionRequests).toBe(0)
  })

  test('换浏览器：换到用户的 Chrome 先问，拒绝了不换；换回内置浏览器不问', async () => {
    const model = scriptedModel([
      { toolCalls: [{ name: 'browser_switch', input: { browser: 'chrome' } }] },
      { toolCalls: [{ name: 'browser_switch', input: { browser: 'chrome' } }] },
      { toolCalls: [{ name: 'browser_switch', input: { browser: 'builtin' } }] },
      { toolCalls: [{ name: 'browser_switch', input: { browser: 'firefox' } }] },
      { text: '好' },
    ])
    const session = await withBrowser(model)
    const fake = fakeBrowser([])
    const choices = ['reject_once', 'allow_once']
    const asked: string[] = []
    const io = Object.assign(recordingIO(), {
      browser: fake.browser,
      requestPermission: async (call: { title?: string | null }) => {
        asked.push(call.title ?? '')
        return choices.shift() ?? null
      },
    })
    await runTurn(session, { id: 'turn-1', text: '用我的 Chrome' }, io)
    expect(asked).toEqual(['让智能体改用你的 Chrome（会用你在那里的登录状态）', '让智能体改用你的 Chrome（会用你在那里的登录状态）'])
    expect(fake.actions).toEqual([
      { action: 'switch', browser: 'chrome' },
      { action: 'switch', browser: 'builtin' },
    ])
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('did not allow using their own browser')
    expect(JSON.stringify(model.doStreamCalls[4]?.prompt)).toContain('Invalid')
    const titles = io.updates.flatMap((update) => (update.sessionUpdate === 'tool_call' ? [update.title] : []))
    expect(titles.slice(0, 3)).toEqual(['浏览器 改用你的 Chrome', '浏览器 改用你的 Chrome', '浏览器 改用内置浏览器'])
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
