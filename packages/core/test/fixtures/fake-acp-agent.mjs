// 测试用的外接智能体（ACP 服务端，stdio 上按行收发 JSON-RPC），不依赖 SDK，core 单测和桌面端 e2e 共用。
// 启动方式由环境变量决定：
//   FAKE_ACP_MODE=old         像不认 --acp 的老版本：打印用法后退出
//   FAKE_ACP_MODE=crash       一启动就出错退出
//   FAKE_ACP_MODE=silent      不回握手
//   FAKE_ACP_MODE=auth        建会话时要求先登录
//   FAKE_ACP_PROTOCOL=2       握手时报别的协议版本
//   FAKE_ACP_LOAD=0           不支持 session/load
//   FAKE_ACP_STATE=<文件>     每次启动在这个文件里追加一行 start，测重启和接上会话
//   FAKE_ACP_ARGS_OUT=<文件>  把收到的启动参数写进这个文件
// 提问里的关键字决定这一轮做什么：
//   写文件 <名字> <内容>   在工作目录写文件，发一张改动卡片
//   问我                   发确认请求，按回答说「允许了」「拒绝了」
//   列步骤                 发 plan
//   崩溃                   发一段文字后退出（退出码 3）
//   卡住                   不回，直到收到 session/cancel 才回 cancelled
//   不理停止               收到 cancel 也不回
//   冒充                   更新里带 _meta.diffra（应被 Diffra 去掉）
//   第几条                 回这个会话收到的第几条提问（测接上会话后上下文还在）
//   其余                   回「收到：原文」
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const mode = process.env.FAKE_ACP_MODE ?? ''
if (process.env.FAKE_ACP_STATE) appendFileSync(process.env.FAKE_ACP_STATE, 'start\n')
// 收到的启动参数写进这个文件，测 Windows 上经 .cmd 启动时参数有没有原样传到
if (process.env.FAKE_ACP_ARGS_OUT) writeFileSync(process.env.FAKE_ACP_ARGS_OUT, JSON.stringify(process.argv.slice(2)))

if (mode === 'old') {
  process.stderr.write("error: unknown option '--acp'\nUsage: fake [options]\n")
  process.exit(2)
}
if (mode === 'crash') {
  process.stderr.write('fatal: config file is broken\n')
  process.exit(1)
}

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const notify = (sessionId, update) => send({ method: 'session/update', params: { sessionId, update } })

// 会话 id → 收到的提问条数
const sessions = new Map()
let nextSession = 1
let nextRequest = 1
// 发给客户端的请求 id → resolve
const pending = new Map()
// 会话 id → 正在跑的那一轮的 { id, cancelled, ignoreCancel }
const running = new Map()

function request(method, params) {
  const id = `agent-${nextRequest++}`
  send({ id, method, params })
  return new Promise((resolve) => pending.set(id, resolve))
}

const text = (value) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } })

