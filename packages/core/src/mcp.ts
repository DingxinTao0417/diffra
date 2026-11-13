import { createHash } from 'node:crypto'
import type { McpServer } from '@agentclientprotocol/sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult, Prompt, Tool } from '@modelcontextprotocol/sdk/types.js'
import { jsonSchema, type JSONSchema7, tool, type ToolSet } from 'ai'
import { truncateForModel } from './process.js'
import type { McpServerStatus } from './protocol.js'
import { CORE_VERSION } from './version.js'

// 连接（含首次用 npx 下载）、列工具、调工具的等待上限
const CONNECT_TIMEOUT_MS = 60_000
const LIST_TIMEOUT_MS = 30_000
// 工具有进度通知时重新计时；没有进度最多等 5 分钟，总共最多 30 分钟
const CALL_TIMEOUT_MS = 300_000
const CALL_MAX_TOTAL_MS = 1_800_000
// 连不上的服务器过这么久才在下一轮重试，免得每轮都等一次超时
const RETRY_AFTER_MS = 30_000
// 发给模型的 MCP 工具最多这么多个；OpenAI 一次最多接受 128 个工具
const MAX_MCP_TOOLS = 100
const MAX_DESCRIPTION_CHARS = 4000
const MAX_PAGES = 10
// 留着最后这么多 stderr，连不上时拿来说明原因
const STDERR_TAIL_CHARS = 2000

export interface McpToolRef {
  server: string
  tool: string
  readOnly: boolean
  key: string
}

// 这一轮可用的 MCP 工具：发给模型的定义、模型用的名字到服务器和工具的对应、连不上的服务器
export interface McpTurnTools {
  tools: ToolSet
  chars: number
  byName: Map<string, McpToolRef>
  // 这一轮用不了的部分，开始时逐条提示
  failures: Array<{ title: string; detail: string }>
}

type Entry =
  | { state: 'connecting'; promise: Promise<void> }
  | { state: 'connected'; client: Client; tools: Tool[] }
  | { state: 'failed'; error: string; at: number }

function transportOf(server: McpServer): 'stdio' | 'http' | 'sse' {
  return 'type' in server ? server.type : 'stdio'
}

// 模型看到的工具名：mcp__服务器__工具，只留模型接口允许的字符，超长时截断加哈希
export function mcpToolName(server: string, toolName: string): string {
  const name = `mcp__${server}__${toolName}`.replace(/[^A-Za-z0-9_-]/g, '_')
  if (name.length <= 64) return name
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 8)
  return `${name.slice(0, 55)}_${hash}`
}

// 远程服务器的错误带上 HTTP 状态码：服务器回的说明可能是空的
function errorText(error: unknown): string {
  if (error instanceof StreamableHTTPError && error.code !== undefined && error.code > 0) {
    const hint = error.code === 401 || error.code === 403 ? '，检查请求头里的密钥' : ''
    return `HTTP ${error.code}${hint}：${error.message}`
  }
  return error instanceof Error ? error.message : String(error)
}

// 同一个项目、同样配置的服务器在各个任务间共用一个连接；stdio 服务器在项目目录里启动
export class McpPool {
  private readonly entries = new Map<string, Entry>()
  private readonly stderr = new Map<string, string>()

  private key(cwd: string, server: McpServer): string {
    return JSON.stringify([transportOf(server) === 'stdio' ? cwd : null, server])
  }

  // 连上为止；连不上记下原因，过一阵或用户要求时再试
  private async ensure(cwd: string, server: McpServer, retry: boolean): Promise<Entry> {
    const key = this.key(cwd, server)
    const current = this.entries.get(key)
    if (current?.state === 'connecting') await current.promise
    else if (!current || (current.state === 'failed' && (retry || Date.now() - current.at > RETRY_AFTER_MS))) {
      const entry: Entry = { state: 'connecting', promise: this.connect(key, cwd, server, () => this.entries.get(key) === entry) }
      this.entries.set(key, entry)
      await entry.promise
    }
    return this.entries.get(key) ?? { state: 'failed', error: '连接已关闭', at: Date.now() }
  }

