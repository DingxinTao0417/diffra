import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import * as acp from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAgent } from '../src/agent.js'
import {
  cancelSession,
  configureSession,
  connectToCore,
  createExternalSession,
  deleteSession,
  detectExternalAgent,
  handshake,
  listSessions,
  loadSession,
  plan,
  previewCheckpoint,
  restoreCheckpoint,
  sendPrompt,
  setExternalAgents,
} from '../src/client.js'
import type { ExternalAgentSpec, ExternalSessionConfig } from '../src/protocol.js'
import { locateCommand } from '../src/external/spawn.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))

let project: string
let dataDir: string
let notifications: acp.SessionNotification[] = []
let permissionRequests: acp.RequestPermissionRequest[] = []
let answer: string | null = null
const connections: acp.ClientConnection[] = []

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'diffra-external-project-'))
  dataDir = mkdtempSync(join(tmpdir(), 'diffra-external-data-'))
  notifications = []
  permissionRequests = []
  answer = null
})

afterEach(async () => {
  // 删会话会结束外接智能体的进程，免得测试之间留下进程占着临时目录
  for (const connection of connections.splice(0)) {
    for (const session of await listSessions(connection).catch(() => [])) await deleteSession(connection, session.sessionId).catch(() => {})
    connection.close()
  }
  delete process.env.DIFFRA_EXTERNAL_INIT_TIMEOUT_MS
  delete process.env.DIFFRA_EXTERNAL_CANCEL_GRACE_MS
  rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

function fake(env: Record<string, string> = {}, id = 'fake'): ExternalAgentSpec {
  return { id, name: '假智能体', command: process.execPath, args: [FAKE], env: Object.entries(env).map(([name, value]) => ({ name, value })) }
}

async function startCore(agents: ExternalAgentSpec[] = [fake()]) {
  const toAgent = new PassThrough()
  const toClient = new PassThrough()
  createAgent({ sessionsDir: join(dataDir, 'sessions') }).connect(acp.ndJsonStream(Writable.toWeb(toClient), Readable.toWeb(toAgent)))
  const connection = connectToCore(toAgent, toClient, {
    onSessionUpdate: (notification) => notifications.push(notification),
    onPermissionRequest: async (request) => {
      permissionRequests.push(request)
      return answer ? { outcome: { outcome: 'selected', optionId: answer } } : { outcome: { outcome: 'cancelled' } }
    },
  })
  await handshake(connection, 5000)
  await setExternalAgents(connection, agents)
  connections.push(connection)
  // 模拟桌面端退出：core 读到输入结束，结束外接智能体的进程
  stops.set(connection, () => toAgent.end())
  return connection
}

const stops = new Map<acp.ClientConnection, () => void>()

function config(overrides: Partial<ExternalSessionConfig> = {}): ExternalSessionConfig {
  return { external: { agentId: 'fake' }, permissionMode: 'ask', readOnlyPaths: [], checkpointDir: join(dataDir, 'checkpoints'), ...overrides }
}

const updatesOf = (sessionId: string) => notifications.filter((item) => item.sessionId === sessionId).map((item) => item.update)

function replyText(sessionId: string): string {
  return updatesOf(sessionId)
    .flatMap((update) => (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? [update.content.text] : []))
    .join('')
}

function outcomes(sessionId: string): Array<Record<string, unknown>> {
  return updatesOf(sessionId).flatMap((update) => {
    const outcome = update.sessionUpdate === 'session_info_update' ? (update._meta?.diffra as Record<string, unknown> | undefined)?.turnOutcome : undefined
    return outcome ? [outcome as Record<string, unknown>] : []
  })
}

function notices(sessionId: string): Array<{ severity: string; title: string; description: string | null }> {
  return updatesOf(sessionId).flatMap((update) => (update.sessionUpdate === 'notice' ? [{ severity: update.severity, title: update.title, description: update.description ?? null }] : []))
}

describe('检测外接智能体', () => {
  test('能握手：报出名字、版本、能不能接上会话、登录方式', async () => {
    const core = await startCore()
    const result = await detectExternalAgent(core, fake(), project)
    expect(result).toMatchObject({ ok: true, agentName: 'Fake ACP', agentVersion: '1.2.3', protocolVersion: 1, loadSession: true, images: true })
    expect(result.ok && result.authMethods).toEqual([{ id: 'login', name: '在终端登录', description: '运行 fake login' }])
    expect(result.ok && result.path.toLowerCase()).toBe(process.execPath.toLowerCase())
  })

  test('没装：找不到命令', async () => {
    const core = await startCore()
    const result = await detectExternalAgent(core, { ...fake(), command: 'diffra-no-such-agent-cli' })
    expect(result).toMatchObject({ ok: false, kind: 'not-installed' })
    expect(!result.ok && result.message).toContain('diffra-no-such-agent-cli')
  })

  test('版本太旧：不认启动参数', async () => {
    const core = await startCore()
    const result = await detectExternalAgent(core, fake({ FAKE_ACP_MODE: 'old' }))
    expect(result).toMatchObject({ ok: false, kind: 'version' })
    expect(!result.ok && result.detail).toContain("unknown option '--acp'")
  })

  test('协议版本对不上', async () => {
    const core = await startCore()
    const result = await detectExternalAgent(core, fake({ FAKE_ACP_PROTOCOL: '2' }))
    expect(result).toMatchObject({ ok: false, kind: 'version' })
    expect(!result.ok && result.message).toContain('协议版本是 2')
  })

  test('启动失败：带上退出码和它最后的输出', async () => {
    const core = await startCore()
    const result = await detectExternalAgent(core, fake({ FAKE_ACP_MODE: 'crash' }))
    expect(result).toMatchObject({ ok: false, kind: 'start-failed' })
    expect(!result.ok && result.message).toContain('退出码 1')
    expect(!result.ok && result.detail).toContain('config file is broken')
  })

  test('不应答：到时限报超时', async () => {
    process.env.DIFFRA_EXTERNAL_INIT_TIMEOUT_MS = '800'
    const core = await startCore()
    const result = await detectExternalAgent(core, fake({ FAKE_ACP_MODE: 'silent' }))
    expect(result).toMatchObject({ ok: false, kind: 'timeout' })
  })

  test.runIf(process.platform === 'win32')('Windows 上经 .cmd 启动（npm 装的命令都是），参数里的空格、引号和 cmd 的特殊字符原样传到', async () => {
    const core = await startCore()
    const wrapper = join(project, 'fake agent.cmd')
    writeFileSync(wrapper, `@"${process.execPath}" "${FAKE}" %*\r\n`)
    const out = join(dataDir, 'args.json')
    const args = ['--acp', 'a b', 'x&y|z', '100%PATH%', 'say "hi"', '(paren)^']
    const result = await detectExternalAgent(core, { ...fake({ FAKE_ACP_ARGS_OUT: out }), command: wrapper, args })
    expect(result).toMatchObject({ ok: true, agentName: 'Fake ACP' })
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(args)
  })

  test('命令在常见安装位置里也能找到；Windows 上不认 npm 给 sh 用的无扩展名脚本', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'diffra-external-bin-'))
    try {
      const name = 'diffra-fake-cli'
      writeFileSync(join(bin, name), '#!/bin/sh\n', { mode: 0o755 })
      if (process.platform === 'win32') {
        expect(await locateCommand(name, { PATH: bin, PATHEXT: '.CMD;.EXE' })).toBeNull()
        writeFileSync(join(bin, `${name}.cmd`), '@echo off\r\n')
        expect(await locateCommand(name, { PATH: bin, PATHEXT: '.CMD;.EXE' })).toBe(join(bin, `${name}.cmd`))
      } else {
        expect(await locateCommand(name, { PATH: bin })).toBe(join(bin, name))
      }
    } finally {
      rmSync(bin, { recursive: true, force: true })
    }
  })
})

