import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findBash } from '../environment.js'
import { runProcess } from '../process.js'
import { commandEnv } from '../tools/command.js'
import type { ArchitectureAnalysis, FileInfo, RuntimeFunction, RuntimeLink, RuntimeTrace } from './model.js'

// 运行时追踪（v2 · M9）：在项目里跑一条用户给的命令（测试、脚本），记下真正执行到的函数和它们之间的调用。
// Node.js 用 V8 的 --cpu-prof（经 NODE_OPTIONS，npm、测试框架起的子进程也带上），按采样算时间；
// Python 在 PYTHONPATH 前面放一个 sitecustomize.py，用标准库的 cProfile 记调用次数和时间。别的语言不支持。
// 只看项目里的文件（依赖、标准库不算），对到架构分析里的函数；分析里没有的文件跳过
export const TRACE_TIMEOUT_DEFAULT_SECONDS = 120
export const TRACE_TIMEOUT_MAX_SECONDS = 600
const MAX_SAMPLES = 300_000
const MAX_FUNCTIONS = 2000
const MAX_LINKS = 5000
const MAX_PROFILE_BYTES = 200 * 1024 * 1024
const OUTPUT_TAIL = 4000

const SITECUSTOMIZE = `# Diffra 运行时追踪（v2）：只在 DIFFRA_TRACE_DIR 设了时生效，退出时把项目里函数的调用统计写成 JSON
import os
_diffra_dir = os.environ.get('DIFFRA_TRACE_DIR')
_diffra_root = os.environ.get('DIFFRA_TRACE_ROOT')
if _diffra_dir and _diffra_root:
    import atexit, cProfile, json, pstats
    _diffra_root = os.path.normcase(os.path.realpath(_diffra_root))
    _diffra_profile = cProfile.Profile()
    _diffra_profile.enable()
    def _diffra_real(path):
        try:
            return os.path.realpath(path)
        except Exception:
            return path
    def _diffra_inside(path):
        full = os.path.normcase(_diffra_real(path))
        return full.startswith(_diffra_root + os.sep) and os.sep + 'site-packages' + os.sep not in full and os.sep + '.venv' + os.sep not in full
    def _diffra_dump():
        try:
            _diffra_profile.disable()
            out = []
            for (file, line, name), (cc, nc, tt, ct, callers) in pstats.Stats(_diffra_profile).stats.items():
                if not _diffra_inside(file):
                    continue
                out.append({'file': _diffra_real(file), 'line': line, 'name': name, 'calls': nc, 'self': tt, 'total': ct,
                            'callers': [{'file': _diffra_real(f), 'line': l, 'name': n, 'calls': c[1], 'total': c[3]} for (f, l, n), c in callers.items() if _diffra_inside(f)]})
            with open(os.path.join(_diffra_dir, 'py-%d.json' % os.getpid()), 'w', encoding='utf-8') as handle:
                json.dump(out, handle)
        except Exception:
            pass
    atexit.register(_diffra_dump)
`

interface CpuProfile {
  nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number; children?: number[] }>
  startTime: number
  endTime: number
  samples?: number[]
}

interface PythonEntry {
  file: string
  line: number
  name: string
  calls: number
  self: number
  total: number
  callers: Array<{ file: string; line: number; name: string; calls: number; total: number }>
}

// 文件（下标）里包住这一行的最里面的函数或方法，按 类.方法 记；不在任何函数里的是模块顶层。
// 项目根可能经过链接（Windows 的目录联接、macOS 的 /tmp），运行时报的是真实路径：两种都认
class SymbolLocator {
  private readonly files = new Map<string, number>()
  private readonly callables = new Map<number, FileInfo['symbols']>()
  private readonly roots: string[]

  constructor(
    root: string,
    private readonly analysis: ArchitectureAnalysis,
  ) {
    analysis.files.forEach((file, index) => this.files.set(process.platform === 'win32' ? file.path.toLowerCase() : file.path, index))
    let real = root
    try {
      real = realpathSync.native(root)
    } catch {
      real = root
    }
    this.roots = [...new Set([root, real])]
  }

