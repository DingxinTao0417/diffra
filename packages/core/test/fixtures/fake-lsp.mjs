// 假的语言服务器（v2 · M4 的 LSP 测试用，core 单测和桌面端 e2e 共用）：stdio 上的 LSP。
// 打开或改文件时按行发诊断：含 ERROR 的行是错误，含 WARN 的行是警告。特殊内容：
// CRASH_ALWAYS 收到就退出（退出码 3）；CRASH_ONCE 第一次收到时退出（退出码 4，记在 FAKE_LSP_MARK 文件里，重启后不再崩）；SILENT 不发诊断。
// 参数 --fail-start 一启动就退出；环境变量 FAKE_LSP_NO_INIT 不回 initialize；FAKE_LSP_LOG 把收到的方法一行一个 JSON 记下来；
// FAKE_LSP_URI=lower 发诊断时把地址改成 Windows 上 TypeScript 语言服务器那样（盘符小写、冒号转义、整条路径小写）；
// FAKE_LSP_PULL=1 像 TypeScript 7 自带的语言服务器：声明 diagnosticProvider，不推送，等客户端用 textDocument/diagnostic 来拉
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'

const log = (entry) => {
  if (process.env.FAKE_LSP_LOG) appendFileSync(process.env.FAKE_LSP_LOG, `${JSON.stringify({ pid: process.pid, ...entry })}\n`)
}

if (process.argv.includes('--fail-start')) {
  process.stderr.write('fake-lsp: cannot start\n')
  process.exit(1)
}

const send = (message) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8')
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]))
}

// Windows 上语言服务器发回来的地址写法：file:///D:/Work/a.ts → file:///d%3a/work/a.ts
const rewrite = (uri) => (process.env.FAKE_LSP_URI === 'lower' ? uri.replace(/^file:\/\/\/([A-Za-z]):/, (_, drive) => `file:///${drive}%3A`).toLowerCase() : uri)
const pull = process.env.FAKE_LSP_PULL === '1'
const texts = new Map()

const diagnosticsOf = (text) => {
  const diagnostics = []
  text.split(/\r?\n/).forEach((line, index) => {
    const error = line.indexOf('ERROR')
    const warn = line.indexOf('WARN')
    if (error >= 0) diagnostics.push({ range: { start: { line: index, character: error }, end: { line: index, character: error + 5 } }, severity: 1, message: `found ERROR on line ${index + 1}`, source: 'fake', code: 'E1' })
    else if (warn >= 0) diagnostics.push({ range: { start: { line: index, character: warn }, end: { line: index, character: warn + 4 } }, severity: 2, message: 'found WARN', source: 'fake' })
  })
  return diagnostics
}

const publish = (uri, version, text) => {
  texts.set(uri, text)
  if (text.includes('SILENT') || pull) return
  send({ method: 'textDocument/publishDiagnostics', params: { uri: rewrite(uri), version, diagnostics: diagnosticsOf(text) } })
}

const crashes = (text) => {
  if (text.includes('CRASH_ALWAYS')) {
    process.stderr.write('fake-lsp: crashing on purpose\n')
    process.exit(3)
  }
  const mark = process.env.FAKE_LSP_MARK
  if (text.includes('CRASH_ONCE') && mark && !existsSync(mark)) {
    writeFileSync(mark, 'crashed')
    process.stderr.write('fake-lsp: crashing once\n')
    process.exit(4)
  }
}

const handle = (message) => {
  if (message.method) log({ method: message.method, ...(message.params?.textDocument ? { uri: message.params.textDocument.uri, version: message.params.textDocument.version } : {}) })
  else log({ response: message.id, result: message.result ?? null })
  switch (message.method) {
    case 'initialize':
      if (!process.env.FAKE_LSP_NO_INIT) send({ id: message.id, result: { capabilities: { textDocumentSync: 1, ...(pull ? { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } } : {}) }, serverInfo: { name: 'fake-lsp' } } })
      return
    case 'textDocument/diagnostic':
      send({ id: message.id, result: { kind: 'full', items: diagnosticsOf(texts.get(message.params.textDocument.uri) ?? '') } })
      return
    case 'initialized':
      // 反过来问一次配置，看客户端答不答
      send({ id: 'cfg-1', method: 'workspace/configuration', params: { items: [{ section: 'fake' }] } })
      return
    case 'textDocument/didOpen': {
      const { uri, version, text } = message.params.textDocument
      crashes(text)
      publish(uri, version, text)
      return
    }
    case 'textDocument/didChange': {
      const { uri, version } = message.params.textDocument
      const text = message.params.contentChanges.at(-1).text
      crashes(text)
      publish(uri, version, text)
      return
    }
    case 'shutdown':
      send({ id: message.id, result: null })
      return
    case 'exit':
      process.exit(0)
  }
}

let buffer = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n')
    if (end < 0) return
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString('ascii'))?.[1])
    if (buffer.length < end + 4 + length) return
    const body = buffer.subarray(end + 4, end + 4 + length).toString('utf8')
    buffer = buffer.subarray(end + 4 + length)
    handle(JSON.parse(body))
  }
})
process.stdin.on('end', () => process.exit(0))