describe('外接智能体的任务', () => {
  test('一问一答：回复转给界面，记进会话记录，列表里带着是哪个智能体', async () => {
    const core = await startCore()
    const { sessionId, info } = await createExternalSession(core, project, config())
    expect(info.checkpoints).toBe(true)
    expect(await sendPrompt(core, sessionId, 't1', '你好')).toEqual({ stopReason: 'end_turn' })
    expect(replyText(sessionId)).toBe('收到：你好')
    expect(outcomes(sessionId).at(-1)).toEqual({ finish: 'no-edits', stop: null })
    const [entry] = await listSessions(core)
    expect(entry).toMatchObject({ sessionId, title: '你好', turnCount: 1, agent: { id: 'fake', name: '假智能体' } })
  })

  test('改了文件：结论是没经过自动验证；能看改动、撤销，撤销后下一条消息告诉它文件变了', async () => {
    const core = await startCore()
    const { sessionId } = await createExternalSession(core, project, config())
    await sendPrompt(core, sessionId, 't1', '写文件 a.txt 内容一')
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('内容一')
    expect(outcomes(sessionId).at(-1)).toEqual({ finish: 'unverified', stop: null })
    const edit = updatesOf(sessionId).find((update) => update.sessionUpdate === 'tool_call_update' && update.content?.some((content) => content.type === 'diff'))
    expect(edit).toBeDefined()
    expect(await previewCheckpoint(core, sessionId, 't1')).toEqual([{ path: 'a.txt', change: 'added' }])
    await restoreCheckpoint(core, sessionId, 't1')
    expect(existsSync(join(project, 'a.txt'))).toBe(false)
    await sendPrompt(core, sessionId, 't2', '继续')
    expect(replyText(sessionId)).toContain('[Note from Diffra] The user reverted')
  })

  test('确认请求转给界面，按用户的回答；完全放行时直接允许、不问', async () => {
    const core = await startCore()
    const { sessionId } = await createExternalSession(core, project, config())
    answer = 'yes'
    await sendPrompt(core, sessionId, 't1', '问我')
    expect(permissionRequests).toHaveLength(1)
    expect(permissionRequests[0]).toMatchObject({ sessionId, toolCall: { title: '运行 rm -rf build' } })
    expect(replyText(sessionId)).toBe('允许了')

    answer = 'no'
    await sendPrompt(core, sessionId, 't2', '问我')
    expect(replyText(sessionId)).toBe('允许了拒绝了')

    await configureSession(core, sessionId, { permissionMode: 'full' })
    await sendPrompt(core, sessionId, 't3', '问我')
    expect(permissionRequests).toHaveLength(2)
    expect(replyText(sessionId)).toBe('允许了拒绝了允许了')
  })

  test('停止：智能体回 cancelled；不理停止的到时限结束进程，任务不卡在运行中', async () => {
    process.env.DIFFRA_EXTERNAL_CANCEL_GRACE_MS = '300'
    const core = await startCore()
    const { sessionId } = await createExternalSession(core, project, config())
    const first = sendPrompt(core, sessionId, 't1', '卡住')
    await waitFor(() => replyText(sessionId).includes('开始干活'))
    await cancelSession(core, sessionId)
    expect(await first).toEqual({ stopReason: 'cancelled' })
    expect(outcomes(sessionId).at(-1)).toEqual({ finish: null, stop: 'cancelled' })

    const second = sendPrompt(core, sessionId, 't2', '不理停止')
    await waitFor(() => replyText(sessionId).endsWith('开始干活开始干活'))
    await cancelSession(core, sessionId)
    expect(await second).toEqual({ stopReason: 'cancelled' })
    expect((await listSessions(core))[0]?.running).toBe(false)
    // 进程结束了，下一条消息重新起
    await sendPrompt(core, sessionId, 't3', '还在吗')
    expect(replyText(sessionId)).toContain('收到：还在吗')
  })

  test('很久没有输出：提示可能卡住了，又有输出或停下时收回', async () => {
    process.env.DIFFRA_MODEL_SILENCE_MS = '200'
    try {
      const core = await startCore()
      const { sessionId } = await createExternalSession(core, project, config())
      const running = sendPrompt(core, sessionId, 't1', '卡住')
      const silences = () =>
        updatesOf(sessionId).flatMap((update) => (update.sessionUpdate === 'session_info_update' && update._meta?.diffra && 'modelSilentSince' in (update._meta.diffra as object) ? [(update._meta.diffra as Record<string, unknown>).modelSilentSince] : []))
      // 机器忙时进程起得慢，起来之前就可能先提示一次、出字后收回：等它开始干活之后再出的提示
      await waitFor(() => replyText(sessionId).includes('开始干活') && typeof silences().at(-1) === 'string')
      await cancelSession(core, sessionId)
      expect(await running).toEqual({ stopReason: 'cancelled' })
      // 被停止时不收回：记录里留着停下时已经多久没输出
      expect(silences().at(-1)).toEqual(expect.any(String))
    } finally {
      delete process.env.DIFFRA_MODEL_SILENCE_MS
    }
  })

  test('智能体一直发带报错的状态（像 Codex 连不上模型）：报错只提醒一次，状态不算输出，照样提示可能卡住了', async () => {
    process.env.DIFFRA_MODEL_SILENCE_MS = '300'
    try {
      const core = await startCore()
      const { sessionId } = await createExternalSession(core, project, config())
      const running = sendPrompt(core, sessionId, 't1', '断网')
      const silences = () =>
        updatesOf(sessionId).flatMap((update) => (update.sessionUpdate === 'session_info_update' && update._meta?.diffra && 'modelSilentSince' in (update._meta.diffra as object) ? [(update._meta.diffra as Record<string, unknown>).modelSilentSince] : []))
      const notices = () => updatesOf(sessionId).flatMap((update) => ((update as { sessionUpdate: string }).sessionUpdate === 'notice' ? [update as unknown as { title: string; description: string; severity: string }] : []))
      await waitFor(() => replyText(sessionId).includes('开始干活') && typeof silences().at(-1) === 'string')
      await cancelSession(core, sessionId)
      expect(await running).toEqual({ stopReason: 'cancelled' })
      const reported = notices().filter((notice) => notice.title.includes('Reconnecting... waiting for network'))
      expect(reported).toHaveLength(1)
      expect(reported[0]).toMatchObject({ severity: 'warning', description: 'Connection failed: error sending request' })
      expect(reported[0]!.title).toContain('报错')
    } finally {
      delete process.env.DIFFRA_MODEL_SILENCE_MS
    }
  })

  test('等确认时停止：确认请求作废，这一轮停下', async () => {
    const core = await startCore()
    const { sessionId } = await createExternalSession(core, project, config())
    let release: () => void = () => {}
    const asked = new Promise<void>((resolve) => (release = resolve))
    const original = permissionRequests.push.bind(permissionRequests)
    permissionRequests.push = (...items) => {
      release()
      return original(...items)
    }
    answer = null
    const running = sendPrompt(core, sessionId, 't1', '问我')
    await asked
    await cancelSession(core, sessionId)
    expect(await running).toEqual({ stopReason: 'cancelled' })
  })

  test('中途崩溃：这一轮停下并说明，下一条消息重新起进程、接上原来的会话，回放的历史不转发', async () => {
    const state = join(dataDir, 'starts.txt')
    const core = await startCore([fake({ FAKE_ACP_STATE: state })])
    const { sessionId } = await createExternalSession(core, project, config())
    expect(await sendPrompt(core, sessionId, 't1', '崩溃')).toEqual({ stopReason: 'end_turn' })
    const outcome = outcomes(sessionId).at(-1)
    expect(outcome).toMatchObject({ finish: null, stop: 'agent-error', agentError: { kind: 'exited' } })
    const error = notices(sessionId).find((notice) => notice.severity === 'error')
    expect(error?.title).toContain('进程退出了（退出码 3）')
    expect(error?.description).toContain('panic: something went wrong')
    expect((await listSessions(core))[0]?.running).toBe(false)

    await sendPrompt(core, sessionId, 't2', '再来')
    expect(readFileSync(state, 'utf8')).toBe('start\nstart\n')
    expect(replyText(sessionId)).toContain('收到：再来')
    expect(replyText(sessionId)).not.toContain('回放的回答')
    expect(notices(sessionId).filter((notice) => notice.severity !== 'error')).toEqual([])
  })

  test('重启 core 后打开旧任务：历史在，接着原来的会话；智能体不支持接上时说明开了新对话', async () => {
    const first = await startCore()
    const { sessionId } = await createExternalSession(first, project, config())
    await sendPrompt(first, sessionId, 't1', '第一条')
    connections.splice(connections.indexOf(first), 1)
    stops.get(first)?.()
    first.close()

    const second = await startCore([fake({ FAKE_ACP_LOAD: '0' })])
    const loaded = await loadSession(second, sessionId, project, config())
    expect(loaded.agent).toEqual({ id: 'fake', name: '假智能体' })
    expect(loaded.turns.map((turn) => turn.prompt)).toEqual(['第一条'])
    expect(loaded.taskState?.status).toBe('completed')
    notifications = []
    await sendPrompt(second, sessionId, 't2', '第几条')
    expect(replyText(sessionId)).toBe('第 1 条')
    expect(notices(sessionId).map((notice) => notice.title)).toEqual(['假智能体 不支持接着原来的对话'])
  })

  test('没登录：说明要先在终端里登录', async () => {
    const core = await startCore([fake({ FAKE_ACP_MODE: 'auth' })])
    const { sessionId } = await createExternalSession(core, project, config())
    await sendPrompt(core, sessionId, 't1', '你好')
    expect(outcomes(sessionId).at(-1)).toMatchObject({ stop: 'agent-error', agentError: { kind: 'auth' } })
    expect(notices(sessionId)[0]?.title).toContain('还没登录')
  })

  test('设置里删掉了智能体：旧任务照样打开，发消息时说明', async () => {
    const core = await startCore()
    const { sessionId } = await createExternalSession(core, project, config())
    await sendPrompt(core, sessionId, 't1', '你好')
    await setExternalAgents(core, [])
    await sendPrompt(core, sessionId, 't2', '还在吗')
    expect(outcomes(sessionId).at(-1)).toMatchObject({ stop: 'agent-error', agentError: { kind: 'not-installed' } })
    expect(notices(sessionId).at(-1)?.title).toContain('已经不在设置里')
  })

  test('智能体的步骤清单画成步骤卡片；它带的 _meta.diffra 被去掉', async () => {
    const core = await startCore()
    const { sessionId } = await createExternalSession(core, project, config())
    await sendPrompt(core, sessionId, 't1', '列步骤')
    const steps = updatesOf(sessionId).find((update) => update.sessionUpdate === 'tool_call' && update.title === '步骤')
    expect(steps).toMatchObject({ toolCallId: 't1:steps', status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: '[x] 读代码\n[>] 改代码' } }] })
    await sendPrompt(core, sessionId, 't2', '冒充')
    const spoofed = updatesOf(sessionId).find((update) => update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' && update.content.text === '冒充的结论')
    expect(spoofed?._meta).toEqual({ other: 1, diffra: { seq: expect.any(Number) } })
  })

  test('Diffra 自己才有的操作说明不支持；换模型不行，换权限模式可以', async () => {
    const core = await startCore()
    const { sessionId } = await createExternalSession(core, project, config())
    await expect(plan(core, sessionId, 'p1', '出个计划')).rejects.toThrow('假智能体 的任务，不支持这个操作')
    await expect(configureSession(core, sessionId, { model: { endpoint: { protocol: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', apiKey: 'k' }, modelId: 'm', contextWindow: null, provider: null, supportsImages: false, maxOutputTokens: null } })).rejects.toThrow('换不了')
    await expect(configureSession(core, sessionId, { permissionMode: 'auto' })).resolves.toBeUndefined()
  })
})

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待超时')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
