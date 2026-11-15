import { resolve } from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk'

export const MCP_SERVER_SCRIPT = resolve(import.meta.dirname, 'fixtures', 'mcp-server.mjs')
// 多了两个带界面的工具（第 683 步）
export const MCP_UI_SERVER_SCRIPT = resolve(import.meta.dirname, 'fixtures', 'mcp-ui-server.mjs')

// 用当前的 Node 跑测试用的 MCP 服务器
export function testMcpServer(name = 'demo', token = 'secret-token', env: Array<{ name: string; value: string }> = []): McpServer {
  return { name, command: process.execPath, args: [MCP_SERVER_SCRIPT], env: [{ name: 'DIFFRA_TEST_TOKEN', value: token }, ...env] }
}
