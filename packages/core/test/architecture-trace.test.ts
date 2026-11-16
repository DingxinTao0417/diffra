import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { analyzeProject } from '../src/architecture/engine.js'
import type { ArchitectureAnalysis } from '../src/architecture/model.js'
import { runArchitectureQuery } from '../src/architecture/query.js'
import { guessTraceCommand, runTrace } from '../src/architecture/trace.js'
import { findRipgrep } from '../src/environment.js'

// 运行时追踪（v2 · M9）：真跑一条 Node.js 命令和一条 Python 命令，记下执行到的项目函数和调用
const hasPython = spawnSync('python', ['--version'], { windowsHide: true }).status === 0

let root: string
let analysis: ArchitectureAnalysis

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'diffra-trace-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'trace-me', scripts: { test: 'node app.js' } }))
  writeFileSync(join(root, 'app.js'), "const { work } = require('./lib')\n\nfunction main() {\n  for (let i = 0; i < 40; i++) work(300000)\n}\n\nmain()\n")
  writeFileSync(join(root, 'lib.js'), 'function spin(n) {\n  let x = 0\n  for (let i = 0; i < n; i++) x += Math.sqrt(i)\n  return x\n}\n\nfunction work(n) {\n  return [1, 2, 3].map(() => spin(n)).length\n}\n\nfunction unused() {\n  return 0\n}\n\nmodule.exports = { work, unused }\n')
  mkdirSync(join(root, 'py'))
  writeFileSync(join(root, 'py', 'app.py'), 'from helper import double\n\n\ndef run():\n    total = 0\n    for i in range(1000):\n        total += double(i)\n    return total\n\n\nif __name__ == "__main__":\n    run()\n')
  writeFileSync(join(root, 'py', 'helper.py'), 'def double(x):\n    return x * 2\n')
  analysis = (await analyzeProject({ projectId: 'trace', root, rgPath: await findRipgrep(), cache: null, signal: new AbortController().signal, onProgress: () => {} })).analysis
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const fileIndex = (path: string) => analysis.files.findIndex((file) => file.path === path)

describe('运行时追踪', () => {
  test('默认命令：有 test 脚本跑测试', async () => {
    expect(await guessTraceCommand(root)).toBe('npm test')
  })

  test('Node.js：采样记下执行到的函数和调用（经过 map 回调的也算），没执行到的函数不出现', { timeout: 60_000 }, async () => {
    const trace = await runTrace({ root, command: 'node app.js', timeoutSeconds: 60, analysis, signal: new AbortController().signal })
    expect(trace.exitCode).toBe(0)
    expect(trace.languages).toEqual(['node'])
    const fn = (path: string, symbol: string) => trace.functions.find((item) => item.file === fileIndex(path) && item.symbol === symbol)
    expect(fn('lib.js', 'spin')?.selfMs).toBeGreaterThan(0)
    expect(fn('app.js', 'main')?.totalMs).toBeGreaterThanOrEqual(fn('lib.js', 'spin')!.selfMs)
    expect(fn('lib.js', 'unused')).toBeUndefined()
    const link = (from: string, fromSymbol: string, to: string, toSymbol: string) => trace.links.some((item) => item.from === fileIndex(from) && item.fromSymbol === fromSymbol && item.to === fileIndex(to) && item.toSymbol === toSymbol)
    expect(link('app.js', 'main', 'lib.js', 'work')).toBe(true)
    expect(link('lib.js', 'work', 'lib.js', 'spin')).toBe(true)
    expect(trace.files).toBe(2)
    // 给智能体看的摘要
    const text = runArchitectureQuery(analysis, null, { action: 'runtime' }, trace)
    expect(text).toContain('Runtime trace of `node app.js`')
    expect(text).toContain('lib.js spin')
    expect(text).toMatch(/did not run, e\.g\. .*py\/app\.py/)
  })

  test.skipIf(!hasPython)('Python：cProfile 记下调用次数', { timeout: 60_000 }, async () => {
    const trace = await runTrace({ root, command: 'cd py && python app.py', timeoutSeconds: 60, analysis, signal: new AbortController().signal })
    expect(trace.exitCode).toBe(0)
    expect(trace.languages).toEqual(['python'])
    const call = trace.links.find((item) => item.from === fileIndex('py/app.py') && item.fromSymbol === 'run' && item.to === fileIndex('py/helper.py') && item.toSymbol === 'double')
    expect(call?.calls).toBe(1000)
    expect(trace.functions.find((item) => item.symbol === 'double')?.calls).toBe(1000)
    expect(trace.links.some((item) => item.fromSymbol === '(module)' && item.toSymbol === 'run')).toBe(true)
  })

  test('超时停掉；取消抛错；没跑 Node.js 或 Python 时说明', { timeout: 60_000 }, async () => {
    const slow = await runTrace({ root, command: 'sleep 30', timeoutSeconds: 1, analysis, signal: new AbortController().signal })
    expect(slow.timedOut).toBe(true)
    expect(slow.notes.join('\n')).toContain('超过 1 秒')
    expect(slow.notes.join('\n')).toContain('没有拿到运行记录')
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    await expect(runTrace({ root, command: 'sleep 30', timeoutSeconds: 60, analysis, signal: controller.signal })).rejects.toThrow('取消了')
  })
})
