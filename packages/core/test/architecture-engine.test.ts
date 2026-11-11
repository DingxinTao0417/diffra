import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { checkArchitecture } from '../src/architecture/check.js'
import { analyzeProject, AnalysisCancelled, digestOf, type ParseCache } from '../src/architecture/engine.js'
import { parseManifest, tomlSections } from '../src/architecture/manifests.js'
import { block, IdMaker, keepPinned, staticDiagram, thumbnailOf, verifyDiagram } from '../src/architecture/diagrams.js'
import { type ArchitectureAnalysis, type BlockDiagram, type BlockKind, componentOfPath, type DiagramBlock, diagramBlocks, evaluateTarget, pathMatcher, stronglyConnected, type TargetArchitecture, targetParts } from '../src/architecture/model.js'
import { findRipgrep } from '../src/environment.js'

// 一个小的多语言仓库：npm 工作区（含 tsconfig 别名、exports 指向构建产物）、Python、Go、Rust、Java 各一个包
const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }),
  'packages/core/package.json': JSON.stringify({ name: '@mono/core', exports: { '.': './dist/index.js', './types': './src/types.ts' }, dependencies: { zod: '^4' } }),
  'packages/core/src/index.ts': "import { z } from 'zod'\nimport type { Shape } from './types.js'\nexport const schema = z.object({})\nexport function load(shape: Shape) { return shape }\n",
  'packages/core/src/types.ts': "export interface Shape { id: string }\n",
  'packages/app/package.json': JSON.stringify({ name: '@mono/app', main: 'src/main.tsx', dependencies: { react: '^19', '@mono/core': 'workspace:*' } }),
  'packages/app/tsconfig.json': '{\n  // 注释\n  "compilerOptions": { "paths": { "@/*": ["./src/*"] }, },\n}\n',
  'packages/app/src/main.tsx': "import { createRoot } from 'react-dom/client'\nimport { load } from '@mono/core'\nimport type { Shape } from '@mono/core/types'\nimport { View } from '@/ui/View'\nimport { readFileSync } from 'node:fs'\nimport './styles.css'\nimport { missing } from './nope'\nexport const root = createRoot(document.body)\n",
  'packages/app/src/styles.css': 'body {}\n',
  'packages/app/src/ui/View.tsx': "import { helper } from '../util'\nexport function View() { return helper() }\n",
  'packages/app/src/util/index.ts': "import { View } from '../ui/View'\nexport const helper = () => View\n",
  'py/pyproject.toml': '[project]\nname = "pysvc"\ndependencies = [\n  "requests>=2",\n  "numpy[extra]; python_version<\'3.11\'",\n]\n[project.scripts]\nsvc = "pysvc.cli:main"\n',
  'py/src/pysvc/__init__.py': '',
  'py/src/pysvc/cli.py': 'import os\nimport requests\nfrom pysvc import models\nfrom .db import connect\n\ndef main():\n    connect()\n',
  'py/src/pysvc/models.py': 'class User:\n    pass\n',
  'py/src/pysvc/db.py': 'from .models import User\n\ndef connect():\n    return User()\n',
  'goapp/go.mod': 'module example.com/goapp\n\ngo 1.22\n\nrequire (\n\tgithub.com/spf13/cobra v1.8.0\n)\n',
  'goapp/main.go': 'package main\n\nimport (\n\t"fmt"\n\t"example.com/goapp/internal/store"\n\t"github.com/spf13/cobra/doc"\n)\n\nfunc main() { fmt.Println(store.Open()) }\n',
  'goapp/internal/store/store.go': 'package store\n\nfunc Open() string { return "" }\n',
  'goapp/internal/store/store_test.go': 'package store\n',
  'rs/Cargo.toml': '[package]\nname = "rs-core"\nversion = "0.1.0"\n\n[dependencies]\nserde = { version = "1" }\n',
  'rs/src/lib.rs': 'pub mod net;\nmod util;\nuse crate::net::client::Client;\nuse serde::Serialize;\n',
  'rs/src/net/mod.rs': 'pub mod client;\n',
  'rs/src/net/client.rs': 'use super::super::util::helper;\npub struct Client;\n',
  'rs/src/util.rs': 'pub fn helper() {}\n',
  'java/pom.xml': '<project><artifactId>jsvc</artifactId><dependencies><dependency><groupId>com.google.guava</groupId><artifactId>guava</artifactId></dependency></dependencies></project>',
  'java/src/main/java/com/acme/App.java': 'package com.acme;\n\nimport com.acme.data.Repo;\nimport com.google.common.collect.ImmutableList;\nimport java.util.List;\n\npublic class App {\n  public static void main(String[] args) { Helper.run(); new Repo(); }\n}\n',
  'java/src/main/java/com/acme/Helper.java': 'package com.acme;\n\npublic class Helper { public static void run() {} }\n',
  'java/src/main/java/com/acme/data/Repo.java': 'package com.acme.data;\n\npublic class Repo {}\n',
  'build/bundle.min.js': `var a=${'1+'.repeat(6000)}1;\n`,
}

