import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Transform, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { ACP_MAX_MESSAGE_BYTES, type ExternalAgentErrorKind, type ExternalAgentSpec } from '../protocol.js'
import { CORE_VERSION } from '../version.js'
import { killTree, locateCommand, spawnCommand } from './spawn.js'

// 第一次用 npx 起适配器时要先下载，握手给足时间；DIFFRA_EXTERNAL_INIT_TIMEOUT_MS 只给测试缩短用
export function initTimeoutMs(): number {
  return Number(process.env.DIFFRA_EXTERNAL_INIT_TIMEOUT_MS) || 120_000
}
// 建会话、接上原来的会话：Claude Code 的适配器要再起一个 claude 进程，比握手慢
const SESSION_TIMEOUT_MS = 120_000
// 出错时给用户看的进程输出只留末尾这么多字
const TAIL_CHARS = 4000
// 握手失败后等进程退出、拿到退出码和输出的时间
const EXIT_WAIT_MS = 3000

// 老版本的 CLI 不认 --acp 这类参数时常见的报错
const UNKNOWN_FLAG = /unknown (option|argument|flag|command)|unrecognized (option|argument)|unexpected argument|invalid option|did you mean|no such option/i

export class ExternalAgentError extends Error {
  constructor(
    readonly kind: ExternalAgentErrorKind,
    message: string,
    readonly detail: string | null = null,
  ) {
    super(message)
  }
}

export interface ExternalAgentHandlers {
  update(sessionId: string, update: acp.SessionUpdate): void
  permission(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>
}

export interface ExitInfo {
  code: number | null
  signal: string | null
  // 进程没起来（spawn 的 error 事件）
  error: Error | null
}

function describeExit(info: ExitInfo): string {
  if (info.error) return info.error.message
  if (info.signal) return `被信号 ${info.signal} 结束`
  return `退出码 ${info.code ?? '未知'}`
}

function isAuthError(error: unknown): boolean {
  if (error instanceof acp.RequestError && error.code === -32000) return true
  const message = error instanceof Error ? error.message : String(error)
  return /auth(entication)? required|not (logged|signed) in|please (log|sign) ?in|unauthenticated|\/login/i.test(message)
}

// 智能体报的错，原文在 data.details 或 message 里
function agentMessage(error: unknown): string {
  const data = error instanceof acp.RequestError ? error.data : null
  const details = typeof data === 'object' && data !== null && 'details' in data ? data.details : null
  if (typeof details === 'string' && details) return details
  return error instanceof Error ? error.message : String(error)
}

// 一个外接智能体的进程和它的 ACP 连接。Diffra 是它的客户端：不声明文件和终端能力，它用自己的工具读写文件、跑命令，
// 要用户确认的事经 session/request_permission 问过来
export class ExternalAgentProcess {
  private exitInfo: ExitInfo | null = null

  private constructor(
    readonly spec: ExternalAgentSpec,
    readonly path: string,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly connection: acp.ClientConnection,
    readonly exited: Promise<ExitInfo>,
    private readonly output: { stderr: string },
    readonly info: acp.InitializeResponse,
  ) {
    void exited.then((info) => (this.exitInfo = info))
  }

  get alive(): boolean {
    return this.exitInfo === null
  }

  get loadSession(): boolean {
    return this.info.agentCapabilities?.loadSession === true
  }

  get images(): boolean {
    return this.info.agentCapabilities?.promptCapabilities?.image === true
  }

