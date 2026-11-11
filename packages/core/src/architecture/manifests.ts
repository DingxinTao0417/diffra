import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import type { Ecosystem } from './model.js'

// 一个目录里有多个清单时按这个顺序取一个当包的类型
const MANIFESTS: Array<{ file: string; ecosystem: Ecosystem }> = [
  { file: 'package.json', ecosystem: 'npm' },
  { file: 'go.mod', ecosystem: 'go' },
  { file: 'Cargo.toml', ecosystem: 'cargo' },
  { file: 'pom.xml', ecosystem: 'maven' },
  { file: 'build.gradle.kts', ecosystem: 'gradle' },
  { file: 'build.gradle', ecosystem: 'gradle' },
  { file: 'pyproject.toml', ecosystem: 'python' },
  { file: 'setup.py', ecosystem: 'python' },
  { file: 'setup.cfg', ecosystem: 'python' },
]

const MAX_MANIFEST_BYTES = 512 * 1024

export interface Manifest {
  dir: string
  path: string
  ecosystem: Ecosystem
  name: string
  description: string | null
  dependencies: string[]
  // 清单里写的入口，相对包目录，还没对上实际文件
  entryHints: string[]
  // npm 的 exports：子路径 → 文件（相对包目录）
  exports: Record<string, string>
  // go.mod 的 module 路径
  goModule: string | null
}

export function manifestCandidates(files: readonly string[]): Map<string, { path: string; ecosystem: Ecosystem }> {
  const byDir = new Map<string, { path: string; ecosystem: Ecosystem; rank: number }>()
  for (const file of files) {
    const name = posix.basename(file)
    const rank = MANIFESTS.findIndex((item) => item.file === name)
    if (rank < 0) continue
    const dir = posix.dirname(file) === '.' ? '' : posix.dirname(file)
    const current = byDir.get(dir)
    if (!current || rank < current.rank) byDir.set(dir, { path: file, ecosystem: MANIFESTS[rank]!.ecosystem, rank })
  }
  return new Map([...byDir].map(([dir, { path, ecosystem }]) => [dir, { path, ecosystem }]))
}

export async function readManifests(root: string, files: readonly string[]): Promise<Manifest[]> {
  const manifests: Manifest[] = []
  const candidates = [...manifestCandidates(files)]
  // 大仓库有几百份清单，一份份等太慢，分批并行读
  for (let index = 0; index < candidates.length; index += 32) {
    const batch = candidates.slice(index, index + 32)
    const texts = await Promise.all(batch.map(([, candidate]) => readFile(join(root, candidate.path), 'utf8').catch(() => null)))
    batch.forEach(([dir, candidate], offset) => {
      const text = texts[offset]
      if (text === null || text === undefined || text.length > MAX_MANIFEST_BYTES) return
      const fallbackName = posix.basename(dir) || posix.basename(root.replace(/\\/g, '/'))
      // 子包的 package.json 可能只是放构建配置（没有 name），仍然算一个包
      manifests.push({ dir, path: candidate.path, ecosystem: candidate.ecosystem, ...parseManifest(candidate.ecosystem, text, fallbackName) })
    })
  }
  return manifests
}

type ParsedManifest = Omit<Manifest, 'dir' | 'path' | 'ecosystem'>

export function parseManifest(ecosystem: Ecosystem, text: string, fallbackName: string): ParsedManifest {
  switch (ecosystem) {
    case 'npm':
      return parsePackageJson(text, fallbackName)
    case 'go':
      return parseGoMod(text, fallbackName)
    case 'cargo':
      return parseCargo(text, fallbackName)
    case 'maven':
      return parsePom(text, fallbackName)
    case 'gradle':
      return parseGradle(text, fallbackName)
    case 'python':
      return parsePython(text, fallbackName)
    default:
      return empty(fallbackName)
  }
}

const empty = (name: string): ParsedManifest => ({ name, description: null, dependencies: [], entryHints: [], exports: {}, goModule: null })

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

// exports 的值可能是字符串、条件对象（types/import/require/default）或嵌套；取一个能对上源码的路径
function exportTarget(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const item of value) {
      const target = exportTarget(item)
      if (target) return target
    }
    return null
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['source', 'types', 'import', 'module', 'node', 'require', 'default']) {
      const target = key in record ? exportTarget(record[key]) : null
      if (target) return target
    }
    for (const nested of Object.values(record)) {
      const target = exportTarget(nested)
      if (target) return target
    }
  }
  return null
}

