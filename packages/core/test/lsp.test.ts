import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { ToolResultPart } from 'ai'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type LspServerSpec, readLspServers } from '../src/lsp/config.js'
import { LspPool } from '../src/lsp/pool.js'
import { inspectPlugin, pluginLspServers } from '../src/plugins.js'
import { runTurn } from '../src/session/loop.js'
import type { Session } from '../src/session/session.js'
import { addFile, makeSession, project, recordingIO, replaceLines, scriptedModel, useTempProject } from './loop-helpers.js'

// 插件的语言服务器（v2 · M4）：读配置、按需启动、改完文件给诊断、崩溃重启、停止和闲置收尾。用 test/fixtures/fake-lsp.mjs
const FAKE_LSP = resolve(import.meta.dirname, 'fixtures', 'fake-lsp.mjs')

useTempProject()

let root: string
let pools: LspPool[]
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'diffra-lsp-'))
  pools = []
})
afterEach(async () => {
  for (const pool of pools) await pool.dispose()
  rmSync(root, { recursive: true, force: true })
})

const write = (path: string, text: string) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

// 一个只带 .lsp.json 的插件，服务器是假的 LSP
function fakePlugin(extra: Record<string, unknown> = {}, args: string[] = []) {
  const dir = join(root, 'plugin')
  write(
    join(dir, '.lsp.json'),
    JSON.stringify({
      fake: {
        command: process.execPath,
        args: [FAKE_LSP, ...args],
        extensionToLanguage: { '.ts': 'typescript', '.TSX': 'typescriptreact' },
        env: { FAKE_LSP_LOG: join(root, 'lsp.log'), FAKE_LSP_MARK: join(root, 'crashed.mark') },
        ...extra,
      },
    }),
  )
  return { name: 'kit', dir }
}

async function fakeSpec(extra: Record<string, unknown> = {}, args: string[] = []): Promise<LspServerSpec> {
  const { servers, problems } = await readLspServers(fakePlugin(extra, args), undefined)
  expect(problems).toEqual([])
  return servers[0]!
}

const newPool = (options: ConstructorParameters<typeof LspPool>[0] = {}) => {
  const pool = new LspPool({ diagnosticsWaitMs: 3000, restartBackoffMs: 20, ...options })
  pools.push(pool)
  return pool
}

const logged = () =>
  existsSync(join(root, 'lsp.log'))
    ? readFileSync(join(root, 'lsp.log'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { pid: number; method?: string; version?: number; response?: string; result?: unknown })
    : []

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('LSP 配置', () => {
  test('.lsp.json 和 plugin.json 的 lspServers（路径、内联、数组）合在一起，后写的同名覆盖；字段严格，路径要在插件里', async () => {
    const dir = join(root, 'multi')
    write(join(dir, '.lsp.json'), JSON.stringify({ go: { command: 'gopls', args: ['serve'], extensionToLanguage: { '.go': 'go' } }, bad: { command: 'x', extensionToLanguage: { '.x': 'x' }, unknownKey: 1 } }))
    write(join(dir, 'lsp', 'extra.json'), JSON.stringify({ lspServers: { py: { command: 'pyright-langserver', args: ['--stdio'], extensionToLanguage: { '.py': 'python' }, maxRestarts: 0 } } }))
    const manifest = ['./lsp/extra.json', { go: { command: '${CLAUDE_PLUGIN_ROOT}/bin/gopls', extensionToLanguage: { '.go': 'go' }, startupTimeout: 1000 } }, '../outside.json', './missing.json', { rust: { extensionToLanguage: { '.rs': 'rust' } } }]
    const { servers, problems } = await readLspServers({ name: 'multi', dir }, manifest)
    expect(servers.map((server) => server.name)).toEqual(['multi-go', 'multi-py'])
    expect(servers[0]).toMatchObject({ command: '${CLAUDE_PLUGIN_ROOT}/bin/gopls', startupTimeoutMs: 1000, restartOnCrash: true, maxRestarts: 3, diagnostics: true, extensions: { '.go': 'go' } })
    expect(servers[1]).toMatchObject({ args: ['--stdio'], maxRestarts: 0 })
    expect(problems).toHaveLength(4)
    expect(problems.some((problem) => problem.startsWith('LSP 服务器 bad') && problem.includes('unknownKey'))).toBe(true)
    expect(problems.some((problem) => problem.includes('../outside.json'))).toBe(true)
    expect(problems.some((problem) => problem.includes('./missing.json（文件不存在）'))).toBe(true)
    expect(problems.some((problem) => problem.startsWith('LSP 服务器 rust'))).toBe(true)
  })

  test('只带 .lsp.json 的文件夹也是插件；读到的服务器列出来，配置不对的进「不支持」；开着的插件交出服务器', async () => {
    const plugin = fakePlugin()
    write(join(plugin.dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'kit', lspServers: { broken: { command: 'x' } } }))
    const info = await inspectPlugin(plugin.dir)
    expect(info.lspServers).toEqual(['kit-fake'])
    expect(info.unsupported.some((item) => item.startsWith('LSP 服务器 broken'))).toBe(true)
    const servers = await pluginLspServers([{ name: 'kit', dir: plugin.dir }])
    expect(servers.map((server) => server.name)).toEqual(['kit-fake'])
    expect(servers[0]!.extensions).toEqual({ '.ts': 'typescript', '.tsx': 'typescriptreact' })
  })
})