  // 起进程、握手。signal 是用户点了停止（第一次 npx 下载时可能要等很久）
  static async start(spec: ExternalAgentSpec, cwd: string, handlers: ExternalAgentHandlers, signal?: AbortSignal): Promise<ExternalAgentProcess> {
    const env: NodeJS.ProcessEnv = { ...process.env, ...Object.fromEntries(spec.env.map((item) => [item.name, item.value])) }
    const path = await locateCommand(spec.command, env)
    if (!path) throw new ExternalAgentError('not-installed', `找不到命令「${spec.command}」：${spec.name} 可能还没装，或者装在了 Diffra 找不到的位置（可以在设置里填完整路径）`)
    const child = spawnCommand(path, spec.args, { cwd, env })
    const output = { stderr: '', stdout: '' }
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => (output.stderr = (output.stderr + chunk).slice(-TAIL_CHARS)))
    const exited = new Promise<ExitInfo>((resolve) => {
      child.once('error', (error) => resolve({ code: null, signal: null, error }))
      child.once('exit', (code, signal) => resolve({ code, signal, error: null }))
    })
    // 握手之前 stdout 上的内容留一份：老版本不认 --acp 时，用法说明打在 stdout 上
    let handshaking = true
    const tap = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (handshaking) output.stdout = (output.stdout + chunk.toString('utf8')).slice(-TAIL_CHARS)
        callback(null, chunk)
      },
    })
    child.stdout.pipe(tap)
    const app = acp
      .client({ name: 'diffra' })
      .onNotification(acp.methods.client.session.update, ({ params }) => handlers.update(params.sessionId, params.update))
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => handlers.permission(params))
    const connection = app.connect(acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(tap) as ReadableStream<Uint8Array>, { maxMessageBytes: ACP_MAX_MESSAGE_BYTES }))
    const timeoutMs = initTimeoutMs()
    const timeout = AbortSignal.timeout(timeoutMs)
    const cancel = AbortSignal.any([timeout, ...(signal ? [signal] : [])])
    const fail = async (error: ExternalAgentError): Promise<never> => {
      connection.close()
      killTree(child)
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, EXIT_WAIT_MS).unref())])
      throw error
    }
    let response: acp.InitializeResponse
    try {
      response = await Promise.race([
        connection.agent.request(
          acp.methods.agent.initialize,
          {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo: { name: 'diffra', version: CORE_VERSION },
          },
          { cancellationSignal: cancel, stopWaitingOnCancel: true },
        ),
        exited.then((info): never => {
          throw info
        }),
      ])
    } catch (error) {
      if (signal?.aborted) return fail(new ExternalAgentError('exited', `${spec.name} 还在启动，已停止`))
      if (timeout.aborted) return fail(new ExternalAgentError('timeout', `${spec.name} 在 ${Math.round(timeoutMs / 1000)} 秒内没有应答`, tail(output)))
      // 等一会儿进程退出，拿到退出码和最后的输出再判断
      const info = await Promise.race([exited, new Promise<null>((resolve) => setTimeout(() => resolve(null), EXIT_WAIT_MS).unref())])
      const detail = tail(output)
      if (info?.error) return fail(new ExternalAgentError('start-failed', `${spec.name} 启动失败：${info.error.message}`, detail))
      if (detail && UNKNOWN_FLAG.test(detail)) return fail(new ExternalAgentError('version', `${spec.name} 不认识启动参数，可能版本太旧、还不支持 ACP，请升级后再试`, detail))
      if (info) return fail(new ExternalAgentError('start-failed', `${spec.name} 启动后就退出了（${describeExit(info)}）`, detail))
      return fail(new ExternalAgentError('version', `${spec.name} 没有按 ACP 协议应答，可能版本太旧、还不支持 ACP`, detail ?? agentMessage(error)))
    } finally {
      handshaking = false
    }
    if (response.protocolVersion !== acp.PROTOCOL_VERSION) {
      return fail(new ExternalAgentError('version', `${spec.name} 用的 ACP 协议版本是 ${response.protocolVersion}，Diffra 用的是 ${acp.PROTOCOL_VERSION}，请换成对得上的版本`))
    }
    return new ExternalAgentProcess(spec, path, child, connection, exited, output, response)
  }

  // 请求和进程退出赛跑：进程中途退出时不一直等
  private async race<T>(request: Promise<T>): Promise<T> {
    return Promise.race([
      request.catch(async (error: unknown) => {
        throw await this.toError(error)
      }),
      this.exited.then((info): never => {
        throw this.exitError(info)
      }),
    ])
  }

  private exitError(info: ExitInfo): ExternalAgentError {
    return new ExternalAgentError('exited', `${this.spec.name} 的进程退出了（${describeExit(info)}）`, this.output.stderr.trim() || null)
  }

  // 进程退出时连接先断、请求先失败，退出事件稍后才到：等一会儿再判断是不是进程退出了
  private async toError(error: unknown): Promise<ExternalAgentError> {
    if (error instanceof ExternalAgentError) return error
    if (isAuthError(error)) {
      return new ExternalAgentError('auth', `${this.spec.name} 还没登录：先在终端里运行它，按提示登录后再发（账号由它自己管理，Diffra 不经手）`, agentMessage(error))
    }
    const info = this.exitInfo ?? (await Promise.race([this.exited, new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000).unref())]))
    if (info) return this.exitError(info)
    return new ExternalAgentError('start-failed', `${this.spec.name} 出错：${agentMessage(error)}`, this.output.stderr.trim() || null)
  }

  async newSession(cwd: string): Promise<string> {
    const response = await this.race(
      this.connection.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] }, { cancellationSignal: AbortSignal.timeout(SESSION_TIMEOUT_MS), stopWaitingOnCancel: true }),
    )
    return response.sessionId
  }

  // 接上原来的会话：智能体会把历史当会话更新再发一遍，调用方在这期间不转发
  async resumeSession(sessionId: string, cwd: string): Promise<void> {
    await this.race(
      this.connection.agent.request(acp.methods.agent.session.load, { sessionId, cwd, mcpServers: [] }, { cancellationSignal: AbortSignal.timeout(SESSION_TIMEOUT_MS), stopWaitingOnCancel: true }),
    )
  }

  // 一轮可能跑很久，不设时限；停止走 cancel，进程退出由 race 兜住
  async prompt(sessionId: string, prompt: acp.ContentBlock[]): Promise<acp.StopReason> {
    const response = await this.race(this.connection.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt }))
    return response.stopReason
  }

  cancel(sessionId: string): void {
    this.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => {})
  }

  // 结束进程并等它退出（最多几秒）：删除任务后接着要删它的文件夹，Windows 上进程还占着当前目录就删不掉
  async dispose(): Promise<void> {
    this.connection.close()
    killTree(this.child)
    await Promise.race([this.exited, new Promise((resolve) => setTimeout(resolve, EXIT_WAIT_MS).unref())])
  }
}

function tail(output: { stderr: string; stdout: string }): string | null {
  const text = [output.stderr.trim(), output.stdout.trim()].filter(Boolean).join('\n')
  return text ? text.slice(-TAIL_CHARS) : null
}