  file(absolute: string): number | null {
    for (const root of this.roots) {
      const path = relative(root, absolute).replace(/\\/g, '/')
      if (!path || path.startsWith('..') || isAbsolute(path)) continue
      if (/(^|\/)node_modules\//.test(path)) return null
      const found = this.files.get(process.platform === 'win32' ? path.toLowerCase() : path)
      if (found !== undefined) return found
    }
    return null
  }

  symbol(file: number, line: number, fallback: string): string {
    // 模块顶层的代码：Python 叫 <module>，V8 是没有名字、从第 0 行开始的那一帧；都从第一行起，别算进第一行开始的函数
    if (fallback === '<module>' || (fallback === '' && line === 1)) return '(module)'
    let list = this.callables.get(file)
    if (!list) {
      list = this.analysis.files[file]!.symbols.filter((symbol) => symbol.kind === 'function' || symbol.kind === 'method').sort((a, b) => a.endLine - a.line - (b.endLine - b.line))
      this.callables.set(file, list)
    }
    const found = list.find((symbol) => symbol.line <= line && line <= symbol.endLine)
    if (found) return found.parent ? `${found.parent}.${found.name}` : found.name
    return fallback && fallback !== '<module>' ? fallback : '(module)'
  }
}

class Collector {
  readonly functions = new Map<string, RuntimeFunction>()
  readonly links = new Map<string, RuntimeLink>()

  fn(file: number, symbol: string): RuntimeFunction {
    const key = `${file}\u0000${symbol}`
    let entry = this.functions.get(key)
    if (!entry) {
      entry = { file, symbol, selfMs: 0, totalMs: 0, calls: null }
      this.functions.set(key, entry)
    }
    return entry
  }

  link(from: number, fromSymbol: string, to: number, toSymbol: string): RuntimeLink {
    const key = `${from}\u0000${fromSymbol}\u0000${to}\u0000${toSymbol}`
    let entry = this.links.get(key)
    if (!entry) {
      entry = { from, fromSymbol, to, toSymbol, ms: 0, calls: null }
      this.links.set(key, entry)
    }
    return entry
  }
}

// 一份 V8 CPU 采样：每个采样沿调用栈往上，项目里的函数各记一次总时间，相邻的两个项目函数记一次调用（中间隔着依赖的也算）
function addCpuProfile(profile: CpuProfile, locator: SymbolLocator, collector: Collector): void {
  const samples = profile.samples ?? []
  if (samples.length === 0) return
  const sampleMs = Math.max(0, (profile.endTime - profile.startTime) / 1000 / samples.length)
  const parent = new Map<number, number>()
  const frames = new Map<number, { file: number; symbol: string } | null>()
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parent.set(child, node.id)
    const url = node.callFrame.url
    let frame: { file: number; symbol: string } | null = null
    if (url.startsWith('file:')) {
      try {
        const file = locator.file(fileURLToPath(url))
        if (file !== null) frame = { file, symbol: locator.symbol(file, node.callFrame.lineNumber + 1, node.callFrame.functionName) }
      } catch {
        frame = null
      }
    }
    frames.set(node.id, frame)
  }
  for (const leaf of samples.slice(0, MAX_SAMPLES)) {
    const stack: Array<{ file: number; symbol: string }> = []
    for (let id: number | undefined = leaf; id !== undefined; id = parent.get(id)) {
      const frame = frames.get(id)
      if (frame && !(stack.length > 0 && stack[stack.length - 1]!.file === frame.file && stack[stack.length - 1]!.symbol === frame.symbol)) stack.push(frame)
    }
    if (stack.length === 0) continue
    collector.fn(stack[0]!.file, stack[0]!.symbol).selfMs += sampleMs
    const seen = new Set<string>()
    for (const frame of stack) {
      const key = `${frame.file}\u0000${frame.symbol}`
      if (seen.has(key)) continue
      seen.add(key)
      collector.fn(frame.file, frame.symbol).totalMs += sampleMs
    }
    const linked = new Set<string>()
    for (let index = 0; index + 1 < stack.length; index++) {
      const callee = stack[index]!
      const caller = stack[index + 1]!
      const key = `${caller.file}\u0000${caller.symbol}\u0000${callee.file}\u0000${callee.symbol}`
      if (linked.has(key)) continue
      linked.add(key)
      collector.link(caller.file, caller.symbol, callee.file, callee.symbol).ms += sampleMs
    }
  }
}

// cProfile 的统计：调用次数是准的，时间按调用方分开
function addPythonProfile(entries: PythonEntry[], locator: SymbolLocator, collector: Collector): void {
  const resolve = (file: string, line: number, name: string) => {
    const index = locator.file(file)
    return index === null ? null : { file: index, symbol: locator.symbol(index, line, name) }
  }
  for (const entry of entries) {
    const callee = resolve(entry.file, entry.line, entry.name)
    if (!callee) continue
    const fn = collector.fn(callee.file, callee.symbol)
    fn.selfMs += entry.self * 1000
    fn.totalMs += entry.total * 1000
    fn.calls = (fn.calls ?? 0) + entry.calls
    for (const item of entry.callers) {
      const caller = resolve(item.file, item.line, item.name)
      if (!caller || (caller.file === callee.file && caller.symbol === callee.symbol)) continue
      const link = collector.link(caller.file, caller.symbol, callee.file, callee.symbol)
      link.ms += item.total * 1000
      link.calls = (link.calls ?? 0) + item.calls
    }
  }
}

