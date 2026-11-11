import { readFile, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { languageOf as codeLanguageOf } from '../rules/languages.js'
import { buildResolverConfig, sourceEntry } from './config.js'
import { extractFacts, sourceLanguageOf } from './extract.js'
import { filesFingerprint, gitFingerprint, gitState, readChurn, streamLines } from './history.js'
import { readManifests } from './manifests.js'
import {
  ARCHITECTURE_VERSION,
  type AnalysisDigest,
  type AnalysisPhase,
  type ArchitectureAnalysis,
  type EdgeImport,
  type ExternalInfo,
  type FileEdge,
  type FileFacts,
  type FileInfo,
  type LanguageStat,
  MAX_EXTERNAL_USES,
  type ModuleInfo,
  type PackageInfo,
  type SourceLanguage,
  stronglyConnected,
  type UnresolvedImport,
} from './model.js'
import { Resolver } from './resolve.js'

// 规模上限：超过的代码文件不进图（记在 skipped.overLimit），太大的单个文件多半是生成的
export const MAX_CODE_FILES = 20_000
const MAX_LISTED_FILES = 300_000
const MAX_FILE_BYTES = 512 * 1024
const MAX_UNRESOLVED = 500
const CHURN_DAYS = 180
const LIST_TIMEOUT_MS = 120_000
const READ_BATCH = 32
// 每做这么久让出一次事件循环：分析和正在跑的任务在同一个进程里，不能让任务的输出卡住
const SLICE_MS = 12

export interface ParseCacheEntry {
  mtimeMs: number
  size: number
  lines: number
  facts: FileFacts | null
  // 看起来是压缩或生成的文件；解析失败
  skipped?: 'generated' | 'failed'
}

export interface ParseCache {
  version: typeof ARCHITECTURE_VERSION
  files: Record<string, ParseCacheEntry>
}

export interface AnalyzeOptions {
  projectId: string
  root: string
  rgPath: string
  cache: ParseCache | null
  signal: AbortSignal
  onProgress: (phase: AnalysisPhase, done: number, total: number) => void
}

export class AnalysisCancelled extends Error {
  constructor() {
    super('分析已取消')
  }
}

class Slicer {
  private last = performance.now()
  constructor(private readonly signal: AbortSignal) {}
  async tick(): Promise<void> {
    if (this.signal.aborted) throw new AnalysisCancelled()
    if (performance.now() - this.last < SLICE_MS) return
    await new Promise((resolve) => setImmediate(resolve))
    this.last = performance.now()
    if (this.signal.aborted) throw new AnalysisCancelled()
  }
}

const dirOf = (path: string) => {
  const dir = posix.dirname(path)
  return dir === '.' ? '' : dir
}

// 一行特别长或平均行长很大：压缩过的产物，不当源码分析
function looksGenerated(text: string, lines: number): boolean {
  if (text.length > 20_000 && text.length / lines > 300) return true
  return /^.{5000}/m.test(text.slice(0, 200_000))
}

const countLines = (text: string) => {
  if (text.length === 0) return 0
  let count = 1
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) count++
  return text.endsWith('\n') ? count - 1 : count
}

