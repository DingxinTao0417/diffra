import { posix } from 'node:path'
import { topLevelGroups } from './engine.js'
import {
  type ArchitectureAnalysis,
  type ArchitectureThumbnail,
  type BlockDiagram,
  type BlockKind,
  type DiagramBlock,
  type DiagramGroup,
  type DiagramKind,
  type DiagramLayer,
  pathMatcher,
  stronglyConnected,
} from './model.js'

const MAX_BLOCKS_PER_GROUP = 12
const MAX_TECH_PER_LAYER = 16

export class IdMaker {
  private readonly used = new Set<string>()
  next(prefix: string): string {
    let index = this.used.size + 1
    while (this.used.has(`${prefix}-${index}`)) index++
    const id = `${prefix}-${index}`
    this.used.add(id)
    return id
  }
  reserve(id: string): void {
    this.used.add(id)
  }
}

export function block(ids: IdMaker, name: string, kind: BlockKind, change: Partial<Omit<DiagramBlock, 'id' | 'name' | 'kind'>> = {}): DiagramBlock {
  return { id: ids.next('block'), name, description: '', kind, paths: [], packages: [], pinned: false, unverified: false, ...change }
}

function emptyDiagram(kind: DiagramKind, analysis: ArchitectureAnalysis): BlockDiagram {
  return { kind, source: 'static', generatedAt: new Date().toISOString(), model: null, fingerprint: analysis.fingerprint, layers: [], sides: [], connectors: [], dropped: 0 }
}

function collapse(children: Map<string, string[]>, filesIn: Set<string>, path: string): string {
  let current = path
  for (;;) {
    const next = children.get(current) ?? []
    if (next.length !== 1 || filesIn.has(current)) return current
    current = next[0]!
  }
}

// 按依赖关系给一组节点分层：被依赖的在下面，环里的同层；返回每个节点的层号（0 是最上层）
export function rankNodes(count: number, edges: Iterable<[number, number]>): number[] {
  const adjacency = Array.from({ length: count }, () => new Set<number>())
  for (const [from, to] of edges) if (from !== to) adjacency[from]!.add(to)
  const group = Array.from({ length: count }, (_, at) => at)
  for (const cycle of stronglyConnected(count, (node) => adjacency[node]!)) for (const node of cycle) group[node] = cycle[0]!
  const predecessors = Array.from({ length: count }, () => [] as number[])
  adjacency.forEach((targets, from) => {
    for (const to of targets) if (group[from] !== group[to]) predecessors[group[to]!]!.push(group[from]!)
  })
  const rank = new Map<number, number>()
  const visiting = new Set<number>()
  const depth = (node: number): number => {
    const known = rank.get(node)
    if (known !== undefined) return known
    if (visiting.has(node)) return 0
    visiting.add(node)
    let value = 0
    for (const parent of predecessors[node]!) value = Math.max(value, depth(parent) + 1)
    visiting.delete(node)
    rank.set(node, value)
    return value
  }
  return Array.from({ length: count }, (_, at) => depth(group[at]!))
}

// ---------- 应用架构：顶层的包或目录按依赖分层，下一级目录是方块 ----------