const round = (value: number) => Math.round(value * 10) / 10

export interface TraceOptions {
  root: string
  command: string
  timeoutSeconds: number
  analysis: ArchitectureAnalysis
  signal: AbortSignal
}

export async function runTrace(options: TraceOptions): Promise<RuntimeTrace> {
  const bash = await findBash()
  if (!bash) throw new Error('找不到 bash，跑不了命令（Windows 上要装 Git for Windows）')
  const dir = await mkdtemp(join(tmpdir(), 'diffra-trace-'))
  try {
    const nodeDir = join(dir, 'node')
    const pythonDir = join(dir, 'python')
    const outDir = join(dir, 'out')
    await Promise.all([mkdir(nodeDir), mkdir(pythonDir), mkdir(outDir)])
    await writeFile(join(pythonDir, 'sitecustomize.py'), SITECUSTOMIZE)
    const env = commandEnv()
    const quote = (path: string) => (/\s/.test(path) ? `"${path}"` : path)
    env.NODE_OPTIONS = [env.NODE_OPTIONS, '--cpu-prof', `--cpu-prof-dir=${quote(nodeDir)}`, '--cpu-prof-interval=500'].filter(Boolean).join(' ')
    env.PYTHONPATH = [pythonDir, env.PYTHONPATH].filter(Boolean).join(delimiter)
    env.DIFFRA_TRACE_DIR = outDir
    env.DIFFRA_TRACE_ROOT = options.root
    const startedAt = new Date().toISOString()
    const result = await runProcess(bash, ['-c', options.command], { cwd: options.root, timeoutMs: options.timeoutSeconds * 1000, signal: options.signal, env })
    if (result.aborted) throw new Error('取消了')

    const locator = new SymbolLocator(options.root, options.analysis)
    const collector = new Collector()
    const languages = new Set<'node' | 'python'>()
    let profileBytes = 0
    const notes: string[] = []
    for (const name of await readdir(nodeDir)) {
      if (!name.endsWith('.cpuprofile')) continue
      const text = await readFile(join(nodeDir, name), 'utf8')
      profileBytes += text.length
      if (profileBytes > MAX_PROFILE_BYTES) {
        notes.push('采样文件太大，后面的没有算进来')
        break
      }
      languages.add('node')
      addCpuProfile(JSON.parse(text) as CpuProfile, locator, collector)
    }
    for (const name of await readdir(outDir)) {
      if (!name.startsWith('py-') || !name.endsWith('.json')) continue
      languages.add('python')
      addPythonProfile(JSON.parse(await readFile(join(outDir, name), 'utf8')) as PythonEntry[], locator, collector)
    }
    if (result.timedOut) notes.push(`超过 ${options.timeoutSeconds} 秒，命令被停掉了；停之前写出的记录照样算`)
    if (languages.size === 0) notes.push('没有拿到运行记录：命令里没有跑 Node.js 或 Python，或者进程没正常退出（Node.js 被强行结束时不写采样）')
    const functions = [...collector.functions.values()].sort((a, b) => b.totalMs - a.totalMs)
    const links = [...collector.links.values()].sort((a, b) => b.ms - a.ms)
    return {
      command: options.command,
      startedAt,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      output: result.output.slice(-OUTPUT_TAIL),
      languages: [...languages],
      functions: functions.slice(0, MAX_FUNCTIONS).map((item) => ({ ...item, selfMs: round(item.selfMs), totalMs: round(item.totalMs) })),
      links: links.slice(0, MAX_LINKS).map((item) => ({ ...item, ms: round(item.ms) })),
      files: new Set(functions.map((item) => item.file)).size,
      notes,
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch((error: unknown) => console.error('[architecture] 清理运行时追踪的临时目录失败', error))
  }
}

// 运行时追踪的默认命令：有测试脚本就跑测试
export async function guessTraceCommand(root: string): Promise<string> {
  const pkg = await readFile(join(root, 'package.json'), 'utf8')
    .then((text) => JSON.parse(text) as { scripts?: Record<string, string>; packageManager?: string })
    .catch(() => null)
  if (pkg?.scripts?.test) {
    const manager = pkg.packageManager?.split('@')[0]
    return `${manager === 'pnpm' || manager === 'yarn' ? manager : 'npm'} test`
  }
  const python = await readdir(root).catch(() => [] as string[])
  if (python.some((name) => name === 'pytest.ini' || name === 'pyproject.toml' || name === 'setup.cfg' || name === 'tests')) return 'python -m pytest -q'
  return pkg ? 'node .' : ''
}
