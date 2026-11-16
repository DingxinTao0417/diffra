import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { readLspServers } from '../src/lsp/config.js'
import { LspPool } from '../src/lsp/pool.js'
import { runCodeql, runSemgrep, scannerVersions } from '../src/security/external.js'
import { gateSemgrep } from '../src/security/gate.js'

// 用本机真装的工具跑（v2 · M4、M10）：Semgrep、CodeQL、TypeScript 7 自带的语言服务器（tsc --lsp）、typescript-language-server、gopls。
// 默认跳过，DIFFRA_REAL_TOOLS=1 才跑；CodeQL 不在 PATH 上时用 DIFFRA_CODEQL_PATH 指定。
// typescript-language-server 要 TypeScript 6 及以前的 tsserver.js（TypeScript 7 没有了），用 DIFFRA_TSSERVER_PATH 指定，没给就跳过这一个。
// 项目都是这里临时写的几行示例代码（CodeQL 只分析它们），跑完就删
const REAL = process.env.DIFFRA_REAL_TOOLS === '1'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'diffra-real-tools-'))
})
afterEach(async () => {
  // 语言服务器退出后（包括起不来自己退出的），Windows 上目录要过一会儿才放手：最多等 15 秒
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt >= 30) throw error
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
})

const write = (path: string, text: string) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

const VULNERABLE_JS = ["const express = require('express')", "const fs = require('fs')", 'const app = express()', "app.get('/file', (req, res) => {", "  res.send(fs.readFileSync(req.query.name, 'utf8'))", '})', "app.get('/run', (req, res) => {", '  eval(req.query.code)', "  res.send('ok')", '})', 'app.listen(3000)', ''].join('\n')

describe.runIf(REAL)('真的外部扫描器', () => {
  test('Semgrep：探到版本；按项目里的 .semgrep.yml 扫出 eval 请求参数；完成前只留新增行上的', async () => {
    const versions = await scannerVersions(true)
    expect(versions.semgrep).toMatch(/^\d+\.\d+/)
    const cwd = join(root, 'semgrep')
    write(join(cwd, 'app.js'), VULNERABLE_JS)
    write(
      join(cwd, '.semgrep.yml'),
      ['rules:', '  - id: eval-request', '    languages: [javascript]', '    severity: ERROR', '    message: eval 了请求参数', '    pattern: eval(req.query.$X)', ''].join('\n'),
    )
    const full = await runSemgrep(cwd, null, 180_000)
    expect(full.notes[0]).toContain('.semgrep.yml')
    expect(full.findings).toEqual([expect.objectContaining({ tool: 'semgrep', ruleId: 'eval-request', severity: 'high', path: 'app.js', line: 8 })])
    // 完成前：只看这一轮新增的行（第 8 行是新加的才报）
    const kept = await gateSemgrep(cwd, new Map([['app.js', new Map([[8, '  eval(req.query.code)']])]]), new AbortController().signal)
    expect(kept.findings.map((item) => `${item.ruleId} ${item.line}`)).toEqual(['Semgrep:eval-request 8'])
    const skipped = await gateSemgrep(cwd, new Map([['app.js', new Map([[5, 'x']])]]), new AbortController().signal)
    expect(skipped.findings).toEqual([])
  }, 300_000)

  test('CodeQL：探到版本；对 JS 项目建库、跑 security-extended，读出路径注入和代码注入', async () => {
    const versions = await scannerVersions(true)
    expect(versions.codeql).toMatch(/^\d+\.\d+/)
    const cwd = join(root, 'codeql')
    write(join(cwd, 'app.js'), VULNERABLE_JS)
    write(join(cwd, 'package.json'), JSON.stringify({ name: 'sample', version: '1.0.0', dependencies: { express: '^4.0.0' } }))
    const result = await runCodeql(cwd, ['javascript'], 900_000)
    console.log('CodeQL', result.notes, result.findings.map((item) => `${item.ruleId} ${item.path}:${item.line}`))
    const rules = result.findings.map((item) => item.ruleId)
    expect(rules).toContain('js/path-injection')
    expect(rules).toContain('js/code-injection')
    expect(result.findings.every((item) => item.path === 'app.js')).toBe(true)
  }, 1_000_000)
})