function staticApplication(analysis: ArchitectureAnalysis): BlockDiagram {
  const diagram = emptyDiagram('application', analysis)
  const ids = new IdMaker()
  const groups = topLevelGroups(analysis)
  if (groups.length === 0) return diagram
  const groupOf = analysis.files.map((file) => groups.findIndex((group) => group.contains(file)))
  const links: Array<[number, number]> = []
  for (const edge of analysis.edges) {
    const from = groupOf[edge.from]!
    const to = groupOf[edge.to]!
    if (from >= 0 && to >= 0 && from !== to) links.push([from, to])
  }
  const ranks = rankNodes(groups.length, links)
  const depth = Math.max(0, ...ranks)
  const children = new Map<string, string[]>()
  for (const module of analysis.modules) if (module.parent !== null) children.set(module.parent, [...(children.get(module.parent) ?? []), module.path])
  const lines = new Map(analysis.modules.map((module) => [module.path, module.lines]))
  diagram.layers = Array.from({ length: depth + 1 }, (_, at) => ({
    id: ids.next('layer'),
    name: depth === 0 ? '应用' : at === 0 ? '上层' : at === depth ? '基础层' : `第 ${at + 1} 层`,
    description: depth === 0 ? '' : at === 0 ? '没有别的部分依赖它们（入口一侧）' : at === depth ? '被依赖最多的基础部分' : '',
    groups: [],
    pinned: false,
  }))
  groups.forEach((group, at) => {
    const packageDir = group.id.startsWith('package:') ? group.id.slice(8) : null
    // 只看这一组自己的代码：根目录的包不能把别的包的目录当成自己的方块
    const own = analysis.files.filter((file) => group.contains(file))
    const ownFiles = new Set(own.map((file) => file.module))
    const ownDirs = new Set<string>()
    for (const dir of ownFiles) for (let path: string | null = dir; path !== null && !ownDirs.has(path); path = path === '' ? null : posix.dirname(path) === '.' ? '' : posix.dirname(path)) ownDirs.add(path)
    const ownChildren = new Map([...children].map(([parent, list]) => [parent, list.filter((child) => ownDirs.has(child))]))
    const base = collapse(ownChildren, ownFiles, packageDir ?? group.id.slice(4))
    const subdirs = (ownChildren.get(base) ?? []).map((child) => collapse(ownChildren, ownFiles, child)).sort((a, b) => (lines.get(b) ?? 0) - (lines.get(a) ?? 0))
    const blocks: DiagramBlock[] = subdirs.slice(0, MAX_BLOCKS_PER_GROUP).map((dir) => block(ids, base ? dir.slice(base.length + 1) : dir, 'code', { paths: [dir] }))
    const rest = subdirs.slice(MAX_BLOCKS_PER_GROUP)
    if (rest.length > 0) blocks.push(block(ids, `其余 ${rest.length} 个目录`, 'code', { paths: rest }))
    if (ownFiles.has(base) || blocks.length === 0) blocks.push(block(ids, subdirs.length > 0 ? `${posix.basename(base) || '根目录'} 下的文件` : group.label, 'code', { paths: [base ? `${base}/*` : '*'] }))
    const name = packageDir === null ? group.label : (analysis.packages.find((item) => item.dir === packageDir)?.name ?? group.label)
    diagram.layers[ranks[at]!]!.groups.push({ id: ids.next('group'), name, blocks, pinned: false })
  })
  for (let at = 0; at + 1 < diagram.layers.length; at++) diagram.connectors.push({ from: diagram.layers[at]!.id, to: diagram.layers[at + 1]!.id, label: '' })
  return diagram
}

// ---------- 技术架构：外部包按用途分层 ----------

interface TechCategory {
  id: string
  name: string
  // 包名完全相同，或者 @scope/ 开头
  match: string[]
}

