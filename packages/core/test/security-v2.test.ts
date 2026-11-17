import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { discoverRoutes, localUrl, runDynamicTests } from '../src/security/dynamic.js'
import { runCodeql, runSemgrep, sarifFindings, scannerVersions } from '../src/security/external.js'
import { classifyLicense, scanLicenses } from '../src/security/licenses.js'
import { runSecurityTool } from '../src/security/tools.js'

// 安全的 v2 部分（M10）：依赖许可证、外部扫描器（用假的 Semgrep、CodeQL）、动态测试
const dirs: string[] = []
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('依赖许可证', () => {
  test('分类：宽松、弱传染、强传染、认不出；OR 取最宽松的', () => {
    expect(['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC'].map(classifyLicense)).toEqual(Array(4).fill('permissive'))
    expect(['LGPL-3.0', 'MPL-2.0', 'EPL-2.0'].map(classifyLicense)).toEqual(Array(3).fill('weak-copyleft'))
    expect(['GPL-3.0-only', 'AGPL-3.0', 'SSPL-1.0', 'GNU General Public License v3 (GPLv3)'].map(classifyLicense)).toEqual(Array(4).fill('strong-copyleft'))
    expect(classifyLicense('(MIT OR GPL-3.0)')).toBe('permissive')
    expect(classifyLicense(null)).toBe('unknown')
    expect(classifyLicense('Proprietary')).toBe('unknown')
  })

  test('读 node_modules 和 LICENSE 文件；没装的说明', async () => {
    const cwd = temp('diffra-licenses-')
    const pkg = { name: 'app', license: 'MIT', dependencies: { lodash: '^4', 'gpl-lib': '^1', mystery: '^1', 'not-installed': '^1' } }
    writeFileSync(join(cwd, 'package.json'), JSON.stringify(pkg, null, 2))
    const install = (name: string, meta: Record<string, unknown>, license?: string) => {
      mkdirSync(join(cwd, 'node_modules', name), { recursive: true })
      writeFileSync(join(cwd, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...meta }))
      if (license) writeFileSync(join(cwd, 'node_modules', name, 'LICENSE'), license)
    }
    install('lodash', { license: 'MIT' })
    install('gpl-lib', {}, '                    GNU GENERAL PUBLIC LICENSE\n                       Version 3, 29 June 2007')
    install('mystery', { license: 'SEE LICENSE IN EULA.txt' })
    const report = await scanLicenses(cwd)
    expect(report.project).toBe('MIT')
    expect(report.dependencies.map((item) => `${item.name} ${item.kind}`)).toEqual(['gpl-lib strong-copyleft', 'mystery unknown', 'lodash permissive'])
    expect(report.notes.join('\n')).toContain('1 个 npm 依赖还没装')
    const tool = await runSecurityTool({ cwd, tool: 'licenses', rgPath: '' }, new AbortController().signal)
    expect(tool.findings.map((item) => `${item.ruleId} ${item.severity}`)).toEqual(['LICENSE-COPYLEFT medium', 'LICENSE-UNKNOWN low'])
  })

  test('Python 虚拟环境：dist-info 的 License 或分类', async () => {
    const cwd = temp('diffra-licenses-py-')
    const site = process.platform === 'win32' ? join(cwd, '.venv', 'Lib', 'site-packages') : join(cwd, '.venv', 'lib', 'python3.12', 'site-packages')
    mkdirSync(join(site, 'requests-2.0.dist-info'), { recursive: true })
    writeFileSync(join(site, 'requests-2.0.dist-info', 'METADATA'), 'Name: requests\nVersion: 2.0\nLicense: Apache 2.0\n')
    mkdirSync(join(site, 'pyqt5-5.0.dist-info'), { recursive: true })
    writeFileSync(join(site, 'pyqt5-5.0.dist-info', 'METADATA'), 'Name: PyQt5\nVersion: 5.0\nClassifier: License :: OSI Approved :: GNU General Public License v3 (GPLv3)\n')
    const python = process.platform === 'win32' ? join(cwd, '.venv', 'Scripts', 'python.exe') : join(cwd, '.venv', 'bin', 'python')
    mkdirSync(join(python, '..'), { recursive: true })
    writeFileSync(python, '')
    const report = await scanLicenses(cwd)
    expect(report.dependencies.map((item) => `${item.name} ${item.kind}`)).toEqual(['PyQt5 strong-copyleft', 'requests permissive'])
  })
})

