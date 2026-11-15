// 测试用的带界面的 MCP 服务器（第 683 步，stdio，按行收发 JSON-RPC），不依赖 SDK，core 单测和桌面端 e2e 共用；照 mcp-server.mjs 写的，多了两个带界面的工具。
// 工具：echo（声明只读）、write_note（在当前目录写 note.txt）、whoami（返回环境变量和目录）、fail（返回出错）、
// ui_card（结果里内嵌 ui:// 的 HTML，MCP-UI 的写法）、ui_weather（工具定义的 _meta 指向 ui:// 资源，MCP Apps 的写法，界面按 JSON-RPC 握手）
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
  { name: 'ui_card', description: 'Show a card', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  {
    name: 'ui_weather',
    description: 'Show the weather',
    inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    annotations: { readOnlyHint: true },
    _meta: { 'ui/resourceUri': 'ui://diffra-test/weather' },
  },
]

const CARD_HTML = '<div id="card">MCP 卡片的界面</div>'
// MCP Apps 的界面：先 ui/initialize，再发 initialized；收到工具结果后显示；按钮发 ui/message；顺手试一下 tools/call（应该被拒）
const WEATHER_HTML = `<div id="weather">等数据</div><button id="ask">问问明天</button>
<script>
let next = 0
const waiting = {}
const request = (method, params) => new Promise((resolve) => { const id = ++next; waiting[id] = resolve; parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*') })
window.addEventListener('message', (event) => {
  const message = event.data
  if (!message || message.jsonrpc !== '2.0') return
  if (message.id && waiting[message.id]) { waiting[message.id](message.result || message.error); delete waiting[message.id]; return }
  if (message.method === 'ui/notifications/tool-input') document.body.dataset.input = JSON.stringify(message.params.arguments)
  if (message.method === 'ui/notifications/tool-result') document.getElementById('weather').textContent = message.params.structuredContent.city + ' ' + message.params.structuredContent.temp + '度'
})
request('ui/initialize', { protocolVersion: '2025-06-18', appInfo: { name: 'weather', version: '1.0.0' }, appCapabilities: {} }).then((result) => {
  document.body.dataset.host = result.hostInfo.name
  parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, '*')
  request('tools/call', { name: 'write_note', arguments: { text: 'x' } }).then((answer) => { document.body.dataset.toolsCall = answer && answer.code ? 'refused' : 'allowed' })
})
document.getElementById('ask').onclick = () => request('ui/message', { role: 'user', content: [{ type: 'text', text: '明天会下雨吗？' }] })
</script>`
const resources = { 'ui://diffra-test/weather': WEATHER_HTML }

const prompts = [{ name: 'review', description: 'Review a file', arguments: [{ name: 'file', description: 'File to review', required: true }] }]

const text = (value) => ({ content: [{ type: 'text', text: value }] })

function handle(method, params) {
  switch (method) {
    case 'initialize':
      return { protocolVersion: params.protocolVersion, capabilities: { tools: {}, prompts: {}, resources: {} }, serverInfo: { name: 'diffra-test', version: '1.0.0' } }
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
      if (params.name === 'ui_card') return { content: [{ type: 'text', text: 'card shown' }, { type: 'resource', resource: { uri: 'ui://diffra-test/card', mimeType: 'text/html', text: CARD_HTML } }] }
      if (params.name === 'ui_weather') return { content: [{ type: 'text', text: `${args.city} 21 度` }], structuredContent: { city: args.city, temp: 21 } }
      throw { code: -32602, message: `Unknown tool ${params.name}` }
    }
    case 'resources/read': {
      const html = resources[params.uri]
      if (!html) throw { code: -32602, message: `Unknown resource ${params.uri}` }
      return { contents: [{ uri: params.uri, mimeType: 'text/html;profile=mcp-app', text: html }] }
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
  const send = () => process.stdout.write(`${JSON.stringify(reply)}\n`)
  const delay = message.method === 'initialize' ? Number(process.env.DIFFRA_TEST_INIT_DELAY_MS ?? 0) : 0
  if (delay > 0) setTimeout(send, delay)
  else send()
})