const TECH_CATEGORIES: TechCategory[] = [
  {
    id: 'ui',
    name: '界面',
    match: ['react', 'react-dom', 'vue', '@vue/', 'svelte', 'solid-js', '@angular/', 'preact', 'tailwindcss', '@tailwindcss/', 'radix-ui', '@radix-ui/', 'lucide-react', 'antd', 'element-plus', 'element-ui', '@mui/', 'react-markdown', '@xyflow/', 'd3', 'three', 'echarts', 'chart.js', 'framer-motion', 'class-variance-authority', 'react-router', 'react-router-dom', 'pinia', 'vuex', 'redux', '@reduxjs/', 'zustand', 'jotai', '@xterm/', 'xterm', 'monaco-editor', 'codemirror', '@codemirror/'],
  },
  {
    id: 'app',
    name: '应用框架与运行时',
    match: ['electron', 'express', 'koa', 'fastify', '@nestjs/', 'next', 'nuxt', 'hono', '@remix-run/', 'django', 'flask', 'fastapi', 'starlette', 'uvicorn', 'github.com/gin-gonic/gin', 'github.com/labstack/echo', 'github.com/gofiber/fiber', 'org.springframework', 'org.springframework.boot', 'actix-web', 'axum', 'tokio', 'rocket', 'tauri', '@tauri-apps/', 'node-pty'],
  },
  {
    id: 'ai',
    name: '模型与 AI',
    match: ['ai', '@ai-sdk/', 'openai', '@anthropic-ai/', 'anthropic', 'langchain', '@langchain/', 'llamaindex', 'transformers', 'torch', 'tensorflow', 'ollama', 'tiktoken', '@google/generative-ai', '@google/genai'],
  },
  {
    id: 'comm',
    name: '通信与协议',
    match: ['@agentclientprotocol/', '@modelcontextprotocol/', 'axios', 'ws', 'socket.io', 'socket.io-client', 'grpc', '@grpc/', 'graphql', '@apollo/', 'node-fetch', 'undici', 'requests', 'httpx', 'aiohttp', 'reqwest', 'hyper', 'google.golang.org/grpc', 'electron-updater'],
  },
  {
    id: 'data',
    name: '数据与存储',
    match: ['prisma', '@prisma/', 'typeorm', 'sequelize', 'mongoose', 'mongodb', 'pg', 'mysql2', 'sqlite3', 'better-sqlite3', 'redis', 'ioredis', 'sqlalchemy', 'psycopg2', 'pymongo', 'gorm.io/gorm', 'diesel', 'sqlx', 'drizzle-orm', 'knex', 'idb', 'dexie', 'lowdb'],
  },
  {
    id: 'parse',
    name: '代码与文档处理',
    match: ['@ast-grep/', 'typescript', 'diff', 'remark-gfm', 'remark', 'unified', 'marked', 'markdown-it', 'tree-sitter', 'jspdf', 'pdfjs-dist', 'canvaskit-wasm', '@open-pencil/', '@dagrejs/'],
  },
  {
    id: 'lib',
    name: '通用库',
    match: ['zod', 'lodash', 'date-fns', 'dayjs', 'moment', 'uuid', 'nanoid', 'shell-quote', 'cn', 'clsx', 'yaml', 'js-yaml', 'pydantic', 'numpy', 'pandas', '@vscode/ripgrep', 'chokidar', 'glob', 'fast-glob', 'commander', 'yargs', 'rxjs'],
  },
]

const BUILD_MATCH = ['vite', '@vitejs/', 'vitest', 'jest', '@playwright/', 'playwright', 'eslint', 'prettier', 'webpack', 'esbuild', 'rollup', 'rolldown', 'electron-builder', 'electron-vite', 'pytest', 'tsx', 'ts-node', 'shadcn', '@types/', '@iconify-json/', 'cypress', 'storybook', '@storybook/']

const matches = (patterns: readonly string[], name: string) => patterns.some((pattern) => (pattern.endsWith('/') ? name.startsWith(pattern) : name === pattern || name.startsWith(`${pattern}.`) || name.startsWith(`${pattern}/`)))

