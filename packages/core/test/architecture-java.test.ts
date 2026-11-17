import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { staticDiagram } from '../src/architecture/diagrams.js'
import { analyzeProject, type ParseCache } from '../src/architecture/engine.js'
import { type ArchitectureAnalysis, javaLayout } from '../src/architecture/model.js'
import { findRipgrep } from '../src/environment.js'
import { detectChecks } from '../src/project/detect.js'

// v2 的 Java 适配器：Spring 风格的 Maven 小项目（test/fixtures/java-shop），repository 故意反过来依赖 service
const FIXTURE = join(import.meta.dirname, 'fixtures', 'java-shop')
const J = 'src/main/java/com/acme/shop/'

let root: string
let rgPath: string
let analysis: ArchitectureAnalysis
let cache: ParseCache

const analyze = (previous: ParseCache | null) => analyzeProject({ projectId: 'java-shop', root, rgPath, cache: previous, signal: new AbortController().signal, onProgress: () => {} })

beforeAll(async () => {
  // 复制到临时目录再分析：留在仓库里会读到 Diffra 自己的 git 记录
  root = mkdtempSync(join(tmpdir(), 'diffra-arch-java-'))
  cpSync(FIXTURE, root, { recursive: true })
  rgPath = await findRipgrep()
  const result = await analyze(null)
  analysis = result.analysis
  cache = result.cache
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('架构分析：Java 项目', () => {
  test('入口：带 @SpringBootApplication 的启动类（没有 main 也算）；类上的注解记下来', () => {
    expect(analysis.files.filter((file) => file.entry).map((file) => file.path)).toEqual([`${J}ShopApplication.java`])
    expect(analysis.files.find((file) => file.path === `${J}controller/OrderController.java`)?.annotations).toEqual(['RestController'])
    expect(analysis.packages.map((item) => [item.name, item.ecosystem])).toEqual([['shop', 'maven']])
  })

  test('包和分层：按包名判断，包名看不出来的按类上的注解；测试代码单独算；包之间的依赖带次数', () => {
    const layout = javaLayout(analysis)!
    expect(layout.prefix).toBe('com.acme.shop')
    expect(layout.packages.map((item) => [item.short, item.layer, item.by, item.test])).toEqual([
      ['shop', null, null, false],
      ['billing', 'service', 'annotation', false],
      ['config', 'config', 'name', false],
      ['controller', 'web', 'name', false],
      ['model', 'model', 'name', false],
      ['repository', 'data', 'name', false],
      ['service', 'service', 'name', false],
      ['util', 'common', 'name', false],
      ['service', null, null, true],
    ])
    const controller = layout.packages.find((item) => item.short === 'controller')!
    expect(controller.dependsOn).toEqual([
      { name: 'com.acme.shop.model', count: 1 },
      { name: 'com.acme.shop.service', count: 1 },
    ])
  })

  test('下层反过来依赖上层：数据访问层的 repository 依赖业务层的 service，到文件和行', () => {
    const { violations } = javaLayout(analysis)!
    expect(violations).toEqual([
      {
        from: 'com.acme.shop.repository',
        to: 'com.acme.shop.service',
        fromLayer: 'data',
        toLayer: 'service',
        message: '数据访问层的 repository 反过来依赖业务层的 service',
        edges: [{ file: `${J}repository/OrderRepository.java`, line: 4, specifier: 'com.acme.shop.service.PriceCalculator' }],
      },
    ])
  })

  test('应用架构图按层画：分不出层的在最上面，接口层、业务层、数据访问层、领域模型；配置、通用、测试放竖栏', () => {
    const diagram = staticDiagram('application', analysis)
    expect(diagram.layers.map((layer) => [layer.name, layer.groups.flatMap((group) => group.blocks.map((block) => block.name))])).toEqual([
      ['其他', ['shop']],
      ['接口层', ['controller']],
      ['业务层', ['billing', 'service']],
      ['数据访问层', ['repository']],
      ['领域模型', ['model']],
    ])
    expect(diagram.sides.map((side) => [side.name, side.blocks.map((block) => block.name)])).toEqual([
      ['配置', ['config']],
      ['通用', ['util']],
      ['测试', ['测试代码']],
    ])
    // 方块认领的是包自己的目录，不含子包
    const service = diagram.layers[2]!.groups[0]!.blocks.find((block) => block.name === 'service')!
    expect(service.paths).toEqual([`${J}service/*`])
    expect(diagram.connectors.map((connector) => connector.label)).toEqual(['', '1 处引用', '1 处引用', '1 处引用'])
  })

  test('以前缓存的 Java 解析结果没有注解：重新分析时重新解析这些文件', async () => {
    const stale: ParseCache = structuredClone(cache)
    for (const entry of Object.values(stale.files)) if (entry.facts?.language === 'java') delete entry.facts.annotations
    const result = await analyze(stale)
    expect(result.analysis.stats.reparsed).toBe(Object.values(stale.files).filter((entry) => entry.facts?.language === 'java').length)
    expect(result.analysis.files.filter((file) => file.entry).map((file) => file.path)).toEqual([`${J}ShopApplication.java`])
    // 再分析一次全用缓存
    expect((await analyze(result.cache)).analysis.stats.reparsed).toBe(0)
  })

  test('同一个项目：识别出 Maven 的检查命令', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'diffra-arch-java-bin-'))
    try {
      const env = { PATH: bin, PATHEXT: '.CMD;.EXE', HOME: bin, USERPROFILE: bin, APPDATA: bin, LOCALAPPDATA: bin, ProgramFiles: bin, JAVA_HOME: bin }
      const detected = await detectChecks(root, env)
      expect(detected.checks.map((item) => item.command)).toEqual(['mvn -q -B -DskipTests test-compile', 'mvn -q -B test'])
      expect(detected.notes.join('\n')).toContain('可选：p3c-pmd')
    } finally {
      rmSync(bin, { recursive: true, force: true })
    }
  })

  test('不是 Java 为主的项目没有 Java 分层，应用架构图照旧按目录画', () => {
    const mixed: ArchitectureAnalysis = { ...analysis, files: analysis.files.map((file) => (file.language === 'java' ? { ...file, language: 'typescript' } : file)) }
    expect(javaLayout(mixed)).toBeNull()
  })
})
