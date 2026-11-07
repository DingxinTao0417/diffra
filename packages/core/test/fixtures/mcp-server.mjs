// 测试用的 MCP 服务器（stdio，按行收发 JSON-RPC），不依赖 SDK，core 单测和桌面端 e2e 共用。
// 工具：echo（声明只读）、write_note（在当前目录写 note.txt）、whoami（返回环境变量和目录）、fail（返回出错）
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const tools = [
  {
    name: 'echo',
    description: 'Echo the text back',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'write_note',
    description: 'Write note.txt in the working directory',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  { name: 'whoami', description: 'Show the token and working directory', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'fail', description: 'Always fails', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
]

const prompts = [{ name: 'review', description: 'Review a file', arguments: [{ name: 'file', description: 'File to review', required: true }] }]

const text = (value) => ({ content: [{ type: 'text', text: value }] })

function handle(method, params) {
  switch (method) {
    case 'initialize':
      return { protocolVersion: params.protocolVersion, capabilities: { tools: {}, prompts: {} }, serverInfo: { name: 'diffra-test', version: '1.0.0' } }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools }
    case 'tools/call': {
      const args = params.arguments ?? {}
      if (params.name === 'echo') return text(`echo: ${args.text}`)
      if (params.name === 'write_note') {
        writeFileSync('note.txt', `${args.text}\n`)
        return text('saved note.txt')
      }
      if (params.name === 'whoami') return text(`token=${process.env.DIFFRA_TEST_TOKEN ?? 'none'} cwd=${process.cwd()}`)
      if (params.name === 'fail') return { ...text('something broke'), isError: true }
      throw { code: -32602, message: `Unknown tool ${params.name}` }
    }
    case 'prompts/list':
      return { prompts }
    case 'prompts/get':
      return { messages: [{ role: 'user', content: { type: 'text', text: `Please review ${params.arguments?.file}` } }] }
    default:
      throw { code: -32601, message: `Method not found: ${method}` }
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  const message = JSON.parse(line)
  if (message.id === undefined) return
  let reply
  try {
    reply = { jsonrpc: '2.0', id: message.id, result: handle(message.method, message.params ?? {}) }
  } catch (error) {
    reply = { jsonrpc: '2.0', id: message.id, error: { code: error.code ?? -32603, message: error.message ?? String(error) } }
  }
  process.stdout.write(`${JSON.stringify(reply)}\n`)
})