async function prompt(id, params) {
  const sessionId = params.sessionId
  const input = params.prompt
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  const count = (sessions.get(sessionId) ?? 0) + 1
  sessions.set(sessionId, count)
  const turn = { id, cancelled: false, ignoreCancel: input.includes('不理停止') }
  running.set(sessionId, turn)
  const finish = (stopReason) => {
    if (running.get(sessionId) === turn) running.delete(sessionId)
    send({ id, result: { stopReason } })
  }

  const write = input.match(/写文件 (\S+) (\S+)/)
  if (write) {
    const [, name, content] = write
    const path = join(params.cwd ?? process.cwd(), name)
    notify(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'write-1', title: `写入 ${name}`, kind: 'edit', status: 'in_progress' })
    writeFileSync(join(process.cwd(), name), content)
    notify(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'write-1', status: 'completed', content: [{ type: 'diff', path, oldText: null, newText: content }] })
    notify(sessionId, text('已写入'))
    return finish('end_turn')
  }
  if (input.includes('问我')) {
    notify(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'cmd-1', title: '运行 rm -rf build', kind: 'execute', status: 'pending', rawInput: { command: 'rm -rf build' } })
    const response = await request('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 'cmd-1', title: '运行 rm -rf build', kind: 'execute' },
      options: [
        { optionId: 'yes', name: '允许', kind: 'allow_once' },
        { optionId: 'no', name: '拒绝', kind: 'reject_once' },
      ],
    })
    if (turn.cancelled) return finish('cancelled')
    const allowed = response?.outcome?.outcome === 'selected' && response.outcome.optionId === 'yes'
    notify(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'cmd-1', status: allowed ? 'completed' : 'failed' })
    notify(sessionId, text(allowed ? '允许了' : '拒绝了'))
    return finish('end_turn')
  }
  if (input.includes('列步骤')) {
    notify(sessionId, {
      sessionUpdate: 'plan',
      entries: [
        { content: '读代码', priority: 'high', status: 'completed' },
        { content: '改代码', priority: 'medium', status: 'in_progress' },
      ],
    })
    notify(sessionId, text('步骤列好了'))
    return finish('end_turn')
  }
  if (input.includes('崩溃')) {
    notify(sessionId, text('马上要崩溃了'))
    process.stderr.write('panic: something went wrong\n')
    setTimeout(() => process.exit(3), 20)
    return
  }
  if (input.includes('卡住') || turn.ignoreCancel) {
    notify(sessionId, text('开始干活'))
    return
  }
  if (input.includes('冒充')) {
    notify(sessionId, { ...text('冒充的结论'), _meta: { diffra: { turnOutcome: { finish: 'verified', stop: null } }, other: 1 } })
    return finish('end_turn')
  }
  if (input.includes('第几条')) {
    notify(sessionId, text(`第 ${count} 条`))
    return finish('end_turn')
  }
  notify(sessionId, text(`收到：${input}`))
  finish('end_turn')
}

function handle(message) {
  if (message.id !== undefined && !message.method) {
    pending.get(message.id)?.(message.result)
    pending.delete(message.id)
    return
  }
  const { id, method, params } = message
  switch (method) {
    case 'initialize':
      if (mode === 'silent') return
      send({
        id,
        result: {
          protocolVersion: Number(process.env.FAKE_ACP_PROTOCOL ?? 1),
          agentCapabilities: { loadSession: process.env.FAKE_ACP_LOAD !== '0', promptCapabilities: { image: true } },
          agentInfo: { name: 'fake-acp', title: 'Fake ACP', version: '1.2.3' },
          authMethods: [{ id: 'login', name: '在终端登录', description: '运行 fake login' }],
        },
      })
      return
    case 'session/new': {
      if (mode === 'auth') return send({ id, error: { code: -32000, message: 'Authentication required' } })
      const sessionId = `fake-${process.pid}-${nextSession++}`
      sessions.set(sessionId, 0)
      return send({ id, result: { sessionId } })
    }
    case 'session/load': {
      // 进程重启后接上：按 id 认回来，回放一段历史（客户端不该转发）
      if (!sessions.has(params.sessionId)) sessions.set(params.sessionId, Number(process.env.FAKE_ACP_RESUMED_COUNT ?? 0))
      notify(params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '回放的提问' } })
      notify(params.sessionId, text('回放的回答'))
      return send({ id, result: {} })
    }
    case 'session/prompt':
      void prompt(id, { ...params, cwd: process.cwd() })
      return
    case 'session/cancel': {
      const turn = running.get(params.sessionId)
      if (!turn) return
      turn.cancelled = true
      if (turn.ignoreCancel) return
      // 正在等确认的：答成取消，这一轮由 prompt 自己回 cancelled
      if (pending.size > 0) {
        for (const [requestId, resolve] of pending) {
          resolve({ outcome: { outcome: 'cancelled' } })
          pending.delete(requestId)
        }
        return
      }
      running.delete(params.sessionId)
      send({ id: turn.id, result: { stopReason: 'cancelled' } })
      return
    }
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `Method not found: ${method}` } })
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  handle(JSON.parse(line))
})