describe.runIf(REAL)('真的语言服务器', () => {
  let pool: LspPool
  afterEach(async () => {
    await pool?.dispose()
  })

  async function specs() {
    const dir = join(root, 'plugin')
    write(
      join(dir, '.lsp.json'),
      JSON.stringify({
        // 项目里没装 TypeScript 时，typescript-language-server 要插件用 initializationOptions 指一个 tsserver
        ts: { command: 'typescript-language-server', args: ['--stdio'], extensionToLanguage: { '.ts': 'typescript' }, initializationOptions: { tsserver: { path: process.env.DIFFRA_TSSERVER_PATH ?? '' } } },
        tsgo: { command: 'tsc', args: ['--lsp', '--stdio'], extensionToLanguage: { '.ts': 'typescript' } },
        go: { command: 'gopls', args: ['serve'], extensionToLanguage: { '.go': 'go' } },
      }),
    )
    const { servers, problems } = await readLspServers({ name: 'real', dir }, undefined)
    expect(problems).toEqual([])
    return { ts: servers.find((server) => server.name === 'real-ts')!, tsgo: servers.find((server) => server.name === 'real-tsgo')!, go: servers.find((server) => server.name === 'real-go')! }
  }

  async function typeErrorRoundTrip(spec: Awaited<ReturnType<typeof specs>>['ts'], label: string) {
    pool = new LspPool({ diagnosticsWaitMs: 60_000 })
    const cwd = join(root, `${label}-project`)
    write(join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }))
    const file = join(cwd, 'a.ts')
    write(file, 'export const n: number = 1\n')
    const broken = await pool.check(cwd, spec, file, "export const n: number = 'x'\n")
    console.log(label, broken)
    expect(broken.note).toBeNull()
    expect(broken.diagnostics?.some((item) => item.message.includes('string') && item.message.includes('number'))).toBe(true)
    const fixed = await pool.check(cwd, spec, file, 'export const n: number = 2\n')
    expect(fixed.diagnostics).toEqual([])
  }

  test('TypeScript 7 自带的语言服务器（tsc --lsp --stdio）：改出类型错误时报诊断，改对后诊断清空', async () => {
    const { tsgo } = await specs()
    await typeErrorRoundTrip(tsgo, 'tsgo')
  }, 180_000)

  test.runIf(Boolean(process.env.DIFFRA_TSSERVER_PATH))('typescript-language-server（配 TypeScript 5/6 的 tsserver）：改出类型错误时报诊断，改对后诊断清空', async () => {
    const { ts } = await specs()
    await typeErrorRoundTrip(ts, 'tsls')
  }, 180_000)

  test('typescript-language-server：项目里没有 TypeScript、也没指定 tsserver 时起不来，原因原样告诉用户', async () => {
    const { ts } = await specs()
    const spec = { ...ts, initializationOptions: undefined }
    pool = new LspPool({ diagnosticsWaitMs: 30_000 })
    const cwd = join(root, 'ts-bare')
    const file = join(cwd, 'a.ts')
    write(file, 'export const n = 1\n')
    const result = await pool.check(cwd, spec, file, "export const n: number = 'x'\n")
    expect(result.diagnostics).toBeNull()
    expect(result.note).toContain('Could not find a valid TypeScript installation')
  }, 120_000)

  test('gopls：Go 模块里改出类型错误时报诊断，改对后诊断清空', async () => {
    const { go } = await specs()
    pool = new LspPool({ diagnosticsWaitMs: 120_000 })
    const cwd = join(root, 'go-project')
    write(join(cwd, 'go.mod'), 'module example.com/sample\n\ngo 1.22\n')
    const file = join(cwd, 'main.go')
    write(file, 'package main\n\nfunc main() {}\n')
    const broken = await pool.check(cwd, go, file, 'package main\n\nfunc main() {\n\tvar x int = "s"\n\t_ = x\n}\n')
    console.log('gopls', broken)
    expect(broken.note).toBeNull()
    expect(broken.diagnostics?.some((item) => /cannot use "s"|untyped string/.test(item.message))).toBe(true)
    const fixed = await pool.check(cwd, go, file, 'package main\n\nfunc main() {\n\tvar x int = 1\n\t_ = x\n}\n')
    expect(fixed.diagnostics).toEqual([])
  }, 300_000)
})