function parsePackageJson(text: string, fallbackName: string): ParsedManifest {
  let json: Record<string, unknown>
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    return empty(fallbackName)
  }
  const dependencies = new Set<string>()
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const record = json[key]
    if (record && typeof record === 'object') for (const name of Object.keys(record)) dependencies.add(name)
  }
  const exports: Record<string, string> = {}
  const rawExports = json.exports
  if (typeof rawExports === 'string' || Array.isArray(rawExports)) {
    const target = exportTarget(rawExports)
    if (target) exports['.'] = target
  } else if (rawExports && typeof rawExports === 'object') {
    const entries = Object.entries(rawExports as Record<string, unknown>)
    // 顶层就是条件（{ import, require }）而不是子路径
    if (entries.every(([key]) => !key.startsWith('.'))) {
      const target = exportTarget(rawExports)
      if (target) exports['.'] = target
    } else {
      for (const [subpath, value] of entries) {
        const target = exportTarget(value)
        if (target && !subpath.includes('*')) exports[subpath] = target
      }
    }
  }
  const hints = new Set<string>()
  for (const key of ['main', 'module', 'types', 'source']) {
    const value = asString(json[key])
    if (value) hints.add(value)
  }
  const bin = json.bin
  if (typeof bin === 'string') hints.add(bin)
  else if (bin && typeof bin === 'object') for (const value of Object.values(bin)) if (typeof value === 'string') hints.add(value)
  for (const value of Object.values(exports)) hints.add(value)
  return {
    name: asString(json.name) ?? fallbackName,
    description: asString(json.description),
    dependencies: [...dependencies],
    entryHints: [...hints],
    exports,
    goModule: null,
  }
}

