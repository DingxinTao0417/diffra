import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import type { Manifest } from './manifests.js'
import type { ResolverConfig } from './model.js'

const MAX_TSCONFIG_DEPTH = 5
const SOURCE_SUFFIXES = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js']

const dirOf = (path: string) => {
  const dir = posix.dirname(path)
  return dir === '.' ? '' : dir
}
const joinPath = (...parts: string[]) => {
  const joined = posix.normalize(posix.join(...parts.filter((part) => part !== '')))
  return joined === '.' ? '' : joined.replace(/\/$/, '')
}

// tsconfig 是带注释、允许尾逗号的 JSON
export function parseJsonc(text: string): unknown {
  let output = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (inString) {
      output += char
      if (char === '\\') output += text[++i] ?? ''
      else if (char === '"') inString = false
    } else if (char === '"') {
      inString = true
      output += char
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      output += '\n'
    } else if (char === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
    } else output += char
  }
  return JSON.parse(output.replace(/,(\s*[}\]])/g, '$1'))
}

interface CompilerPaths {
  baseUrl: string | null
  paths: Record<string, string[]> | null
  // paths 相对的目录：有 baseUrl 用 baseUrl，否则是写 paths 的那份 tsconfig 所在目录
  pathsBase: string
}

async function loadCompilerPaths(root: string, file: string, depth = 0): Promise<CompilerPaths | null> {
  const text = await readFile(join(root, file), 'utf8').catch(() => null)
  if (text === null) return null
  let json: { extends?: unknown; compilerOptions?: { baseUrl?: unknown; paths?: unknown } }
  try {
    json = parseJsonc(text) as typeof json
  } catch {
    return null
  }
  const dir = dirOf(file)
  let inherited: CompilerPaths | null = null
  // 只跟相对路径的 extends；npm 包里的共享配置一般不写 paths
  const parents = Array.isArray(json.extends) ? json.extends : [json.extends]
  for (const parent of parents) {
    if (typeof parent !== 'string' || !parent.startsWith('.') || depth >= MAX_TSCONFIG_DEPTH) continue
    const target = joinPath(dir, parent.endsWith('.json') ? parent : `${parent}.json`)
    inherited = (await loadCompilerPaths(root, target, depth + 1)) ?? inherited
  }
  const options = json.compilerOptions ?? {}
  const baseUrl = typeof options.baseUrl === 'string' ? joinPath(dir, options.baseUrl) : (inherited?.baseUrl ?? null)
  const ownPaths = options.paths && typeof options.paths === 'object' ? (options.paths as Record<string, unknown>) : null
  if (ownPaths) {
    const paths: Record<string, string[]> = {}
    for (const [pattern, targets] of Object.entries(ownPaths)) if (Array.isArray(targets)) paths[pattern] = targets.filter((item): item is string => typeof item === 'string')
    return { baseUrl, paths, pathsBase: baseUrl ?? dir }
  }
  return { baseUrl, paths: inherited?.paths ?? null, pathsBase: inherited?.paths ? (baseUrl ?? inherited.pathsBase) : (baseUrl ?? dir) }
}

function existingSource(base: string, files: ReadonlySet<string>): string | null {
  for (const suffix of SOURCE_SUFFIXES) if (files.has(base + suffix)) return base + suffix
  if (/\.(c|m)?js$/.test(base)) {
    const stem = base.replace(/\.(c|m)?js$/, '')
    for (const suffix of ['.ts', '.tsx', '.mts', '.cts']) if (files.has(stem + suffix)) return stem + suffix
  }
  return null
}

// 清单里的入口常指向构建产物（dist/index.js）；对不上时换成源码目录再找一次
export function sourceEntry(packageDir: string, target: string, files: ReadonlySet<string>): string | null {
  const base = joinPath(packageDir, target)
  const direct = existingSource(base, files)
  if (direct) return direct
  const relative = joinPath(target)
  const mapped = relative.replace(/^(dist|build|lib|out|esm|cjs)(\/(esm|cjs))?\//, 'src/').replace(/\.d\.ts$/, '.ts')
  if (mapped !== relative) return existingSource(joinPath(packageDir, mapped), files) ?? existingSource(joinPath(packageDir, mapped.replace(/\.(c|m)?js$/, '')), files)
  return null
}

export async function buildResolverConfig(root: string, allFiles: readonly string[], manifests: readonly Manifest[]): Promise<ResolverConfig> {
  const files = new Set(allFiles)
  const aliases: ResolverConfig['aliases'] = []
  for (const file of allFiles) {
    const name = posix.basename(file)
    if (!/^(tsconfig[\w.-]*|jsconfig)\.json$/.test(name)) continue
    const options = await loadCompilerPaths(root, file)
    const scope = dirOf(file)
    if (options?.paths) {
      for (const [pattern, targets] of Object.entries(options.paths)) aliases.push({ scope, pattern, targets: targets.map((target) => joinPath(options.pathsBase, target)) })
    }
    // 只写了 baseUrl：非相对的导入可以从 baseUrl 开始找
    if (options?.baseUrl !== null && options?.baseUrl !== undefined && !options.paths) aliases.push({ scope, pattern: '*', targets: [joinPath(options.baseUrl, '*')] })
  }

  const npmPackages: ResolverConfig['npmPackages'] = {}
  const goModules: ResolverConfig['goModules'] = {}
  const crates: ResolverConfig['crates'] = {}
  const pythonRoots: string[] = []
  for (const manifest of manifests) {
    if (manifest.ecosystem === 'npm') {
      const exports: Record<string, string> = {}
      for (const [subpath, target] of Object.entries(manifest.exports)) {
        const file = sourceEntry(manifest.dir, target, files)
        if (file) exports[subpath] = file
      }
      if (!exports['.']) {
        for (const hint of manifest.entryHints) {
          const file = sourceEntry(manifest.dir, hint, files)
          if (file) {
            exports['.'] = file
            break
          }
        }
      }
      npmPackages[manifest.name] = { dir: manifest.dir, exports }
    }
    if (manifest.ecosystem === 'go' && manifest.goModule) goModules[manifest.goModule] = manifest.dir
    if (manifest.ecosystem === 'cargo') {
      const rootFile = ['src/lib.rs', 'src/main.rs'].map((item) => joinPath(manifest.dir, item)).find((item) => files.has(item))
      if (rootFile) crates[manifest.name.replace(/-/g, '_')] = rootFile
    }
    if (manifest.ecosystem === 'python') {
      const src = joinPath(manifest.dir, 'src')
      if (allFiles.some((file) => file.startsWith(`${src}/`))) pythonRoots.push(src)
      pythonRoots.push(manifest.dir)
    }
  }
  if (allFiles.some((file) => file.startsWith('src/') && file.endsWith('.py')) && !pythonRoots.includes('src')) pythonRoots.push('src')
  if (!pythonRoots.includes('')) pythonRoots.push('')
  // 同一个目录下几份 tsconfig 常写着同样的别名
  const unique = [...new Map(aliases.map((alias) => [JSON.stringify(alias), alias])).values()]
  return { aliases: unique, npmPackages, goModules, crates, pythonRoots }
}