export async function listFiles(root: string, rgPath: string, signal?: AbortSignal): Promise<string[]> {
  const files: string[] = []
  const { exitCode, stopped } = await streamLines(
    rgPath,
    ['--files', '--path-separator', '/', '--glob', '!.git'],
    root,
    (line) => {
      const path = line.trim().replace(/^\.\//, '')
      if (path) files.push(path)
      return files.length < MAX_LISTED_FILES
    },
    { signal, timeoutMs: LIST_TIMEOUT_MS },
  )
  if (signal?.aborted) throw new AnalysisCancelled()
  // rg 没找到文件时退出码是 1
  if (!stopped && exitCode !== 0 && exitCode !== 1) throw new Error(`列出项目文件失败（ripgrep 退出码 ${exitCode}）`)
  return files.sort()
}

export function codeLanguage(path: string): string | null {
  const source = sourceLanguageOf(path)
  if (source) return source
  const language = codeLanguageOf(path)
  // 按扩展名能认出、但这里的解析器没加载成功的（比如 Python）仍按代码统计
  return language
}

interface CodeFile {
  path: string
  language: string
  source: SourceLanguage | null
  size: number
  mtimeMs: number
}

export async function analyzeProject(options: AnalyzeOptions): Promise<{ analysis: ArchitectureAnalysis; cache: ParseCache }> {
  const started = performance.now()
  const { root, signal } = options
  const slicer = new Slicer(signal)
  let lastProgress = 0
  const progress = (phase: AnalysisPhase, done: number, total: number, force = false) => {
    const now = performance.now()
    if (!force && now - lastProgress < 150) return
    lastProgress = now
    options.onProgress(phase, done, total)
  }

  progress('listing', 0, 0, true)
  const allFiles = await listFiles(root, options.rgPath, signal)
  const codeCandidates = allFiles.flatMap((path) => {
    const language = codeLanguage(path)
    return language ? [{ path, language, source: sourceLanguageOf(path) }] : []
  })
  const overLimit = Math.max(0, codeCandidates.length - MAX_CODE_FILES)
  // 超过上限时优先保留能深度解析的语言
  const kept = overLimit > 0 ? [...codeCandidates.filter((file) => file.source), ...codeCandidates.filter((file) => !file.source)].slice(0, MAX_CODE_FILES) : codeCandidates

  const codeFiles: CodeFile[] = []
  let tooLarge = 0
  for (let index = 0; index < kept.length; index += 64) {
    const batch = kept.slice(index, index + 64)
    const infos = await Promise.all(batch.map((file) => stat(join(root, file.path)).catch(() => null)))
    batch.forEach((file, offset) => {
      const info = infos[offset]
      if (!info?.isFile()) return
      if (info.size > MAX_FILE_BYTES) {
        tooLarge++
        return
      }
      codeFiles.push({ ...file, size: info.size, mtimeMs: info.mtimeMs })
    })
    progress('listing', index, kept.length)
    await slicer.tick()
  }

  // 解析：大小和修改时间都没变的用上次的结果
  const previous = options.cache?.version === ARCHITECTURE_VERSION ? options.cache.files : {}
  const cache: ParseCache = { version: ARCHITECTURE_VERSION, files: {} }
  let reparsed = 0
  for (let index = 0; index < codeFiles.length; index += READ_BATCH) {
    const batch = codeFiles.slice(index, index + READ_BATCH)
    const stale = batch.filter((file) => {
      const cached = previous[file.path]
      return !cached || cached.mtimeMs !== file.mtimeMs || cached.size !== file.size
    })
    const texts = new Map(await Promise.all(stale.map(async (file) => [file.path, await readFile(join(root, file.path), 'utf8').catch(() => null)] as const)))
    for (const file of batch) {
      const cached = previous[file.path]
      if (cached && !texts.has(file.path)) {
        cache.files[file.path] = cached
        continue
      }
      const text = texts.get(file.path)
      if (text === null || text === undefined) continue
      reparsed++
      const lines = countLines(text)
      if (looksGenerated(text, Math.max(lines, 1))) {
        cache.files[file.path] = { mtimeMs: file.mtimeMs, size: file.size, lines, facts: null, skipped: 'generated' }
      } else if (file.source) {
        let facts: FileFacts | null = null
        try {
          facts = extractFacts(file.path, text)
        } catch (error) {
          console.error(`[architecture] 解析失败 ${file.path}`, error)
        }
        cache.files[file.path] = { mtimeMs: file.mtimeMs, size: file.size, lines, facts, ...(facts ? {} : { skipped: 'failed' as const }) }
      } else cache.files[file.path] = { mtimeMs: file.mtimeMs, size: file.size, lines, facts: null }
      await slicer.tick()
    }
    progress('parsing', Math.min(index + READ_BATCH, codeFiles.length), codeFiles.length)
  }
  progress('parsing', codeFiles.length, codeFiles.length, true)

  progress('manifests', 0, 0, true)
  const manifests = await readManifests(root, allFiles)
  const resolverConfig = await buildResolverConfig(root, allFiles, manifests)

  const included = codeFiles.filter((file) => cache.files[file.path] && cache.files[file.path]!.skipped !== 'generated')
  const generated = codeFiles.length - included.length - codeFiles.filter((file) => !cache.files[file.path]).length
  const failed = included.filter((file) => cache.files[file.path]!.skipped === 'failed').length

  // 包：清单所在目录；根目录没有清单时补一个
  const packages: PackageInfo[] = manifests.map((manifest) => ({
    dir: manifest.dir,
    name: manifest.name,
    ecosystem: manifest.ecosystem,
    manifest: manifest.path,
    description: manifest.description,
    entries: [],
    dependencies: manifest.dependencies,
  }))
  if (!packages.some((item) => item.dir === '')) {
    packages.push({ dir: '', name: posix.basename(root.replace(/\\/g, '/')) || root, ecosystem: 'none', manifest: null, description: null, entries: [], dependencies: [] })
  }
  packages.sort((a, b) => (a.dir < b.dir ? -1 : 1))
  const packageDirs = packages.map((item) => item.dir).sort((a, b) => b.length - a.length)
  const packageOf = (path: string) => packageDirs.find((dir) => dir === '' || path === dir || path.startsWith(`${dir}/`)) ?? ''

  const index = new Map<string, number>()
  const files: FileInfo[] = included.map((file, position) => {
    index.set(file.path, position)
    const entry = cache.files[file.path]!
    return {
      path: file.path,
      language: file.language,
      parsed: Boolean(entry.facts),
      lines: entry.lines,
      bytes: file.size,
      package: packageOf(file.path),
      module: dirOf(file.path),
      symbols: entry.facts?.symbols ?? [],
      namespace: entry.facts?.namespace ?? null,
      churn: 0,
      commits: [],
      entry: false,
    }
  })

  // 依赖解析
  const sourceFiles = new Map<string, SourceLanguage>()
  const namespaces = new Map<string, string | null>()
  for (const file of included) {
    const facts = cache.files[file.path]!.facts
    if (facts) {
      sourceFiles.set(file.path, facts.language)
      namespaces.set(file.path, facts.namespace)
    }
  }
  const resolver = new Resolver({
    config: resolverConfig,
    allFiles: new Set(allFiles),
    sourceFiles,
    namespaces,
    declaredGo: manifests.filter((item) => item.ecosystem === 'go').flatMap((item) => item.dependencies),
  })
  const declared = new Set(manifests.flatMap((manifest) => manifest.dependencies.map((name) => name.toLowerCase())))
  const edgeMap = new Map<number, Map<number, EdgeImport[]>>()
  const addEdge = (from: number, to: number, item: EdgeImport) => {
    if (from === to) return
    const targets = edgeMap.get(from) ?? new Map<number, EdgeImport[]>()
    edgeMap.set(from, targets)
    const list = targets.get(to) ?? []
    targets.set(to, list)
    if (!list.some((existing) => existing.line === item.line && existing.specifier === item.specifier)) list.push(item)
  }
  const externals = new Map<string, ExternalInfo>()
  const unresolved: UnresolvedImport[] = []
  let resolved = 0
  for (const file of files) {
    const facts = cache.files[file.path]!.facts
    if (!facts) continue
    const from = index.get(file.path)!
    for (const fact of facts.imports) {
      const result = resolver.resolve(file.path, facts.language, fact)
      const item: EdgeImport = { line: fact.line, specifier: fact.specifier, names: fact.names, kind: fact.kind }
      if (result.kind === 'internal') {
        for (const target of result.files) {
          const to = index.get(target)
          if (to !== undefined) addEdge(from, to, item)
        }
      } else if (result.kind === 'external') {
        const key = `${result.ecosystem}:${result.name}`
        const external = externals.get(key) ?? { name: result.name, ecosystem: result.ecosystem, builtin: result.builtin, declared: declared.has(result.name.toLowerCase()), uses: [], count: 0 }
        external.count++
        if (external.uses.length < MAX_EXTERNAL_USES) external.uses.push({ file: from, line: fact.line, specifier: fact.specifier })
        externals.set(key, external)
      } else if (result.kind === 'unresolved' && unresolved.length < MAX_UNRESOLVED) {
        unresolved.push({ file: from, line: fact.line, specifier: fact.specifier })
      }
    }
    if (facts.language === 'java') {
      for (const target of resolver.samePackageJava(file.path, facts.typeRefs)) {
        const to = index.get(target)
        if (to !== undefined) addEdge(from, to, { line: 1, specifier: posix.basename(target, '.java'), names: [], kind: 'import' })
      }
    }
    resolved++
    progress('resolving', resolved, sourceFiles.size)
    await slicer.tick()
  }
  const edges: FileEdge[] = []
  for (const [from, targets] of edgeMap) for (const [to, imports] of targets) edges.push({ from, to, imports })
  edges.sort((a, b) => a.from - b.from || a.to - b.to)

  // 入口文件：清单里写的，加上各语言的惯例
  const entries = new Set<string>()
  const indexed = new Set(index.keys())
  for (const manifest of manifests) {
    for (const hint of manifest.entryHints) {
      // Python 的 scripts 写的是模块名，代码常放在 src/ 下
      const file = sourceEntry(manifest.dir, hint, indexed) ?? (manifest.ecosystem === 'python' ? sourceEntry(manifest.dir, `src/${hint}`, indexed) : null)
      if (file) entries.add(file)
    }
  }
  for (const file of files) {
    const name = posix.basename(file.path)
    const facts = cache.files[file.path]!.facts
    if (facts?.language === 'go' && facts.namespace === 'main' && facts.symbols.some((symbol) => symbol.name === 'main' && symbol.kind === 'function')) entries.add(file.path)
    if (facts?.language === 'rust' && /(^|\/)src\/(main|lib)\.rs$|(^|\/)src\/bin\/[^/]+\.rs$/.test(file.path)) entries.add(file.path)
    if (facts?.language === 'python' && name === '__main__.py') entries.add(file.path)
    if (facts?.language === 'java' && facts.symbols.some((symbol) => symbol.kind === 'method' && symbol.name === 'main' && symbol.exported)) entries.add(file.path)
  }
  for (const path of entries) {
    const position = index.get(path)
    if (position !== undefined) files[position]!.entry = true
  }
  for (const item of packages) item.entries = [...entries].filter((path) => packageOf(path) === item.dir).sort()

  // 目录：所有代码文件的上级目录
  const modules = new Map<string, ModuleInfo>()
  const ensureModule = (path: string): ModuleInfo => {
    const existing = modules.get(path)
    if (existing) return existing
    const parent = path === '' ? null : dirOf(path)
    const module: ModuleInfo = { path, parent, name: path === '' ? (posix.basename(root.replace(/\\/g, '/')) || root) : posix.basename(path), package: packageOf(path), files: 0, lines: 0 }
    modules.set(path, module)
    if (parent !== null) ensureModule(parent)
    return module
  }
  for (const file of files) {
    let path: string | null = file.module
    ensureModule(path)
    while (path !== null) {
      const module: ModuleInfo = modules.get(path)!
      module.files++
      module.lines += file.lines
      path = module.parent
    }
  }

  progress('history', 0, 0, true)
  const state = await gitState(root)
  const churn = state.toplevel ? await readChurn(root, CHURN_DAYS, signal) : null
  if (signal.aborted) throw new AnalysisCancelled()
  if (churn) {
    for (const file of files) {
      const entry = churn.byFile.get(file.path)
      if (!entry) continue
      file.churn = entry.count
      file.commits = entry.commits
    }
  }

  const languages = new Map<string, LanguageStat>()
  for (const file of files) {
    const stat = languages.get(file.language) ?? { language: file.language, files: 0, lines: 0 }
    stat.files++
    stat.lines += file.lines
    languages.set(file.language, stat)
  }
  const fingerprint = (await gitFingerprint(root, state)) ?? filesFingerprint(codeFiles)

  const analysis: ArchitectureAnalysis = {
    version: ARCHITECTURE_VERSION,
    projectId: options.projectId,
    root,
    analyzedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    fingerprint,
    git: { head: state.head, branch: state.branch },
    churnDays: CHURN_DAYS,
    stats: {
      files: files.length,
      lines: files.reduce((sum, file) => sum + file.lines, 0),
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      languages: [...languages.values()].sort((a, b) => b.lines - a.lines),
      parsedFiles: files.filter((file) => file.parsed).length,
      skipped: { tooLarge, generated, overLimit, failed },
      reparsed,
    },
    packages,
    modules: [...modules.values()].sort((a, b) => (a.path < b.path ? -1 : 1)),
    files,
    edges,
    externals: [...externals.values()].sort((a, b) => b.count - a.count),
    commits: churn?.commits ?? [],
    unresolved,
    resolver: resolverConfig,
  }
  return { analysis, cache }
}

// 判断是否过期：和分析时同样的算法重算指纹
export async function currentFingerprint(root: string, rgPath: string): Promise<string> {
  const state = await gitState(root)
  const git = await gitFingerprint(root, state)
  if (git) return git
  const files = (await listFiles(root, rgPath)).filter((path) => codeLanguage(path))
  const infos: Array<{ path: string; size: number; mtimeMs: number }> = []
  for (let index = 0; index < files.length; index += 64) {
    const batch = files.slice(index, index + 64)
    const stats = await Promise.all(batch.map((path) => stat(join(root, path)).catch(() => null)))
    batch.forEach((path, offset) => {
      const info = stats[offset]
      if (info?.isFile() && info.size <= MAX_FILE_BYTES) infos.push({ path, size: info.size, mtimeMs: info.mtimeMs })
    })
  }
  return filesFingerprint(infos)
}

// 顶层结构：多个包时是各个包，只有一个包时是它下面的一级目录（只有一个子目录就继续往下）
export function topLevelGroups(analysis: Pick<ArchitectureAnalysis, 'packages' | 'modules' | 'files'>): Array<{ id: string; label: string; contains: (file: FileInfo) => boolean; lines: number }> {
  const withCode = analysis.packages.filter((item) => analysis.files.some((file) => file.package === item.dir))
  if (withCode.length > 1) {
    return withCode.map((item) => ({
      id: `package:${item.dir}`,
      label: item.name,
      contains: (file: FileInfo) => file.package === item.dir,
      lines: analysis.files.filter((file) => file.package === item.dir).reduce((sum, file) => sum + file.lines, 0),
    }))
  }
  let scope = withCode[0]?.dir ?? ''
  for (let depth = 0; depth < 6; depth++) {
    const children = analysis.modules.filter((module) => module.parent === scope)
    const direct = analysis.files.some((file) => file.module === scope)
    if (children.length !== 1 || direct) break
    scope = children[0]!.path
  }
  const children = analysis.modules.filter((module) => module.parent === scope)
  return children.map((module) => ({
    id: `dir:${module.path}`,
    label: module.name,
    contains: (file: FileInfo) => file.path.startsWith(`${module.path}/`),
    lines: module.lines,
  }))
}

export function digestOf(analysis: ArchitectureAnalysis): AnalysisDigest {
  const fileAdjacency = analysis.files.map(() => [] as number[])
  for (const edge of analysis.edges) fileAdjacency[edge.from]!.push(edge.to)
  return {
    analyzedAt: analysis.analyzedAt,
    durationMs: analysis.durationMs,
    fingerprint: analysis.fingerprint,
    files: analysis.stats.files,
    lines: analysis.stats.lines,
    languages: analysis.stats.languages,
    packages: analysis.packages.filter((item) => analysis.files.some((file) => file.package === item.dir)).length,
    modules: analysis.modules.length,
    cycles: stronglyConnected(analysis.files.length, (node) => fileAdjacency[node]!).length,
  }
}
