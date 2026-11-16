import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { analyzeProject } from '../src/architecture/engine.js'
import { extractFacts } from '../src/architecture/extract.js'
import type { ArchitectureAnalysis, TargetArchitecture } from '../src/architecture/model.js'
import { normalizeQueryPath, runArchitectureQuery } from '../src/architecture/query.js'
import { findRipgrep } from '../src/environment.js'

// 函数级调用图和给智能体查的架构查询（v2 · M9）
const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'calls', private: true }),
  'src/main.ts': [
    "import { parse, Parser } from './parser'",
    "import * as fmt from './format'",
    "import { Store } from './store'",
    '',
    'export function main(input: string) {',
    '  const tree = parse(input)',
    '  const store = new Store()',
    '  store.save(tree)',
    '  return fmt.pretty(Parser.version())',
    '}',
    '',
    'main(process.argv[2] ?? "")',
  ].join('\n'),
  'src/parser.ts': [
    'export class Parser {',
    '  static version() { return "1" }',
    '  run(text: string) { return this.tokens(text) }',
    '  tokens(text: string) { return text.split(" ") }',
    '}',
    'export function parse(text: string) { return new Parser().run(text) }',
  ].join('\n'),
  'src/format.ts': 'export const pretty = (value: string) => `<${value}>`\n',
  'src/store.ts': 'export class Store {\n  save(value: unknown) { return value }\n}\n',
  'py/app.py': [
    'from helpers import clean',
    'import helpers',
    '',
    'class Job:',
    '    def run(self):',
    '        return self.step()',
    '    def step(self):',
    '        return clean(helpers.load())',
    '',
    'def start():',
    '    return Job().run()',
  ].join('\n'),
  'py/helpers.py': 'def clean(value):\n    return value\n\ndef load():\n    return 1\n',
  'go/go.mod': 'module example.com/calls\n\ngo 1.22\n',
  'go/main.go': 'package main\n\nimport "example.com/calls/util"\n\nfunc main() { run(); util.Sum(1, 2) }\n',
  'go/run.go': 'package main\n\nfunc run() {}\n',
  'go/util/sum.go': 'package util\n\nfunc Sum(a, b int) int { return a + b }\n',
  'java/src/main/java/com/acme/App.java': 'package com.acme;\n\npublic class App {\n  public static void main(String[] args) { new App().start(); Tools.log("x"); }\n  void start() { prepare(); }\n  void prepare() {}\n}\n',
  'java/src/main/java/com/acme/Tools.java': 'package com.acme;\n\npublic class Tools { public static void log(String s) {} }\n',
}

