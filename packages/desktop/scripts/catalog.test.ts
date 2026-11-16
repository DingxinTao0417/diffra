// 联网扩展目录的逐项校验（src/main/catalog-schema.ts）：node --test scripts/catalog.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { builtinCatalog, parseCatalog } from '../src/main/catalog-schema.ts'

const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

const mcp = (id: string, connection: unknown, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  publisher: '官方',
  group: 'data',
  description: '说明',
  recommended: false,
  connection,
  key: null,
  note: null,
  ...extra,
})

const plugin = (id: string, repo: string, path: string | null) => ({
  id,
  pluginName: id,
  name: id,
  publisher: '官方',
  group: 'method',
  description: '说明',
  contents: '1 个 Skill',
  recommended: false,
  repo,
  path,
  note: null,
  unavailable: null,
})

test('内置目录整份过得了校验，一项不丢（官网发的就是它）', () => {
  const builtin = builtinCatalog()
  const { document, dropped } = parseCatalog(roundTrip(builtin))
  assert.deepEqual(dropped, [])
  assert.deepEqual(document, roundTrip(builtin))
})

test('不安全或认不出的项丢掉，其余照用：只认 https，本地命令只能是已知的前置命令，插件子目录不能往上跳', () => {
  const { document, dropped } = parseCatalog({
    version: 1,
    updatedAt: '2027-01-01',
    mcp: [
      mcp('good-remote', { transport: 'http', url: 'https://mcp.example.com/mcp' }),
      mcp('good-oauth', { transport: 'oauth', url: 'https://mcp.example.com' }),
      mcp('good-local', { transport: 'stdio', command: 'npx', args: ['-y', 'some-mcp@1.0.0'], requires: 'npx' }),
      mcp('plain-http', { transport: 'http', url: 'http://mcp.example.com/mcp' }),
      mcp('any-command', { transport: 'stdio', command: 'powershell', args: ['-c', 'evil'], requires: 'npx' }),
      mcp('newline-arg', { transport: 'stdio', command: 'npx', args: ['a\nb'], requires: 'npx' }),
      mcp('future-transport', { transport: 'websocket', url: 'wss://mcp.example.com' }),
      mcp('bad-help', { transport: 'http', url: 'https://mcp.example.com' }, { key: { label: 'Key', header: 'Authorization', template: 'Bearer {key}', helpUrl: 'javascript:alert(1)', hint: '', optional: false } }),
      mcp('Bad Id', { transport: 'http', url: 'https://mcp.example.com' }),
      mcp('good-remote', { transport: 'http', url: 'https://other.example.com' }),
    ],
    plugins: [
      plugin('good-plugin', 'https://github.com/example/plugins.git', 'plugins/good'),
      plugin('git-ssh', 'git@github.com:example/plugins.git', null),
      plugin('escape', 'https://github.com/example/plugins.git', 'plugins/../../etc'),
      plugin('file-repo', 'file:///C:/Users', null),
    ],
  })
  assert.equal(document.updatedAt, '2027-01-01')
  assert.deepEqual(
    document.mcp.map((entry) => entry.id),
    ['good-remote', 'good-oauth', 'good-local'],
  )
  assert.equal(document.mcp[0]?.connection.transport === 'http' && document.mcp[0].connection.url, 'https://mcp.example.com/mcp')
  assert.deepEqual(
    document.plugins.map((entry) => entry.id),
    ['good-plugin'],
  )
  assert.deepEqual(
    dropped.map((entry) => `${entry.kind}:${entry.id}`),
    ['mcp:plain-http', 'mcp:any-command', 'mcp:newline-arg', 'mcp:future-transport', 'mcp:bad-help', 'mcp:Bad Id', 'mcp:good-remote', 'plugin:git-ssh', 'plugin:escape', 'plugin:file-repo'],
  )
})

test('整份格式不对时报错：版本不认识、没有日期、不是对象', () => {
  assert.throws(() => parseCatalog({ version: 2, updatedAt: '2027-01-01', mcp: [], plugins: [] }))
  assert.throws(() => parseCatalog({ version: 1, mcp: [], plugins: [] }))
  assert.throws(() => parseCatalog('[]'))
})
