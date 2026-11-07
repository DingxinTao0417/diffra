import type { McpServer } from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { McpPool } from '../src/mcp.js'
import { type HttpMcpServer, startHttpMcpServer } from './fixtures/mcp-http-server.js'

const TOKEN = ['http', 'test', 'token'].join('-')

let remote: HttpMcpServer
let pool: McpPool

beforeEach(async () => {
  remote = await startHttpMcpServer(TOKEN)
  pool = new McpPool()
})

afterEach(async () => {
  await pool.closeAll()
  await remote.close()
})

const server = (token: string): McpServer => ({ type: 'http', name: 'remote', url: remote.url, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] })

describe('MCP 远程 HTTP', () => {
  test('带上请求头连上（服务器用 SSE 回复）：列出工具和 prompt，调用工具，展开 prompt', async () => {
    const [status] = await pool.status('unused', [server(TOKEN)], false)
    expect(status).toMatchObject({ name: 'remote', transport: 'http', state: 'connected', error: null })
    expect(status?.tools.map((item) => item.name)).toEqual(['echo'])
    expect(status?.prompts).toEqual([{ name: 'summarize', description: 'Summarize a topic', arguments: [{ name: 'topic', description: '', required: true }] }])

    const turn = await pool.turnTools('unused', [server(TOKEN)])
    expect(turn.failures).toEqual([])
    const echo = turn.byName.get('mcp__remote__echo')
    expect(echo).toMatchObject({ server: 'remote', tool: 'echo', readOnly: true })
    expect(await pool.callTool(echo!, { text: 'hi' }, new AbortController().signal)).toEqual({ text: 'remote echo: hi', isError: false })
    expect(await pool.promptText('unused', server(TOKEN), 'summarize', { topic: 'MCP' })).toBe('Summarize MCP')
    expect(new Set(remote.authorizations())).toEqual(new Set([`Bearer ${TOKEN}`]))
  })

  test('密钥不对：状态里说明原因，这一轮不用它的工具；换成对的密钥就连上', async () => {
    const [failed] = await pool.status('unused', [server('wrong')], false)
    expect(failed).toMatchObject({ name: 'remote', state: 'failed', tools: [] })
    expect(failed?.error).toBe('HTTP 401，检查请求头里的密钥：Streamable HTTP error: Error POSTing to endpoint: invalid token')
    const turn = await pool.turnTools('unused', [server('wrong')])
    expect(turn.failures.map((item) => item.title)).toEqual(['MCP 服务器「remote」不可用，这一轮不用它的工具'])

    const [fixed] = await pool.status('unused', [server(TOKEN)], false)
    expect(fixed?.state).toBe('connected')
  })

  test('连接被关掉以后（配置不再用、或者服务器断了会话）再用会重新建会话', async () => {
    expect((await pool.status('unused', [server(TOKEN)], false))[0]?.state).toBe('connected')
    await pool.retain([])
    const turn = await pool.turnTools('unused', [server(TOKEN)])
    expect(turn.failures).toEqual([])
    expect(await pool.callTool(turn.byName.get('mcp__remote__echo')!, { text: 'again' }, new AbortController().signal)).toEqual({
      text: 'remote echo: again',
      isError: false,
    })
  })
})