function parseGoMod(text: string, fallbackName: string): ParsedManifest {
  const module = /^\s*module\s+(\S+)/m.exec(text)?.[1] ?? null
  const dependencies = new Set<string>()
  for (const block of text.matchAll(/^\s*require\s*\(([\s\S]*?)\)/gm)) {
    for (const line of block[1]!.split('\n')) {
      const path = line.trim().split(/\s+/)[0]
      if (path && !path.startsWith('//')) dependencies.add(path)
    }
  }
  for (const line of text.matchAll(/^\s*require\s+([^\s(]+)\s+\S+/gm)) dependencies.add(line[1]!)
  return { ...empty(module ?? fallbackName), goModule: module, dependencies: [...dependencies] }
}

// 只认清单里用到的那一小部分 TOML：[段]、key = "值"、key = [ … ]（可以跨行）、key = { … }
export function tomlSections(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>([['', new Map()]])
  let current = sections.get('')!
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.replace(/(^|\s)#.*$/, '').trim()
    if (!line) continue
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line)
    if (header) {
      const name = header[1]!.trim()
      current = sections.get(name) ?? new Map()
      sections.set(name, current)
      continue
    }
    const pair = /^("?[^=]+?"?)\s*=\s*(.*)$/.exec(line)
    if (!pair) continue
    let value = pair[2]!
    let depth = bracketDepth(value)
    while (depth > 0 && index + 1 < lines.length) {
      const next = lines[++index]!.replace(/(^|\s)#.*$/, '')
      value += `\n${next}`
      depth += bracketDepth(next)
    }
    current.set(pair[1]!.replace(/"/g, '').trim(), value.trim())
  }
  return sections
}

function bracketDepth(text: string): number {
  let depth = 0
  for (const char of text.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '')) {
    if (char === '[' || char === '{') depth++
    else if (char === ']' || char === '}') depth--
  }
  return depth
}

const quoted = (value: string | undefined): string[] => [...(value ?? '').matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((match) => match[1] ?? match[2] ?? '')

function parseCargo(text: string, fallbackName: string): ParsedManifest {
  const sections = tomlSections(text)
  const pkg = sections.get('package')
  const dependencies = new Set<string>()
  for (const [name, section] of sections) {
    if (/(^|\.)(dev-|build-)?dependencies$/.test(name)) for (const key of section.keys()) dependencies.add(key)
    const table = /(?:^|\.)(?:dev-|build-)?dependencies\.([^.]+)$/.exec(name)
    if (table) dependencies.add(table[1]!)
  }
  const hints = [...(sections.get('lib')?.get('path') ? quoted(sections.get('lib')!.get('path')) : [])]
  for (const [name, section] of sections) if (name === 'bin' && section.get('path')) hints.push(...quoted(section.get('path')))
  return {
    ...empty(quoted(pkg?.get('name'))[0] ?? fallbackName),
    description: quoted(pkg?.get('description'))[0] ?? null,
    dependencies: [...dependencies],
    entryHints: hints,
  }
}

function xmlText(text: string, tag: string): string | null {
  return new RegExp(`<${tag}>\\s*([^<]+?)\\s*</${tag}>`).exec(text)?.[1] ?? null
}

function parsePom(text: string, fallbackName: string): ParsedManifest {
  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, '')
  // 自己的 artifactId 在 parent、dependencies、build 之外
  const own = withoutComments.replace(/<(parent|dependencies|dependencyManagement|build|profiles|plugins)>[\s\S]*?<\/\1>/g, '')
  const dependencies = new Set<string>()
  for (const block of withoutComments.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const group = xmlText(block[1]!, 'groupId')
    const artifact = xmlText(block[1]!, 'artifactId')
    if (group && artifact) dependencies.add(`${group}:${artifact}`)
  }
  return { ...empty(xmlText(own, 'artifactId') ?? fallbackName), description: xmlText(own, 'description'), dependencies: [...dependencies] }
}

function parseGradle(text: string, fallbackName: string): ParsedManifest {
  const dependencies = new Set<string>()
  for (const match of text.matchAll(/\b(?:implementation|api|compileOnly|runtimeOnly|testImplementation|kapt|annotationProcessor)\s*\(?\s*["']([^"':]+:[^"':]+)(?::[^"']*)?["']/g)) {
    dependencies.add(match[1]!)
  }
  return { ...empty(fallbackName), dependencies: [...dependencies] }
}

// 依赖写法 "requests>=2"、"numpy[extra]; python_version<'3.11'"：只取包名
const requirementName = (spec: string) => /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec)?.[1]?.toLowerCase().replace(/_/g, '-') ?? null

function parsePython(text: string, fallbackName: string): ParsedManifest {
  if (!text.includes('[') && /setup\s*\(/.test(text)) {
    // setup.py
    const name = /\bname\s*=\s*["']([^"']+)["']/.exec(text)?.[1] ?? fallbackName
    const requires = /install_requires\s*=\s*\[([\s\S]*?)\]/.exec(text)?.[1] ?? ''
    return { ...empty(name), dependencies: quoted(requires).flatMap((spec) => requirementName(spec) ?? []) }
  }
  const sections = tomlSections(text)
  const project = sections.get('project')
  const poetry = sections.get('tool.poetry')
  const dependencies = new Set<string>()
  for (const spec of quoted(project?.get('dependencies'))) {
    const name = requirementName(spec)
    if (name) dependencies.add(name)
  }
  for (const [name, section] of sections) {
    if (/^tool\.poetry\.(dev-)?dependencies$|^tool\.poetry\.group\.[^.]+\.dependencies$/.test(name)) {
      for (const key of section.keys()) if (key !== 'python') dependencies.add(key.toLowerCase())
    }
  }
  // [project.scripts] 里的 module:function 是入口
  const hints: string[] = []
  for (const section of [sections.get('project.scripts'), sections.get('tool.poetry.scripts')]) {
    for (const value of section?.values() ?? []) {
      const module = quoted(value)[0]?.split(':')[0]
      if (module) hints.push(`${module.replace(/\./g, '/')}.py`)
    }
  }
  // setup.cfg 是 ini：[metadata] name = x
  const cfgName = /^\s*name\s*=\s*([^\s#]+)/m.exec(text)?.[1]
  const name = quoted(project?.get('name'))[0] ?? quoted(poetry?.get('name'))[0] ?? (sections.size <= 1 ? null : cfgName) ?? fallbackName
  return {
    ...empty(name),
    description: quoted(project?.get('description'))[0] ?? quoted(poetry?.get('description'))[0] ?? null,
    dependencies: [...dependencies],
    entryHints: hints,
  }
}