let root: string
let rgPath: string
let analysis: ArchitectureAnalysis
let cache: ParseCache

const fileIndex = (path: string) => analysis.files.findIndex((file) => file.path === path)
const depends = (from: string, to: string) => analysis.edges.some((edge) => edge.from === fileIndex(from) && edge.to === fileIndex(to))

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'diffra-arch-'))
  for (const [path, content] of Object.entries(FILES)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  rgPath = await findRipgrep()
  const result = await analyzeProject({ projectId: 'test', root, rgPath, cache: null, signal: new AbortController().signal, onProgress: () => {} })
  analysis = result.analysis
  cache = result.cache
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('架构分析：清单和包', () => {
  test('每个清单所在目录是一个包，根目录也是', () => {
    expect(analysis.packages.map((item) => `${item.dir}|${item.name}|${item.ecosystem}`).sort()).toEqual(
      ['|mono|npm', 'goapp|example.com/goapp|go', 'java|jsvc|maven', 'packages/app|@mono/app|npm', 'packages/core|@mono/core|npm', 'py|pysvc|python', 'rs|rs-core|cargo'].sort(),
    )
    expect(analysis.files.find((file) => file.path === 'py/src/pysvc/db.py')?.package).toBe('py')
  })

  test('入口：清单里写的（exports 指向 dist 时换成 src）和各语言的惯例', () => {
    const entries = analysis.files.filter((file) => file.entry).map((file) => file.path).sort()
    expect(entries).toEqual(
      ['goapp/main.go', 'java/src/main/java/com/acme/App.java', 'packages/app/src/main.tsx', 'packages/core/src/index.ts', 'packages/core/src/types.ts', 'py/src/pysvc/cli.py', 'rs/src/lib.rs'].sort(),
    )
  })

  test('TOML、Python 依赖名、pom 依赖', () => {
    expect(tomlSections('[a]\nx = [\n "1",\n "2",\n]\n[b.c]\ny = { v = "1" }\n').get('a')?.get('x')).toContain('"2"')
    expect(parseManifest('python', FILES['py/pyproject.toml']!, 'x').dependencies).toEqual(['requests', 'numpy'])
    expect(parseManifest('maven', FILES['java/pom.xml']!, 'x')).toMatchObject({ name: 'jsvc', dependencies: ['com.google.guava:guava'] })
    expect(parseManifest('cargo', FILES['rs/Cargo.toml']!, 'x')).toMatchObject({ name: 'rs-core', dependencies: ['serde'] })
  })

  test('压缩产物不进图，记在跳过里', () => {
    expect(analysis.files.some((file) => file.path.startsWith('build/'))).toBe(false)
    expect(analysis.stats.skipped.generated).toBe(1)
  })
})

describe('架构分析：依赖解析', () => {
  test('TS：相对路径 .js 对 .ts、目录 index、tsconfig 别名、工作区包和它的 exports 子路径', () => {
    expect(depends('packages/core/src/index.ts', 'packages/core/src/types.ts')).toBe(true)
    expect(depends('packages/app/src/ui/View.tsx', 'packages/app/src/util/index.ts')).toBe(true)
    expect(depends('packages/app/src/main.tsx', 'packages/app/src/ui/View.tsx')).toBe(true)
    expect(depends('packages/app/src/main.tsx', 'packages/core/src/index.ts')).toBe(true)
    expect(depends('packages/app/src/main.tsx', 'packages/core/src/types.ts')).toBe(true)
    const edge = analysis.edges.find((item) => item.from === fileIndex('packages/app/src/main.tsx') && item.to === fileIndex('packages/core/src/types.ts'))
    expect(edge?.imports).toEqual([{ line: 3, specifier: '@mono/core/types', names: ['Shape'], kind: 'type' }])
  })

  test('外部包按名字合并，Node 内置模块单独标出；样式文件不算没对上', () => {
    const react = analysis.externals.find((item) => item.name === 'react-dom')
    expect(react).toMatchObject({ ecosystem: 'npm', builtin: false, declared: false, count: 1 })
    expect(analysis.externals.find((item) => item.name === 'node:fs')).toMatchObject({ builtin: true })
    expect(analysis.externals.find((item) => item.name === 'zod')).toMatchObject({ declared: true })
    expect(analysis.unresolved.map((item) => `${analysis.files[item.file]!.path}:${item.line} ${item.specifier}`)).toEqual(['packages/app/src/main.tsx:7 ./nope'])
  })

  test('Python：相对导入、从 src 根开始的绝对导入、子模块；标准库和第三方', () => {
    expect(depends('py/src/pysvc/cli.py', 'py/src/pysvc/db.py')).toBe(true)
    expect(depends('py/src/pysvc/cli.py', 'py/src/pysvc/models.py')).toBe(true)
    expect(depends('py/src/pysvc/db.py', 'py/src/pysvc/models.py')).toBe(true)
    expect(analysis.externals.find((item) => item.name === 'os')).toMatchObject({ ecosystem: 'python', builtin: true })
    expect(analysis.externals.find((item) => item.name === 'requests')).toMatchObject({ builtin: false, declared: true })
  })

  test('Go：模块路径对到目录里的文件（不含测试），标准库，go.mod 里声明的模块', () => {
    expect(depends('goapp/main.go', 'goapp/internal/store/store.go')).toBe(true)
    expect(depends('goapp/main.go', 'goapp/internal/store/store_test.go')).toBe(false)
    expect(analysis.externals.find((item) => item.name === 'fmt')).toMatchObject({ ecosystem: 'go', builtin: true })
    expect(analysis.externals.find((item) => item.name === 'github.com/spf13/cobra')).toMatchObject({ declared: true })
  })

  test('Rust：mod 声明、crate:: 和 super:: 路径、外部 crate', () => {
    expect(depends('rs/src/lib.rs', 'rs/src/net/mod.rs')).toBe(true)
    expect(depends('rs/src/lib.rs', 'rs/src/util.rs')).toBe(true)
    expect(depends('rs/src/net/mod.rs', 'rs/src/net/client.rs')).toBe(true)
    expect(depends('rs/src/lib.rs', 'rs/src/net/client.rs')).toBe(true)
    expect(depends('rs/src/net/client.rs', 'rs/src/util.rs')).toBe(true)
    expect(analysis.externals.find((item) => item.name === 'serde')).toMatchObject({ ecosystem: 'cargo', declared: true })
  })

  test('Java：按 package 和类名找文件；同包的类不用 import 也算依赖', () => {
    expect(depends('java/src/main/java/com/acme/App.java', 'java/src/main/java/com/acme/data/Repo.java')).toBe(true)
    expect(depends('java/src/main/java/com/acme/App.java', 'java/src/main/java/com/acme/Helper.java')).toBe(true)
    expect(analysis.externals.find((item) => item.name === 'java.util')).toMatchObject({ builtin: true })
    expect(analysis.externals.find((item) => item.name === 'com.google.common')).toMatchObject({ builtin: false })
  })

  test('目录汇总代码行数，循环依赖算得出来', () => {
    expect(analysis.modules.find((module) => module.path === 'packages/app/src')).toMatchObject({ files: 3, package: 'packages/app' })
    expect(digestOf(analysis).cycles).toBe(1)
  })
})

describe('没有模型时按规则出的架构图', () => {
  const names = (diagram: BlockDiagram) => diagram.layers.map((layer) => `${layer.name}：${layer.groups.flatMap((group) => group.blocks.map((item) => item.name)).join('、')}`)

  test('应用架构：每个包一组，按依赖分层（应用在核心上面），代码都有方块认领', () => {
    const diagram = staticDiagram('application', analysis)
    const layerOf = (name: string) => diagram.layers.findIndex((layer) => layer.groups.some((group) => group.name === name))
    expect(layerOf('@mono/app')).toBeLessThan(layerOf('@mono/core'))
    expect(diagram.layers.flatMap((layer) => layer.groups.map((group) => group.name)).sort()).toEqual(['@mono/app', '@mono/core', 'example.com/goapp', 'jsvc', 'pysvc', 'rs-core'].sort())
    const components = diagramBlocks(diagram).map(({ block }) => ({ id: block.id, name: block.name, layer: null, paths: block.paths }))
    expect(analysis.files.filter((file) => componentOfPath(components, file.path) === null).map((file) => file.path)).toEqual([])
    expect(diagram.connectors.length).toBe(diagram.layers.length - 1)
  })

  test('技术架构：外部包按用途分层，语言和自带的库在最底下，构建工具在右边竖栏', () => {
    const diagram = staticDiagram('technology', analysis)
    const layers = names(diagram)
    expect(layers.find((line) => line.startsWith('界面'))).toContain('react-dom')
    expect(layers.find((line) => line.startsWith('通用库'))).toContain('zod')
    expect(layers.at(-1)).toContain('TypeScript')
    expect(layers.at(-1)).toContain('Python 标准库')
    expect(diagram.sides).toEqual([])
  })

  test('系统架构：使用者、各个包、外部服务', () => {
    const diagram = staticDiagram('system', analysis)
    expect(diagram.layers.map((layer) => layer.name)).toEqual(['使用者', '应用', '外部服务'])
    expect(names(diagram)[2]).toContain('网络服务')
  })

  test('核对路径和包：对不上的去掉，一个都对不上的标未核对；手改的方块不动', () => {
    const ids = new IdMaker()
    const diagram: BlockDiagram = {
      kind: 'application',
      source: 'model',
      generatedAt: '',
      model: null,
      fingerprint: '',
      layers: [
        {
          id: 'l1',
          name: '界面',
          description: '',
          pinned: false,
          groups: [
            {
              id: 'g1',
              name: '',
              pinned: false,
              blocks: [
                block(ids, '应用', 'code', { paths: ['packages/app/src', 'packages/nope', 'packages/app/src/**/*.tsx'], packages: ['react-dom', 'left-pad'] }),
                block(ids, '编的', 'code', { paths: ['src/fake'] }),
                block(ids, '手改的', 'code', { paths: ['src/planned'], pinned: true }),
              ],
            },
          ],
        },
      ],
      sides: [],
      connectors: [],
      dropped: 0,
    }
    const verified = verifyDiagram(analysis, diagram)
    const blocks = verified.layers[0]!.groups[0]!.blocks
    expect(blocks[0]).toMatchObject({ paths: ['packages/app/src', 'packages/app/src/**/*.tsx'], packages: ['react-dom'], unverified: false })
    expect(blocks[1]).toMatchObject({ paths: [], unverified: true })
    expect(blocks[2]).toMatchObject({ paths: ['src/planned'], unverified: false })
    expect(verified.dropped).toBe(3)
  })

  test('重新生成时保留手改的层和方块：新图里同名的换成手改的，没有的插回原来的层', () => {
    const ids = new IdMaker()
    const previous = staticDiagram('application', analysis)
    const pinnedLayer = { ...previous.layers[0]!, name: '我的界面层', pinned: true }
    pinnedLayer.groups = [{ id: 'g-mine', name: '我的分组', pinned: true, blocks: [block(ids, '手画的', 'code', { paths: ['packages/app/src/ui'], pinned: true })] }]
    const edited = { ...previous, layers: [pinnedLayer, ...previous.layers.slice(1)] }
    const merged = keepPinned(edited, staticDiagram('application', analysis))
    expect(merged.layers[0]!.name).toBe('我的界面层')
    expect(merged.layers[0]!.groups.find((group) => group.name === '我的分组')?.blocks.map((item) => item.name)).toEqual(['手画的'])
    expect(thumbnailOf(merged)?.layers[0]?.name).toBe('我的界面层')
    // 新图里认领同样代码、名字还是旧名的方块让位给改了名的那个
    const fresh = staticDiagram('application', analysis)
    const original = fresh.layers[0]!.groups[0]!.blocks[0]!
    const renamed = keepPinned({ ...fresh, layers: fresh.layers.map((layer, at) => (at === 0 ? { ...layer, groups: layer.groups.map((group, index) => (index === 0 ? { ...group, blocks: [{ ...original, name: '改过名', pinned: true }, ...group.blocks.slice(1)] } : group)) } : layer)) }, staticDiagram('application', analysis))
    const names = diagramBlocks(renamed).map(({ block }) => block.name)
    expect(names).toContain('改过名')
    expect(names).not.toContain(original.name)
  })
})

describe('架构分析：增量和取消', () => {
  test('没改的文件用缓存，改过的重新解析', async () => {
    const path = join(root, 'packages/core/src/types.ts')
    await writeFile(path, "import { schema } from './index.js'\nexport interface Shape { id: string }\n")
    const later = new Date(Date.now() + 5000)
    await utimes(path, later, later)
    const next = await analyzeProject({ projectId: 'test', root, rgPath, cache, signal: new AbortController().signal, onProgress: () => {} })
    expect(next.analysis.stats.reparsed).toBe(1)
    const from = next.analysis.files.findIndex((file) => file.path === 'packages/core/src/types.ts')
    const to = next.analysis.files.findIndex((file) => file.path === 'packages/core/src/index.ts')
    expect(next.analysis.edges.some((edge) => edge.from === from && edge.to === to)).toBe(true)
  })

  test('取消后抛出 AnalysisCancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(analyzeProject({ projectId: 'test', root, rgPath, cache: null, signal: controller.signal, onProgress: () => {} })).rejects.toBeInstanceOf(AnalysisCancelled)
  })
})