describe('LSP 服务器池', () => {
  test('用到才启动；改完给这个版本的诊断，错误和警告都有；改干净了是空的；状态里有计数；服务器问配置时答 settings', async () => {
    const pool = newPool()
    const spec = await fakeSpec({ settings: { fake: { level: 'strict' } } })
    const file = join(project, 'src', 'a.ts')
    expect(pool.matching([spec], file)).toEqual([spec])
    expect(pool.matching([spec], join(project, 'b.tsx'))).toEqual([spec])
    expect(pool.matching([spec], join(project, 'c.js'))).toEqual([])
    expect(pool.status(project, [spec])[0]).toMatchObject({ state: 'idle', pid: null })

    const first = await pool.check(project, spec, file, 'const a = 1\nERROR here\n  WARN there\n')
    expect(first.note).toBeNull()
    expect(first.diagnostics).toEqual([
      { line: 1, character: 0, severity: 1, message: 'found ERROR on line 2', source: 'fake', code: 'E1' },
      { line: 2, character: 2, severity: 2, message: 'found WARN', source: 'fake', code: null },
    ])
    const status = pool.status(project, [spec])[0]!
    expect(status).toMatchObject({ name: 'kit-fake', state: 'running', errors: 1, warnings: 1, restarts: 0 })
    expect(status.files).toEqual([{ path: 'src/a.ts', errors: 1, warnings: 1, diagnostics: first.diagnostics }])

    const second = await pool.check(project, spec, file, 'const a = 1\n')
    expect(second.diagnostics).toEqual([])
    expect(pool.status(project, [spec])[0]).toMatchObject({ errors: 0, warnings: 0, files: [] })
    const methods = logged()
    expect(methods.flatMap((entry) => (entry.method ? [entry.method] : []))).toEqual(['initialize', 'initialized', 'workspace/didChangeConfiguration', 'textDocument/didOpen', 'textDocument/didChange'])
    expect(methods.find((entry) => entry.response === 'cfg-1')?.result).toEqual([{ level: 'strict' }])
    expect(methods.at(-1)?.version).toBe(2)
    expect(new Set(methods.map((entry) => entry.pid)).size).toBe(1)
  }, 30_000)

  test('崩了按退避重启，打开过的文件重新交给它；同一项目的任务共用一个进程', async () => {
    const pool = newPool()
    const spec = await fakeSpec()
    const file = join(project, 'a.ts')
    await pool.check(project, spec, file, 'ERROR\n')
    const firstPid = pool.status(project, [spec])[0]!.pid!
    const crashed = await pool.check(project, spec, file, 'CRASH_ONCE\n')
    expect(crashed.diagnostics).toBeNull()
    expect(crashed.note).toBe('检查这个文件时崩溃了，正在重启')
    expect(pool.status(project, [spec])[0]).toMatchObject({ state: 'restarting', restarts: 1 })
    expect(pool.status(project, [spec])[0]!.error).toContain('crashing once')
    const after = await pool.check(project, spec, file, 'ok\nERROR again\n')
    expect(after.diagnostics?.map((item) => item.message)).toEqual(['found ERROR on line 2'])
    const status = pool.status(project, [spec])[0]!
    expect(status).toMatchObject({ state: 'running', restarts: 1, error: null })
    expect(status.pid).not.toBe(firstPid)
    // 重启后先把崩之前的内容重新打开（版本照旧往上数），再收到这次的改动
    const reopened = logged().filter((entry) => entry.pid === status.pid && entry.method?.startsWith('textDocument/'))
    expect(reopened.map((entry) => [entry.method, entry.version])).toEqual([
      ['textDocument/didOpen', 2],
      ['textDocument/didChange', 3],
    ])
    expect(alive(firstPid)).toBe(false)
  }, 30_000)

  test('一直崩：重启次数用完停在失败，说清原因，不再自动启动；用户重启后次数清零', async () => {
    const pool = newPool()
    const spec = await fakeSpec({ maxRestarts: 2 })
    const file = join(project, 'a.ts')
    const results = []
    for (let index = 0; index < 4; index++) results.push(await pool.check(project, spec, file, 'CRASH_ALWAYS\n'))
    expect(results.every((result) => result.diagnostics === null)).toBe(true)
    const status = pool.status(project, [spec])[0]!
    expect(status.state).toBe('failed')
    expect(status.restarts).toBe(2)
    expect(status.error).toContain('重启了 2 次还是不行')
    expect(status.error).toContain('crashing on purpose')
    expect((await pool.check(project, spec, file, 'fine\n')).note).toContain('重启了 2 次还是不行')

    await pool.control(project, spec, 'restart')
    expect(pool.status(project, [spec])[0]).toMatchObject({ state: 'running', restarts: 0, error: null })
    expect((await pool.check(project, spec, file, 'ERROR\n')).diagnostics).toHaveLength(1)
  }, 30_000)

  test('用户停止：进程退出、诊断清空，改文件也不启动；启动后照常', async () => {
    const pool = newPool()
    const spec = await fakeSpec()
    const file = join(project, 'a.ts')
    await pool.check(project, spec, file, 'ERROR\n')
    const pid = pool.status(project, [spec])[0]!.pid!
    await pool.control(project, spec, 'stop')
    expect(pool.status(project, [spec])[0]).toMatchObject({ state: 'stopped', pid: null, errors: 0 })
    expect(alive(pid)).toBe(false)
    expect(logged().some((entry) => entry.pid === pid && entry.method === 'shutdown')).toBe(true)
    expect(await pool.check(project, spec, file, 'ERROR\n')).toMatchObject({ diagnostics: null, note: '已停止', state: 'stopped' })
    await pool.control(project, spec, 'start')
    expect((await pool.check(project, spec, file, 'ERROR\n')).diagnostics).toHaveLength(1)
  }, 30_000)

  test('一阵子没用就停掉，下次改文件再启动；不在还开着的任务项目里的收掉；dispose 结束所有进程', async () => {
    const idle = newPool({ idleStopMs: 300 })
    const spec = await fakeSpec()
    const file = join(project, 'a.ts')
    await idle.check(project, spec, file, 'ERROR\n')
    const pid = idle.status(project, [spec])[0]!.pid!
    await expect.poll(() => idle.status(project, [spec])[0]!.state, { timeout: 5000 }).toBe('idle')
    await expect.poll(() => alive(pid), { timeout: 5000 }).toBe(false)
    expect((await idle.check(project, spec, file, 'WARN\n')).diagnostics).toHaveLength(1)

    const pool = newPool()
    await pool.check(project, spec, file, 'ERROR\n')
    const other = mkdtempSync(join(tmpdir(), 'diffra-lsp-other-'))
    try {
      await pool.check(other, spec, join(other, 'b.ts'), 'ERROR\n')
      const otherPid = pool.status(other, [spec])[0]!.pid!
      await pool.retain([project])
      expect(alive(otherPid)).toBe(false)
      expect(pool.status(project, [spec])[0]!.state).toBe('running')
      const projectPid = pool.status(project, [spec])[0]!.pid!
      await pool.dispose()
      expect(alive(projectPid)).toBe(false)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  }, 30_000)

  test('起不来：找不到命令、一启动就退出、不回 initialize 超时，都停在失败并说原因；不发诊断时等到时限', async () => {
    const pool = newPool({ diagnosticsWaitMs: 500 })
    const file = join(project, 'a.ts')
    const missing = { ...(await fakeSpec()), name: 'kit-missing', command: 'definitely-not-a-language-server' }
    expect((await pool.check(project, missing, file, 'x')).note).toContain('找不到命令 definitely-not-a-language-server')
    const failing = { ...(await fakeSpec({}, ['--fail-start'])), name: 'kit-failing' }
    const failed = await pool.check(project, failing, file, 'x')
    expect(failed.state).toBe('failed')
    expect(failed.note).toContain('cannot start')
    const silent = { ...(await fakeSpec({ startupTimeout: 400 })), name: 'kit-silent', env: { FAKE_LSP_NO_INIT: '1' } }
    expect((await pool.check(project, silent, file, 'x')).note).toContain('0.4 秒内没启动好')
    const quiet = await fakeSpec()
    expect((await pool.check(project, quiet, file, 'SILENT ERROR')).note).toBe('0.5 秒内没给出这个文件的诊断')
  }, 30_000)
})

describe('任务里的诊断', () => {
  const toolResults = (session: Session) =>
    session.messages.flatMap((message) => (message.role === 'tool' ? message.content.filter((part): part is ToolResultPart => part.type === 'tool-result') : []))
  const resultText = (part: ToolResultPart | undefined) => (part?.output.type === 'text' ? part.output.value : '')
  const notices = (io: { updates: SessionUpdate[] }) => io.updates.flatMap((update) => (update.sessionUpdate === 'notice' ? [update.title] : []))

  test('改了它管的文件：错误和警告接在编辑结果后面给模型；干净的不加；别的扩展名不管；崩了提示用户一次', async () => {
    const pool = newPool()
    const lsp = { pool, servers: [await fakeSpec()] }
    const model = scriptedModel([
      { toolCalls: [addFile('src/a.ts', 'const a = 1\nconst b: number = ERROR\n// WARN later')] },
      { toolCalls: [replaceLines('src/a.ts', 'const b: number = ERROR', 'const b: number = 2')] },
      { toolCalls: [addFile('notes.md', 'ERROR in markdown is fine')] },
      { toolCalls: [addFile('src/c.ts', 'CRASH_ALWAYS')] },
      { toolCalls: [addFile('src/d.ts', 'CRASH_ALWAYS')] },
      { text: '好了' },
    ])
    const session = await makeSession(model, undefined, [], undefined, undefined, undefined, {}, { lsp })
    session.permissionMode = 'full'
    const io = recordingIO()
    await runTurn(session, { id: 't', text: '改一下' }, io)
    const results = toolResults(session).map(resultText)
    expect(results[0]).toContain('\n[Language server kit-fake reports 1 error(s) and 1 warning(s) in src/a.ts after this edit:\n  src/a.ts:2:19 error: found ERROR on line 2 (fake E1)\n  src/a.ts:3:4 warning: found WARN (fake)]')
    expect(results[1]).toContain('[Language server kit-fake reports 0 error(s) and 1 warning(s) in src/a.ts')
    expect(results[2]).not.toContain('Language server')
    expect(results[3]).not.toContain('Language server')
    expect(notices(io).filter((title) => title.includes('kit-fake'))).toEqual(['语言服务器 kit-fake 崩溃了，正在重启'])
  }, 60_000)
})