const LANGUAGE_RUNTIMES: Record<string, string> = { npm: 'Node.js 内置模块', python: 'Python 标准库', go: 'Go 标准库', cargo: 'Rust 标准库', java: 'Java 标准库' }
const LANGUAGE_NAMES: Record<string, string> = { typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python', go: 'Go', rust: 'Rust', java: 'Java', vue: 'Vue 单文件组件', kotlin: 'Kotlin', csharp: 'C#', cpp: 'C++', c: 'C' }

function staticTechnology(analysis: ArchitectureAnalysis): BlockDiagram {
  const diagram = emptyDiagram('technology', analysis)
  const ids = new IdMaker()
  // 代码里导入的外部包，加上清单里声明了、能认出用途的（构建工具、类型这类不在代码里导入）
  const usage = new Map<string, number>()
  for (const external of analysis.externals) if (!external.builtin) usage.set(external.name, (usage.get(external.name) ?? 0) + external.count)
  for (const item of analysis.packages) {
    for (const name of item.dependencies) {
      if (usage.has(name) || Object.keys(analysis.resolver.npmPackages).includes(name)) continue
      if (TECH_CATEGORIES.some((category) => matches(category.match, name)) || matches(BUILD_MATCH, name)) usage.set(name, 0)
    }
  }
  const byCategory = new Map<string, Array<[string, number]>>()
  const build: Array<[string, number]> = []
  const other: Array<[string, number]> = []
  for (const [name, count] of usage) {
    if (matches(BUILD_MATCH, name)) {
      build.push([name, count])
      continue
    }
    const category = TECH_CATEGORIES.find((item) => matches(item.match, name))
    if (category) byCategory.set(category.id, [...(byCategory.get(category.id) ?? []), [name, count]])
    else other.push([name, count])
  }
  const techBlock = ([name, count]: [string, number]) => block(ids, name, 'tech', { packages: [name], description: count > 0 ? `代码里导入 ${count} 次` : '清单里声明' })
  const sorted = (items: Array<[string, number]>) => [...items].sort((a, b) => b[1] - a[1]).slice(0, MAX_TECH_PER_LAYER)
  for (const category of TECH_CATEGORIES) {
    const items = byCategory.get(category.id)
    if (!items?.length) continue
    diagram.layers.push({ id: ids.next('layer'), name: category.name, description: '', groups: [{ id: ids.next('group'), name: '', blocks: sorted(items).map(techBlock), pinned: false }], pinned: false })
  }
  if (other.length > 0) {
    diagram.layers.push({ id: ids.next('layer'), name: '其他依赖', description: '没认出用途的外部包，按导入次数排', groups: [{ id: ids.next('group'), name: '', blocks: sorted(other).map(techBlock), pinned: false }], pinned: false })
  }
  // 最底层：语言和它自带的库
  const runtime: DiagramBlock[] = analysis.stats.languages.slice(0, 6).map((item) => block(ids, LANGUAGE_NAMES[item.language] ?? item.language, 'tech', { description: `${item.files} 个文件，${item.lines} 行` }))
  const builtins = new Map<string, string[]>()
  for (const external of analysis.externals) if (external.builtin) builtins.set(external.ecosystem, [...(builtins.get(external.ecosystem) ?? []), external.name])
  for (const [ecosystem, names] of builtins) runtime.push(block(ids, LANGUAGE_RUNTIMES[ecosystem] ?? ecosystem, 'tech', { packages: names.slice(0, 20), description: names.slice(0, 8).join('、') }))
  if (runtime.length > 0) diagram.layers.push({ id: ids.next('layer'), name: '语言与运行时', description: '', groups: [{ id: ids.next('group'), name: '', blocks: runtime, pinned: false }], pinned: false })
  if (build.length > 0 && diagram.layers.length > 0) {
    diagram.sides.push({ id: ids.next('side'), name: '构建与测试', description: '', from: diagram.layers[0]!.id, to: diagram.layers[diagram.layers.length - 1]!.id, blocks: sorted(build).map(techBlock), pinned: false })
  }
  return diagram
}

// ---------- 系统架构：使用者、各个包（进程或部署单元）、外部服务 ----------

const EXTERNAL_SERVICE_CATEGORIES: Array<{ category: string; name: string }> = [
  { category: 'ai', name: '模型服务' },
  { category: 'data', name: '数据库' },
  { category: 'comm', name: '网络服务' },
]

function staticSystem(analysis: ArchitectureAnalysis): BlockDiagram {
  const diagram = emptyDiagram('system', analysis)
  const ids = new IdMaker()
  const users: DiagramLayer = { id: ids.next('layer'), name: '使用者', description: '', groups: [{ id: ids.next('group'), name: '', blocks: [block(ids, '用户', 'external')], pinned: false }], pinned: false }
  const packages = analysis.packages.filter((item) => analysis.files.some((file) => file.package === item.dir))
  const units: DiagramGroup = {
    id: ids.next('group'),
    name: '',
    blocks: packages.map((item) =>
      block(ids, item.name, 'code', { paths: [item.dir || '**'], description: item.entries.length > 0 ? `入口：${item.entries.slice(0, 4).join('、')}` : (item.description ?? '') }),
    ),
    pinned: false,
  }
  diagram.layers.push(users, { id: ids.next('layer'), name: '应用', description: '项目里的各个包', groups: [units], pinned: false })
  const services: DiagramBlock[] = []
  for (const { category, name } of EXTERNAL_SERVICE_CATEGORIES) {
    const patterns = TECH_CATEGORIES.find((item) => item.id === category)!.match
    const used = analysis.externals.filter((external) => !external.builtin && matches(patterns, external.name)).map((external) => external.name)
    if (used.length > 0) services.push(block(ids, name, 'external', { packages: used.slice(0, 10), description: `通过 ${used.slice(0, 4).join('、')}` }))
  }
  if (services.length > 0) diagram.layers.push({ id: ids.next('layer'), name: '外部服务', description: '', groups: [{ id: ids.next('group'), name: '', blocks: services, pinned: false }], pinned: false })
  for (let at = 0; at + 1 < diagram.layers.length; at++) diagram.connectors.push({ from: diagram.layers[at]!.id, to: diagram.layers[at + 1]!.id, label: at === 0 ? '使用' : '' })
  return diagram
}

export function staticDiagram(kind: DiagramKind, analysis: ArchitectureAnalysis): BlockDiagram {
  if (kind === 'application') return staticApplication(analysis)
  if (kind === 'technology') return staticTechnology(analysis)
  return staticSystem(analysis)
}

// ---------- 核对和保留手改 ----------

// 方块的代码路径和外部包对照分析结果：对不上的路径、包去掉，一个都对不上的方块标「未核对」。
// 目标架构里的方块可以是计划中的，不走这一步
export function verifyDiagram(analysis: ArchitectureAnalysis, diagram: BlockDiagram): BlockDiagram {
  const files = analysis.files.map((file) => file.path)
  const exact = new Set([...files, ...analysis.modules.map((module) => module.path)])
  const packages = new Set([...analysis.externals.map((external) => external.name), ...analysis.packages.flatMap((item) => item.dependencies), ...analysis.packages.map((item) => item.name)])
  let dropped = 0
  const check = (item: DiagramBlock): DiagramBlock => {
    // 手改过的方块用户说了算，不删它的路径
    if (item.pinned) return item
    const paths = item.paths.filter((path) => exact.has(path) || (/[*?[]/.test(path) && files.some(pathMatcher(path))))
    const kept = item.packages.filter((name) => packages.has(name))
    dropped += item.paths.length - paths.length + item.packages.length - kept.length
    const claimed = item.paths.length + item.packages.length > 0
    return { ...item, paths, packages: kept, unverified: claimed && paths.length + kept.length === 0 }
  }
  const next: BlockDiagram = {
    ...diagram,
    layers: diagram.layers.map((layer) => ({ ...layer, groups: layer.groups.map((group) => ({ ...group, blocks: group.blocks.map(check) })) })),
    sides: diagram.sides.map((side) => ({ ...side, blocks: side.blocks.map(check) })),
  }
  return { ...next, dropped: diagram.dropped + dropped }
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

// 重新生成时保留用户手改过（pinned）的层、分组、竖栏和方块：新图里同名的换成手改的版本，没有的按原来的层和分组插回去
export function keepPinned(previous: BlockDiagram | null | undefined, next: BlockDiagram): BlockDiagram {
  if (!previous) return next
  const result: BlockDiagram = structuredClone(next)
  const pinnedBlocks = [
    ...previous.layers.flatMap((layer) => layer.groups.flatMap((group) => group.blocks.filter((item) => item.pinned).map((item) => ({ item, layer, group, side: null })))),
    ...previous.sides.flatMap((side) => side.blocks.filter((item) => item.pinned).map((item) => ({ item, layer: null, group: null, side }))),
  ]
  // 新图里同名的方块，或者认领的代码和手改方块一模一样的（用户改了名的同一个模块），都让位给手改的
  const sameBlock = (pinned: DiagramBlock) => {
    const paths = [...pinned.paths].sort().join('\n')
    return (item: DiagramBlock) => sameName(item.name, pinned.name) || (paths !== '' && [...item.paths].sort().join('\n') === paths)
  }
  const removeSame = (pinned: DiagramBlock) => {
    const same = sameBlock(pinned)
    for (const layer of result.layers) for (const group of layer.groups) group.blocks = group.blocks.filter((item) => !same(item))
    for (const side of result.sides) side.blocks = side.blocks.filter((item) => !same(item))
  }
  // 手改过的层：名字、说明用手改的；新图没有这一层就插回原来的位置
  previous.layers.forEach((layer, at) => {
    if (!layer.pinned) return
    const existing = result.layers.find((item) => item.id === layer.id || sameName(item.name, layer.name))
    if (existing) Object.assign(existing, { id: layer.id, name: layer.name, description: layer.description, pinned: true })
    else result.layers.splice(Math.min(at, result.layers.length), 0, { ...layer, groups: layer.groups.map((group) => ({ ...group, blocks: [] })) })
  })
  for (const layer of previous.layers) {
    for (const group of layer.groups) {
      if (!group.pinned) continue
      const target = result.layers.find((item) => item.id === layer.id || sameName(item.name, layer.name))
      if (target && !target.groups.some((item) => item.id === group.id || sameName(item.name, group.name))) target.groups.push({ ...group, blocks: [] })
    }
  }
  for (const side of previous.sides) {
    if (!side.pinned) continue
    const existing = result.sides.find((item) => item.id === side.id || sameName(item.name, side.name))
    if (existing) Object.assign(existing, { id: side.id, name: side.name, description: side.description, from: side.from, to: side.to, pinned: true })
    else result.sides.push({ ...side, blocks: [] })
  }
  for (const { item, layer, group, side } of pinnedBlocks) {
    removeSame(item)
    if (side) {
      const target = result.sides.find((candidate) => candidate.id === side.id || sameName(candidate.name, side.name))
      if (target) target.blocks.push(item)
      else result.sides.push({ ...side, blocks: [item] })
      continue
    }
    let targetLayer = result.layers.find((candidate) => candidate.id === layer!.id || sameName(candidate.name, layer!.name))
    if (!targetLayer) {
      targetLayer = { ...layer!, groups: [] }
      result.layers.push(targetLayer)
    }
    let targetGroup = targetLayer.groups.find((candidate) => candidate.id === group!.id || sameName(candidate.name, group!.name))
    if (!targetGroup) {
      targetGroup = { ...group!, blocks: [] }
      targetLayer.groups.push(targetGroup)
    }
    targetGroup.blocks.push(item)
  }
  // 竖栏指向的层可能换了 id：按位置兜底
  const layerIds = new Set(result.layers.map((layer) => layer.id))
  for (const side of result.sides) {
    if (!layerIds.has(side.from)) side.from = result.layers[0]?.id ?? side.from
    if (!layerIds.has(side.to)) side.to = result.layers[result.layers.length - 1]?.id ?? side.to
  }
  result.connectors = result.connectors.filter((connector) => layerIds.has(connector.from) && layerIds.has(connector.to))
  return result
}

const clipName = (name: string) => (name.length > 12 ? `${name.slice(0, 11)}…` : name)

export function thumbnailOf(diagram: BlockDiagram | null | undefined): ArchitectureThumbnail | null {
  if (!diagram || diagram.layers.length === 0) return null
  return {
    layers: diagram.layers.slice(0, 7).map((layer) => ({
      name: clipName(layer.name),
      blocks: layer.groups.flatMap((group) => group.blocks.map((item) => clipName(item.name))).slice(0, 8),
    })),
  }
}