describe('目标架构的对比', () => {
  const box = (id: string, name: string, paths: string[], kind: BlockKind = 'code'): DiagramBlock => ({ id, name, description: '', kind, paths, packages: [], pinned: false, unverified: false })
  const target: TargetArchitecture = {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    diagram: {
      kind: 'application',
      source: 'model',
      generatedAt: '',
      model: null,
      fingerprint: '',
      layers: [
        { id: 'ui', name: '界面', description: '', pinned: false, groups: [{ id: 'g1', name: '', pinned: false, blocks: [box('app', '应用', ['packages/app'])] }] },
        {
          id: 'domain',
          name: '领域',
          description: '',
          pinned: false,
          groups: [{ id: 'g2', name: '', pinned: false, blocks: [box('util', '工具', ['packages/app/src/util']), box('core', '核心', ['packages/core']), box('search', '搜索', ['packages/search']), box('llm', '模型服务', [], 'external')] }],
        },
      ],
      sides: [],
      connectors: [],
      dropped: 0,
    },
    rules: [
      { id: 'r1', kind: 'layers', strict: false },
      { id: 'r2', kind: 'forbid', from: 'app', to: 'core', note: '走接口' },
      { id: 'r3', kind: 'no-cycles' },
      { id: 'r4', kind: 'external', package: 'zod', only: ['app'], note: '' },
    ],
    enforceInTasks: true,
  }

  test('路径匹配：目录前缀和通配符，取最具体的组件', () => {
    expect(pathMatcher('packages/app')('packages/app/src/x.ts')).toBe(true)
    expect(pathMatcher('packages/app')('packages/apple/x.ts')).toBe(false)
    expect(pathMatcher('**/*.test.ts')('a/b/c.test.ts')).toBe(true)
    expect(pathMatcher('src/*/index.ts')('src/a/b/index.ts')).toBe(false)
    expect(componentOfPath(targetParts(target).components, 'packages/app/src/util/index.ts')).toBe('util')
    expect(componentOfPath(targetParts(target).components, 'py/x.py')).toBe(null)
    // 通配符前面的固定部分更长，就比更短的目录前缀具体
    const parts = [{ id: 'root', name: '', layer: null, paths: ['packages'] }, { id: 'eval', name: '', layer: null, paths: ['packages/eval/*'] }]
    expect(componentOfPath(parts, 'packages/eval/index.ts')).toBe('eval')
    expect(componentOfPath(parts, 'packages/eval/a/b.ts')).toBe('root')
  })

  test('违规：下层反向依赖上层、禁止的依赖、组件成环、外部包用在不许的地方；没认领的代码和还没有代码的组件', () => {
    const evaluation = evaluateTarget(analysis, target)
    const kinds = evaluation.violations.map((item) => `${item.kind}:${item.from}->${item.to}`).sort()
    expect(kinds).toEqual(['cycle:app->util', 'external:core->zod', 'forbid:app->core', 'layers:util->app'].sort())
    expect(evaluation.violations.find((item) => item.kind === 'forbid')?.edges.length).toBe(2)
    expect(evaluation.planned).toEqual(['search'])
    expect(evaluation.unassigned.map((index) => analysis.files[index]!.path)).toContain('goapp/main.go')
  })

  test('任务里的架构检查：只看新增行里的 import；diffra-allow 放行；外部包规则；新建的文件也算', async () => {
    const path = 'packages/core/src/extra.ts'
    const lines = [
      "import { View } from '../../app/src/ui/View'",
      '// diffra-allow architecture: 临时兼容旧界面',
      "import { helper } from '../../app/src/util'",
      "import { z } from 'zod'",
      "import { load } from './index.js'",
      'export const x = [View, helper, z, load]',
    ]
    await writeFile(join(root, path), `${lines.join('\n')}\n`)
    const added = new Map([[path, new Map(lines.map((text, at) => [at + 1, text]))]])
    const findings = await checkArchitecture(root, analysis, target, added)
    expect(findings.map((item) => `${item.line} ${item.specifier}`)).toEqual(['1 ../../app/src/ui/View', '4 zod'])
    expect(findings[0]!.message).toContain('反向依赖')
    // 已有的行不算在这一轮头上
    const old = await checkArchitecture(root, analysis, target, new Map([['packages/core/src/index.ts', new Map([[99, '']])]]))
    expect(old).toEqual([])
  })

  test('强连通分量：环和自环', () => {
    const graph = [[1], [2], [0], [3], []]
    expect(stronglyConnected(5, (node) => graph[node]!).map((component) => [...component].sort())).toEqual([[0, 1, 2], [3]])
  })
})
