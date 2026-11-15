import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { McpPool, mcpToolName } from '../src/mcp.js'
import { MCP_UI_SERVER_SCRIPT, testMcpServer as testServer } from './mcp-fixture.js'

let project: string
let pool: McpPool

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'diffra-mcp-'))
  pool = new McpPool()
})

afterEach(async () => {
  await pool.closeAll()
  rmSync(project, { recursive: true, force: true })
})

describe('MCP 工具带的界面（第 683 步）', () => {
  test('结果里内嵌的 ui:// HTML 和工具定义 _meta 指的 ui:// 资源都读出来，连同参数和结果交给界面；HTML 不给模型；没有界面的工具照旧', async () => {
    const server: McpServer = { name: 'ui', command: process.execPath, args: [MCP_UI_SERVER_SCRIPT], env: [] }
    const turn = await pool.turnTools(project, [server])
    const signal = new AbortController().signal
    const card = await pool.callTool(turn.byName.get('mcp__ui__ui_card')!, {}, signal)
    expect(card.text).toContain('[界面 ui://diffra-test/card，显示给用户了]')
    expect(card.text).not.toContain('MCP 卡片的界面')
    expect(card.ui).toEqual({ uri: 'ui://diffra-test/card', html: '<div id="card">MCP 卡片的界面</div>', server: 'ui', tool: 'ui_card', input: {}, result: { content: [{ type: 'text', text: 'card shown' }] } })

    const weather = await pool.callTool(turn.byName.get('mcp__ui__ui_weather')!, { city: '杭州' }, signal)
    expect(weather.text).toBe('杭州 21 度')
    expect(weather.ui).toMatchObject({ uri: 'ui://diffra-test/weather', input: { city: '杭州' }, result: { content: [{ type: 'text', text: '杭州 21 度' }], structuredContent: { city: '杭州', temp: 21 } } })
    expect(weather.ui?.html).toContain('ui/initialize')

    expect(await pool.callTool(turn.byName.get('mcp__ui__echo')!, { text: 'hi' }, signal)).toEqual({ text: 'echo: hi', isError: false })
  })
})

describe('MCP 连接', () => {
  test('stdio 服务器在项目目录里启动、带上环境变量；列出工具和 prompt，调用工具，展开 prompt', async () => {
    const server = testServer()
    const [status] = await pool.status(project, [server], false)
    expect(status).toMatchObject({ name: 'demo', transport: 'stdio', state: 'connected', error: null })
    expect(status?.tools.map((item) => item.name)).toEqual(['echo', 'write_note', 'whoami', 'fail'])
    expect(status?.prompts).toEqual([{ name: 'review', description: 'Review a file', arguments: [{ name: 'file', description: 'File to review', required: true }] }])

    const turn = await pool.turnTools(project, [server])
    expect(turn.failures).toEqual([])
    expect([...turn.byName.keys()]).toEqual(['mcp__demo__echo', 'mcp__demo__write_note', 'mcp__demo__whoami', 'mcp__demo__fail'])
    expect(turn.byName.get('mcp__demo__echo')).toMatchObject({ server: 'demo', tool: 'echo', readOnly: true })
    expect(turn.byName.get('mcp__demo__write_note')?.readOnly).toBe(false)
    expect(turn.chars).toBeGreaterThan(0)

    const signal = new AbortController().signal
    expect(await pool.callTool(turn.byName.get('mcp__demo__echo')!, { text: 'hi' }, signal)).toEqual({ text: 'echo: hi', isError: false })
    const whoami = await pool.callTool(turn.byName.get('mcp__demo__whoami')!, {}, signal)
    expect(whoami.text).toContain('token=secret-token')
    // Mac 的临时目录 /var 是 /private/var 的软链接，服务器进程看到的是真实路径
    const cwd = process.platform === 'darwin' ? realpathSync(project) : project
    expect(whoami.text.toLowerCase()).toContain(`cwd=${cwd.toLowerCase()}`)
    expect(await pool.callTool(turn.byName.get('mcp__demo__fail')!, {}, signal)).toEqual({ text: 'something broke', isError: true })
    expect(await pool.promptText(project, server, 'review', { file: 'a.ts' })).toBe('Please review a.ts')
  })

  test('同一个项目和配置共用一个连接；配置不再用时关掉', async () => {
    const server = testServer()
    await pool.status(project, [server], false)
    const first = await pool.turnTools(project, [server])
    await pool.callTool(first.byName.get('mcp__demo__write_note')!, { text: 'one' }, new AbortController().signal)
    expect(readFileSync(join(project, 'note.txt'), 'utf8')).toBe('one\n')

    await pool.retain([])
    await expect(pool.callTool(first.byName.get('mcp__demo__echo')!, { text: 'x' }, new AbortController().signal)).rejects.toThrow('没有连上')
  })

  test('启动失败：说明原因，这一轮不用它的工具，其他服务器照常', async () => {
    const broken: McpServer = { name: 'broken', command: 'diffra-no-such-command', args: [], env: [] }
    const turn = await pool.turnTools(project, [broken, testServer()])
    expect(turn.failures).toHaveLength(1)
    expect(turn.failures[0]?.title).toBe('MCP 服务器「broken」不可用，这一轮不用它的工具')
    expect(turn.byName.size).toBe(4)
    const [status] = await pool.status(project, [broken], false)
    expect(status).toMatchObject({ name: 'broken', state: 'failed', tools: [], prompts: [] })
    expect(status?.error).toBeTruthy()
  })

  test('工具名只留模型接口允许的字符，超长时截断加哈希', () => {
    expect(mcpToolName('github', 'search.issues')).toBe('mcp__github__search_issues')
    const long = mcpToolName('server', 'a'.repeat(100))
    expect(long).toHaveLength(64)
    expect(long).toMatch(/^mcp__server__a+_[0-9a-f]{8}$/)
    expect(mcpToolName('server', 'a'.repeat(100))).toBe(long)
  })
})