describe('外部扫描器（假的 Semgrep、CodeQL）', () => {
  const env = { ...process.env }
  afterEach(() => {
    process.env = { ...env }
  })

  test('Semgrep：没装时说明；装了时整理结果', async () => {
    process.env.DIFFRA_SEMGREP_PATH = join(tmpdir(), 'diffra-no-such-semgrep.mjs')
    expect((await scannerVersions(true)).semgrep).toBeNull()
    const cwd = temp('diffra-semgrep-')
    const fake = join(cwd, 'fake-semgrep.mjs')
    writeFileSync(
      fake,
      `if (process.argv.includes('--version')) { console.log('1.99.0'); process.exit(0) }
console.log(JSON.stringify({ results: [
  { check_id: 'javascript.express.security.audit.xss.direct-response-write', path: 'a.js', start: { line: 2 }, extra: { message: 'Detected direct write', severity: 'ERROR' } },
  { check_id: 'rules.other', path: 'a.js', start: { line: 9 }, extra: { message: 'Old line', severity: 'WARNING' } },
], errors: [] }))`,
    )
    process.env.DIFFRA_SEMGREP_PATH = fake
    expect((await scannerVersions(true)).semgrep).toBe('1.99.0')
    const full = await runSemgrep(cwd, null, 30_000)
    expect(full.findings.map((item) => `${item.ruleId} ${item.severity} ${item.path}:${item.line}`)).toEqual(['direct-response-write high a.js:2', 'other medium a.js:9'])
    expect(full.notes[0]).toContain('p/default')
  })

  test('CodeQL：要确认许可；建库、分析、读 SARIF', async () => {
    const cwd = temp('diffra-codeql-')
    writeFileSync(join(cwd, 'a.js'), 'x\n')
    const fake = join(cwd, 'fake-codeql.mjs')
    writeFileSync(
      fake,
      `import { writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (args[0] === 'version') { console.log('2.20.0'); process.exit(0) }
if (args[0] === 'database' && args[1] === 'create') process.exit(0)
const output = args.find((arg) => arg.startsWith('--output='))?.slice(9)
writeFileSync(output, JSON.stringify({ runs: [{ results: [{ ruleId: 'js/sql-injection', level: 'error', message: { text: 'Query built from user input' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/db.js' }, region: { startLine: 7 } } }] }] }] }))`,
    )
    process.env.DIFFRA_CODEQL_PATH = fake
    await expect(runSecurityTool({ cwd, tool: 'codeql', rgPath: '' }, new AbortController().signal)).rejects.toThrow('确认有 CodeQL 的使用许可')
    const result = await runCodeql(cwd, ['typescript', 'javascript'], 60_000)
    expect(result.findings).toEqual([{ tool: 'codeql', ruleId: 'js/sql-injection', severity: 'high', path: 'src/db.js', line: 7, message: 'Query built from user input' }])
    expect(sarifFindings({ runs: [{ results: [{ ruleId: 'r', level: 'note', message: { text: 'm' }, locations: [{ physicalLocation: { artifactLocation: { uri: `file:///${join(cwd, 'b.py').replace(/\\/g, '/')}` } } }] }] }] }, cwd)[0]).toMatchObject({ path: 'b.py', severity: 'low', line: null })
  })
})

describe('动态测试', () => {
  let server: Server
  let base: string
  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const q = url.searchParams.get('q')
      if (url.pathname === '/search') {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end(`<p>结果：${q}</p>`)
      } else if (url.pathname === '/login') {
        const next = url.searchParams.get('next')
        response.writeHead(next ? 302 : 200, next ? { location: next } : { 'content-type': 'text/html', 'x-content-type-options': 'nosniff' })
        response.end()
      } else if (url.pathname === '/download') {
        const file = url.searchParams.get('file') ?? ''
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end(file.includes('..') ? '127.0.0.1 localhost\n' : 'ok')
      } else if (url.pathname === '/users/1') {
        const id = url.searchParams.get('id') ?? ''
        response.writeHead(id.includes("'") ? 500 : 200, { 'content-type': 'text/plain' })
        response.end(id.includes("'") ? 'Error: SQLITE_ERROR: near "x": syntax error\n    at Statement.run (db.js:10:5)' : 'ok')
      } else {
        response.writeHead(200, { 'content-type': 'text/html', 'x-content-type-options': 'nosniff' })
        response.end('<p>首页</p>')
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  })
  afterAll(() => {
    server.close()
  })

  test('只许本机地址；从代码里认路由', async () => {
    expect(() => localUrl('https://example.com')).toThrow('只对本机')
    expect(localUrl('http://localhost:3000').port).toBe('3000')
    const cwd = temp('diffra-routes-')
    writeFileSync(join(cwd, 'server.js'), "app.get('/search', h)\nrouter.get('/users/:id', h)\napp.post('/upload', h)\n")
    writeFileSync(join(cwd, 'app.py'), '@app.route("/download")\ndef d(): pass\n@router.get("/items/{item_id}")\ndef i(): pass\n')
    expect(await discoverRoutes(cwd, ['server.js', 'app.py'])).toEqual(['/download', '/items/1', '/search', '/users/1'])
  })

  test('反射 XSS、开放跳转、路径穿越、SQL 报错都发现；正常的接口不报', { timeout: 30_000 }, async () => {
    const { findings, notes } = await runDynamicTests({ baseUrl: base, routes: ['/', '/search', '/login', '/download', '/users/1'] })
    expect(findings.map((item) => `${item.path} ${item.ruleId}`).sort()).toEqual(['/download SEC-INJ-4', '/login SEC-REQ-2', '/search SEC-OUT-1', '/users/1 SEC-INJ-1'])
    expect(notes.join('\n')).toContain('探测了 5 个接口')
    await expect(runDynamicTests({ baseUrl: 'http://127.0.0.1:9', routes: ['/'] })).rejects.toThrow('连不上')
  })
})