let root: string
let analysis: ArchitectureAnalysis

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'diffra-calls-'))
  for (const [path, content] of Object.entries(FILES)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  const result = await analyzeProject({ projectId: 'calls', root, rgPath: await findRipgrep(), cache: null, signal: new AbortController().signal, onProgress: () => {} })
  analysis = result.analysis
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const links = () =>
  (analysis.calls ?? []).map((call) => `${analysis.files[call.from]!.path}#${call.fromSymbol} -> ${analysis.files[call.to]!.path}#${call.toSymbol}`)

describe('调用处提取', () => {
  test('各语言记下被调名、前缀和行号；this/self 统一成 self，看不出前缀的写 ?', () => {
    expect(extractFacts('a.ts', 'foo()\nthis.bar()\nns.baz()\nmake().qux()\nnew Thing()\nrequire("x")')!.calls).toEqual([
      ['foo', null, 1],
      ['bar', 'self', 2],
      ['baz', 'ns', 3],
      ['qux', '?', 4],
      ['make', null, 4],
      ['Thing', null, 5],
    ])
    expect(extractFacts('a.py', 'self.go()\nmod.f()\nf()')!.calls).toEqual([
      ['go', 'self', 1],
      ['f', 'mod', 2],
      ['f', null, 3],
    ])
    expect(extractFacts('a.go', 'package a\nfunc x() { pkg.Do(); local() }')!.calls).toEqual([
      ['Do', 'pkg', 2],
      ['local', null, 2],
    ])
    expect(extractFacts('A.java', 'class A { void x() { run(); Util.go(); this.y(); new B(); } }')!.calls).toEqual([
      ['run', null, 1],
      ['go', 'Util', 1],
      ['y', 'self', 1],
      ['B', null, 1],
    ])
    expect(extractFacts('a.rs', 'fn x() { helper(); util::go(); self.m(); }')!.calls).toEqual([
      ['helper', null, 1],
      ['go', 'util', 1],
      ['m', 'self', 1],
    ])
  })
})

describe('调用图', () => {
  test('TS：import 的函数、命名空间前缀、导入类的静态方法、this 调本类方法、模块顶层的调用', () => {
    const all = links()
    expect(all).toContain('src/main.ts#main -> src/parser.ts#parse')
    expect(all).toContain('src/main.ts#main -> src/format.ts#pretty')
    expect(all).toContain('src/main.ts#main -> src/parser.ts#Parser.version')
    expect(all).toContain('src/main.ts#main -> src/store.ts#Store')
    expect(all).toContain('src/main.ts#(module) -> src/main.ts#main')
    expect(all).toContain('src/parser.ts#Parser.run -> src/parser.ts#Parser.tokens')
    expect(all).toContain('src/parser.ts#parse -> src/parser.ts#Parser')
    // store.save(tree) 通过变量调，对不上，不猜
    expect(all.some((link) => link.endsWith('#Store.save'))).toBe(false)
    const call = analysis.calls!.find((item) => analysis.files[item.to]!.path === 'src/parser.ts' && item.toSymbol === 'parse')!
    expect(call.lines).toEqual([6])
  })

  test('Python、Go、Java', () => {
    const all = links()
    expect(all).toContain('py/app.py#Job.run -> py/app.py#Job.step')
    expect(all).toContain('py/app.py#Job.step -> py/helpers.py#clean')
    expect(all).toContain('py/app.py#Job.step -> py/helpers.py#load')
    expect(all).toContain('py/app.py#start -> py/app.py#Job')
    expect(all).toContain('go/main.go#main -> go/run.go#run')
    expect(all).toContain('go/main.go#main -> go/util/sum.go#Sum')
    expect(all).toContain('java/src/main/java/com/acme/App.java#App.start -> java/src/main/java/com/acme/App.java#App.prepare')
    expect(all).toContain('java/src/main/java/com/acme/App.java#App.main -> java/src/main/java/com/acme/Tools.java#Tools.log')
  })
})

describe('智能体查架构', () => {
  test('路径：绝对路径换成相对项目根，反斜杠和开头的 ./ 去掉', () => {
    expect(normalizeQueryPath(root, join(root, 'src', 'main.ts'))).toBe('src/main.ts')
    expect(normalizeQueryPath(root, '.\\src\\')).toBe('src')
    expect(normalizeQueryPath(root, '.')).toBe('')
  })

  test('概览、依赖、被依赖、符号、查名字、依赖路径', () => {
    const overview = runArchitectureQuery(analysis, null, { action: 'overview' })
    expect(overview).toContain('code files')
    expect(overview).toContain('Function call graph')
    expect(overview).toContain('No target architecture')
    const dependencies = runArchitectureQuery(analysis, null, { action: 'dependencies', path: 'src/main.ts' })
    expect(dependencies).toContain('src/parser.ts (line 1) names: parse, Parser')
    expect(runArchitectureQuery(analysis, null, { action: 'dependents', path: 'src/parser.ts' })).toContain('src/main.ts:1')
    expect(runArchitectureQuery(analysis, null, { action: 'dependencies', path: 'src' })).toContain('0 other directories')
    expect(runArchitectureQuery(analysis, null, { action: 'symbols', path: 'src/parser.ts' })).toContain('method Parser.tokens lines 4-4')
    expect(runArchitectureQuery(analysis, null, { action: 'find', symbol: 'tokens' })).toContain('src/parser.ts:4 method Parser.tokens')
    const path = runArchitectureQuery(analysis, null, { action: 'path', path: 'src/main.ts', to: 'src/format.ts' })
    expect(path).toContain('src/main.ts:2 imports src/format.ts')
    expect(runArchitectureQuery(analysis, null, { action: 'path', path: 'src/format.ts', to: 'src/main.ts' })).toContain('does not depend')
    expect(runArchitectureQuery(analysis, null, { action: 'symbols', path: 'src/nope.ts' })).toContain('No analyzed code file')
  })

  test('调用和被调；没有目标架构时 violations 说明', () => {
    expect(runArchitectureQuery(analysis, null, { action: 'calls', path: 'src/main.ts', symbol: 'main' })).toContain('src/parser.ts parse (call at src/main.ts:6)')
    expect(runArchitectureQuery(analysis, null, { action: 'callers', path: 'src/parser.ts', symbol: 'tokens' })).toContain('src/parser.ts Parser.run')
    expect(runArchitectureQuery(analysis, null, { action: 'callers', path: 'src/store.ts', symbol: 'save' })).toContain('No resolved callers')
    expect(runArchitectureQuery(analysis, null, { action: 'calls', path: 'src/store.ts', symbol: 'nope' })).toContain('has no function or method named nope')
    expect(runArchitectureQuery(analysis, null, { action: 'violations' })).toContain('no target architecture')
  })

  test('目标架构的违规列到 文件:行', () => {
    const target: TargetArchitecture = {
      version: 1,
      updatedAt: '2026-11-15T00:00:00.000Z',
      enforceInTasks: true,
      diagram: {
        kind: 'application',
        layers: [
          { id: 'l1', name: '上层', groups: [{ id: 'g1', name: '', blocks: [{ id: 'main', name: '入口', kind: 'module', description: '', paths: ['src/main.ts'], packages: [], pinned: false }] }] },
          { id: 'l2', name: '下层', groups: [{ id: 'g2', name: '', blocks: [{ id: 'lib', name: '解析', kind: 'module', description: '', paths: ['src/parser.ts'], packages: [], pinned: false }] }] },
        ],
        sides: [],
        links: [],
      } as unknown as TargetArchitecture['diagram'],
      rules: [{ id: 'r1', kind: 'forbid', from: 'main', to: 'lib', note: '走接口' }],
    }
    const text = runArchitectureQuery(analysis, target, { action: 'violations' })
    expect(text).toContain('「入口」不许依赖「解析」：走接口')
    expect(text).toContain('src/main.ts:1 → src/parser.ts')
  })
})