  // current：自己那个「连接中」还在不在；被 retain 移走或换成了新的连接就关掉，不写回
  private async connect(key: string, cwd: string, server: McpServer, current: () => boolean): Promise<void> {
    const client = new Client({ name: 'diffra', version: CORE_VERSION })
    try {
      const kind = transportOf(server)
      if (kind === 'sse') throw new Error('不支持 SSE 方式的 MCP 服务器，请改用 HTTP')
      if (kind === 'http' && 'url' in server) {
        const headers = Object.fromEntries(server.headers.map((header) => [header.name, header.value]))
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }), { timeout: CONNECT_TIMEOUT_MS })
      } else if ('command' in server) {
        const transport = new StdioClientTransport({
          command: server.command,
          args: server.args,
          env: Object.fromEntries(server.env.map((item) => [item.name, item.value])),
          cwd,
          stderr: 'pipe',
        })
        this.stderr.set(key, '')
        transport.stderr?.on('data', (chunk: Buffer) => {
          this.stderr.set(key, ((this.stderr.get(key) ?? '') + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS))
        })
        await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS })
      }
      client.onclose = () => {
        const entry = this.entries.get(key)
        if (entry?.state === 'connected' && entry.client === client) this.entries.set(key, { state: 'failed', error: '连接已断开', at: 0 })
      }
      const tools = await this.listTools(client)
      if (current()) this.entries.set(key, { state: 'connected', client, tools })
      else await client.close().catch((error: unknown) => console.error('[mcp] 关闭连接失败', error))
    } catch (error) {
      await client.close().catch(() => {})
      if (!current()) return
      const stderr = this.stderr.get(key)?.trim()
      const message = stderr ? `${errorText(error)}\n${stderr}` : errorText(error)
      console.error(`[mcp] 服务器 ${server.name} 连接失败`, error)
      this.entries.set(key, { state: 'failed', error: message, at: Date.now() })
    }
  }

  private async listTools(client: Client): Promise<Tool[]> {
    if (!client.getServerCapabilities()?.tools) return []
    const tools: Tool[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: LIST_TIMEOUT_MS })
      tools.push(...result.tools)
      cursor = result.nextCursor
      if (!cursor) break
    }
    return tools
  }

  private async listPrompts(client: Client): Promise<Prompt[]> {
    if (!client.getServerCapabilities()?.prompts) return []
    const prompts: Prompt[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await client.listPrompts(cursor ? { cursor } : undefined, { timeout: LIST_TIMEOUT_MS })
      prompts.push(...result.prompts)
      cursor = result.nextCursor
      if (!cursor) break
    }
    return prompts
  }

  // 一轮开始时取各服务器当前的工具；列工具失败当作连接坏了，下一轮重连
  async turnTools(cwd: string, servers: McpServer[]): Promise<McpTurnTools> {
    const result: McpTurnTools = { tools: {}, chars: 0, byName: new Map(), failures: [] }
    const listed = await Promise.all(
      servers.map(async (server) => {
        const entry = await this.ensure(cwd, server, false)
        if (entry.state !== 'connected') return { server, tools: [] as Tool[], error: entry.state === 'failed' ? entry.error : '还在连接' }
        try {
          entry.tools = await this.listTools(entry.client)
          return { server, tools: entry.tools, error: null }
        } catch (error) {
          this.entries.set(this.key(cwd, server), { state: 'failed', error: errorText(error), at: Date.now() })
          await entry.client.close().catch(() => {})
          return { server, tools: [] as Tool[], error: errorText(error) }
        }
      }),
    )
    let skipped = 0
    for (const { server, tools, error } of listed) {
      if (error) result.failures.push({ title: `MCP 服务器「${server.name}」不可用，这一轮不用它的工具`, detail: error })
      for (const item of tools) {
        const name = mcpToolName(server.name, item.name)
        if (result.byName.has(name)) continue
        if (result.byName.size >= MAX_MCP_TOOLS) {
          skipped++
          continue
        }
        const description = (item.description ?? item.title ?? '').slice(0, MAX_DESCRIPTION_CHARS)
        result.tools[name] = tool({ description: `[MCP ${server.name}] ${description}`, inputSchema: jsonSchema(item.inputSchema as JSONSchema7) })
        result.byName.set(name, { server: server.name, tool: item.name, readOnly: item.annotations?.readOnlyHint === true, key: this.key(cwd, server) })
        result.chars += name.length + description.length + JSON.stringify(item.inputSchema).length
      }
    }
    if (skipped > 0) result.failures.push({ title: `MCP 工具超过 ${MAX_MCP_TOOLS} 个，有 ${skipped} 个没有给模型`, detail: '可以在「扩展 → 已安装」里关掉用不到的 MCP 服务器' })
    return result
  }

  async callTool(ref: McpToolRef, input: unknown, signal: AbortSignal): Promise<{ text: string; isError: boolean }> {
    const entry = this.entries.get(ref.key)
    if (entry?.state !== 'connected') throw new Error(`MCP 服务器「${ref.server}」没有连上`)
    const result = (await entry.client.callTool(
      { name: ref.tool, arguments: (input ?? {}) as Record<string, unknown> },
      undefined,
      { signal, timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true, maxTotalTimeout: CALL_MAX_TOTAL_MS },
    )) as CallToolResult
    return { text: truncateForModel(resultText(result)).text, isError: result.isError === true }
  }

  // 设置页、监控和斜杠菜单用：各服务器连上没有、有哪些工具和 prompt
  async status(cwd: string, servers: McpServer[], retry: boolean): Promise<McpServerStatus[]> {
    return Promise.all(
      servers.map(async (server): Promise<McpServerStatus> => {
        const base = { name: server.name, transport: transportOf(server) === 'stdio' ? ('stdio' as const) : ('http' as const) }
        const entry = await this.ensure(cwd, server, retry)
        if (entry.state !== 'connected') return { ...base, state: 'failed', error: entry.state === 'failed' ? entry.error : '还在连接', tools: [], prompts: [] }
        try {
          const prompts = await this.listPrompts(entry.client)
          return {
            ...base,
            state: 'connected',
            error: null,
            tools: entry.tools.map((item) => ({ name: item.name, description: item.description ?? '' })),
            prompts: prompts.map((prompt) => ({
              name: prompt.name,
              description: prompt.description ?? '',
              arguments: (prompt.arguments ?? []).map((arg) => ({ name: arg.name, description: arg.description ?? '', required: arg.required === true })),
            })),
          }
        } catch (error) {
          return { ...base, state: 'failed', error: errorText(error), tools: [], prompts: [] }
        }
      }),
    )
  }

  // 把 prompt 展开成文字，放进输入框给用户看过再发
  async promptText(cwd: string, server: McpServer, name: string, args: Record<string, string>): Promise<string> {
    const entry = await this.ensure(cwd, server, false)
    if (entry.state !== 'connected') throw new Error(`MCP 服务器「${server.name}」没有连上：${entry.state === 'failed' ? entry.error : '还在连接'}`)
    const result = await entry.client.getPrompt({ name, arguments: args }, { timeout: LIST_TIMEOUT_MS })
    return result.messages
      .map((message) => contentText(message.content))
      .filter((text) => text !== '')
      .join('\n\n')
  }

  // 只保留还有任务在用的连接；配置改了以后旧的连接在这里关掉。
  // 先同步移走再等：等的时候新的 ensure 可能放进同一个 key 的新连接，不能被这次顺手删掉。
  // 还在连接的等它连完，connect 发现自己被移走会关掉，调用方接着可能要删 stdio 服务器的工作目录
  async retain(keep: Array<{ cwd: string; servers: McpServer[] }>): Promise<void> {
    const keys = new Set(keep.flatMap(({ cwd, servers }) => servers.map((server) => this.key(cwd, server))))
    const removed = [...this.entries].filter(([key]) => !keys.has(key))
    for (const [key] of removed) {
      this.entries.delete(key)
      this.stderr.delete(key)
    }
    await Promise.all(
      removed.map(([, entry]) => {
        if (entry.state === 'connecting') return entry.promise
        if (entry.state === 'connected') return entry.client.close().catch((error: unknown) => console.error('[mcp] 关闭连接失败', error))
        return undefined
      }),
    )
  }

  // 后台先连上，第一轮不用等
  warmUp(cwd: string, servers: McpServer[]): void {
    for (const server of servers) void this.ensure(cwd, server, false)
  }

  async closeAll(): Promise<void> {
    await this.retain([])
  }
}

type Content = CallToolResult['content'][number]

function contentText(content: Content): string {
  switch (content.type) {
    case 'text':
      return content.text
    case 'resource':
      return 'text' in content.resource ? `[资源 ${content.resource.uri}]\n${content.resource.text}` : `[资源 ${content.resource.uri}，二进制内容未显示]`
    case 'resource_link':
      return `[资源链接 ${content.uri}${content.name ? ` ${content.name}` : ''}]`
    case 'image':
      return `[图片 ${content.mimeType}，未显示]`
    case 'audio':
      return `[音频 ${content.mimeType}，未显示]`
    default:
      return ''
  }
}

function resultText(result: CallToolResult): string {
  const text = result.content
    .map(contentText)
    .filter((part) => part !== '')
    .join('\n')
  if (text) return text
  return result.structuredContent ? JSON.stringify(result.structuredContent, null, 2) : '(no output)'
}
