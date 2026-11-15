import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { analyzeProject } from '../src/architecture/engine.js'
import { generateDiagram, generateFlowChart, interpretArchitecture, interpretModule, proposeTarget } from '../src/architecture/interpret.js'
import type { ArchitectureAnalysis, TargetArchitecture } from '../src/architecture/model.js'
import { findRipgrep } from '../src/environment.js'
import { startScriptedServer } from './scripted-server.js'

const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'shop', main: 'src/main.ts', dependencies: { express: '^5' } }),
  'README.md': '# Shop\n一个小网店后端。\n',
  'src/main.ts': "import express from 'express'\nimport { listOrders } from './orders/service.js'\n\nexport function start() {\n  express().get('/orders', listOrders)\n}\n",
  'src/orders/service.ts': "import { query } from '../db/client.js'\n\nexport function listOrders() {\n  return query('select 1')\n}\n",
  'src/db/client.ts': 'export function query(sql: string) {\n  return sql\n}\n',
}

let root: string
let analysis: ArchitectureAnalysis

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'diffra-arch-model-'))
  for (const [path, content] of Object.entries(FILES)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  analysis = (await analyzeProject({ projectId: 't', root, rgPath: await findRipgrep(), cache: null, signal: new AbortController().signal, onProgress: () => {} })).analysis
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const modelAt = (baseUrl: string) => ({ endpoint: { protocol: 'openai-compatible' as const, baseUrl, apiKey: 'k' }, modelId: 'm', contextWindow: null, provider: { id: 'p', name: '测试服务' } })

describe('架构的模型解读', () => {
  test('摘要里有目录、依赖、关键文件和 README；模型给的路径和代码位置逐条核对，对不上的丢掉', async () => {
    const server = await startScriptedServer([
      {
        toolCalls: [
          {
            name: 'submit_architecture',
            input: {
              summary: '一个 express 后端。',
              techStack: ['TypeScript', 'Express'],
              entryPoints: [{ path: 'src/main.ts', description: '启动' }, { path: 'src/server.ts', description: '不存在' }],
              readingOrder: [{ path: './src/orders/', reason: '业务' }],
              externalSystems: [{ name: '数据库', kind: '数据库', description: '', packages: ['express', 'pg'], anchors: [{ path: 'src/db/client.ts', line: 99, symbol: 'query' }] }],
              flows: [
                {
                  name: '查订单',
                  description: '',
                  steps: [
                    { from: '用户', to: 'src/orders', action: '请求', anchor: { path: 'src/main.ts', line: 5, symbol: null } },
                    { from: 'src/orders', to: 'src/db', action: '查询', anchor: { path: 'src/orders/service.ts', line: 400, symbol: null } },
                    { from: 'src/db', to: '数据库', action: 'SQL', anchor: { path: 'lib/x.ts', line: 1, symbol: null } },
                  ],
                },
              ],
            },
          },
        ],
      },
    ])
    try {
      const { value, usage } = await interpretArchitecture(analysis, modelAt(server.baseUrl), { 'src/db': { generatedAt: '', model: { provider: '', modelId: '' }, summary: '旧的', responsibilities: [], keyFiles: [], risks: [] }, gone: { generatedAt: '', model: { provider: '', modelId: '' }, summary: '', responsibilities: [], keyFiles: [], risks: [] } })
      const body = server.bodies[0]!
      expect(body).toContain('src/orders/: 1/5')
      expect(body).toContain('listOrders(function)@3')
      expect(body).toContain('express [npm]: 1')
      expect(body).toContain('一个小网店后端')
      expect(usage).not.toBeNull()
      expect(value.model).toEqual({ provider: '测试服务', modelId: 'm' })
      expect(value.entryPoints.map((item) => item.path)).toEqual(['src/main.ts'])
      expect(value.readingOrder.map((item) => item.path)).toEqual(['src/orders'])
      // 给了符号名的按符号的行号改正
      expect(value.externalSystems[0]).toMatchObject({ packages: ['express'], anchors: [{ path: 'src/db/client.ts', line: 1, symbol: 'query' }] })
      expect(value.flows[0]!.steps.map((step) => step.anchor)).toEqual([{ path: 'src/main.ts', line: 5, symbol: null }, null, null])
      expect(value.flows[0]!.steps[2]).toMatchObject({ from: 'src/db', to: '数据库' })
      expect(value.dropped).toBe(3)
      expect(Object.keys(value.notes)).toEqual(['src/db'])
    } finally {
      await server.close()
    }
  })

  test('单个目录的解读：带上目录里文件的开头，关键文件路径要对得上', async () => {
    const server = await startScriptedServer([
      { toolCalls: [{ name: 'submit_module', input: { summary: '订单服务。', responsibilities: ['列订单'], keyFiles: [{ path: 'src/orders/service.ts', role: '入口' }, { path: 'src/orders/x.ts', role: '编的' }], risks: [] } }] },
    ])
    try {
      const { value } = await interpretModule(analysis, 'src/orders', modelAt(server.baseUrl))
      expect(server.bodies[0]).toContain("return query('select 1')")
      expect(server.bodies[0]).toContain('Used by (directory: count):\\n- src: 1')
      expect(value.keyFiles).toEqual([{ path: 'src/orders/service.ts', role: '入口' }])
    } finally {
      await server.close()
    }
  })

  test('流程图：带上各步代码位置所在文件的代码（有行号）和符号表；节点、连线、框逐条核对，对不上的去掉', async () => {
    const flow = {
      name: '查订单',
      description: '用户查订单',
      steps: [
        { from: '用户', to: 'src/main.ts', action: '请求', anchor: { path: 'src/main.ts', line: 5, symbol: null } },
        { from: 'src/main.ts', to: 'src/orders', action: '列订单', anchor: { path: 'src/orders/service.ts', line: 3, symbol: 'listOrders' } },
      ],
    }
    const server = await startScriptedServer([
      {
        toolCalls: [
          {
            name: 'submit_flowchart',
            input: {
              groups: [
                { id: 'loop', label: '重试循环', parent: null },
                { id: 'inner', label: '内层', parent: 'gone' },
                { id: 'a', label: 'A', parent: 'b' },
                { id: 'b', label: 'B', parent: 'a' },
                { id: 'empty', label: '空框', parent: null },
              ],
              nodes: [
                { id: 'start', kind: 'start', label: '收到请求', detail: '', group: null, anchor: { path: 'src/main.ts', line: 5, symbol: null } },
                { id: 'query', kind: 'action', label: '查数据库', detail: 'select 1', group: 'loop', anchor: { path: 'src/orders/service.ts', line: 99, symbol: 'listOrders' } },
                { id: 'ok', kind: 'decision', label: '成功？', detail: '', group: 'inner', anchor: { path: 'src/x.ts', line: 1, symbol: null } },
                { id: 'query', kind: 'action', label: '重复的', detail: '', group: null, anchor: null },
                { id: 'end', kind: 'end', label: '返回', detail: '', group: 'a', anchor: null },
              ],
              edges: [
                { from: 'start', to: 'query', label: '' },
                { from: 'query', to: 'ok', label: '' },
                { from: 'ok', to: 'query', label: '否' },
                { from: 'ok', to: 'end', label: '是' },
                { from: 'ok', to: 'nowhere', label: '是' },
                { from: 'start', to: 'query', label: '' },
              ],
              notes: [
                { text: '先查，失败就重试。', nodes: ['query', 'ok', 'ghost'] },
                { text: '  ', nodes: [] },
              ],
            },
          },
        ],
      },
    ])
    try {
      const { value } = await generateFlowChart(analysis, flow, modelAt(server.baseUrl))
      const body = server.bodies[0]!
      expect(body).toContain("5|   express().get('/orders', listOrders)")
      expect(body).toContain('listOrders@3')
      expect(body).toContain('2. src/main.ts -> src/orders: 列订单 [src/orders/service.ts:3 listOrders]')
      expect(value.nodes.map((node) => node.id)).toEqual(['start', 'query', 'ok', 'end'])
      // 给了符号名的按符号的行号改正；文件不存在的代码位置去掉
      expect(value.nodes[1]!.anchor).toEqual({ path: 'src/orders/service.ts', line: 3, symbol: 'listOrders' })
      expect(value.nodes[2]).toMatchObject({ group: 'inner', anchor: null })
      // 上级对不上的、绕成圈的放到最外面；没有节点的框不画
      expect(value.groups).toEqual([
        { id: 'loop', label: '重试循环', parent: null },
        { id: 'inner', label: '内层', parent: null },
        { id: 'a', label: 'A', parent: null },
      ])
      expect(value.edges).toEqual([
        { from: 'start', to: 'query', label: '' },
        { from: 'query', to: 'ok', label: '' },
        { from: 'ok', to: 'query', label: '否' },
        { from: 'ok', to: 'end', label: '是' },
      ])
      expect(value.notes).toEqual([{ text: '先查，失败就重试。', nodes: ['query', 'ok'] }])
      // 重复的节点、对不上的连线、重复的连线、不存在的文件
      expect(value.dropped).toBe(4)
      expect(value.model).toEqual({ provider: '测试服务', modelId: 'm' })
    } finally {
      await server.close()
    }
  })

  test('流程图：流程里没有一处对得上的代码，不调模型', async () => {
    const flow = { name: '空', description: '', steps: [{ from: '用户', to: '数据库', action: '查', anchor: null }] }
    await expect(generateFlowChart(analysis, flow, modelAt('http://127.0.0.1:9'))).rejects.toThrow('这条流程没有对得上的代码位置')
  })

  test('架构图：模型画的方块路径和包逐条核对，层名对上竖栏和连线；手改的方块保留，同名方块沿用旧 id', async () => {
    const server = await startScriptedServer([
      {
        toolCalls: [
          {
            name: 'submit_diagram',
            input: {
              layers: [
                { name: '接口层', description: '对外的 HTTP', groups: [{ name: '入口', blocks: [{ name: '启动', description: '', kind: 'code', paths: ['src/main.ts'], packages: ['express'] }] }] },
                {
                  name: '业务层',
                  description: '',
                  groups: [
                    {
                      name: '',
                      blocks: [
                        { name: '订单', description: '', kind: 'code', paths: ['./src/orders/'], packages: [] },
                        { name: '编的', description: '', kind: 'code', paths: ['src/payments'], packages: ['stripe'] },
                      ],
                    },
                  ],
                },
                { name: '数据层', description: '', groups: [{ name: '', blocks: [{ name: '数据访问', description: '', kind: 'code', paths: ['src/db'], packages: [] }, { name: 'MySQL', description: '', kind: 'external', paths: [], packages: [] }] }] },
              ],
              sides: [{ name: '日志', description: '', fromLayer: '接口层', toLayer: '没有这层', blocks: [{ name: '日志', description: '', kind: 'code', paths: [], packages: [] }] }],
              connectors: [
                { from: '接口层', to: '业务层', label: '函数调用' },
                { from: '业务层', to: '不存在', label: 'x' },
              ],
            },
          },
        ],
      },
    ])
    try {
      const previous = (await import('../src/architecture/diagrams.js')).staticDiagram('application', analysis)
      const pinned = { ...previous.layers[0]!.groups[0]!.blocks[0]!, name: '我的方块', paths: ['src/db'], pinned: true }
      previous.layers[0]!.groups[0]!.blocks.push(pinned)
      const ordersId = 'block-old-orders'
      previous.layers[0]!.groups[0]!.blocks.push({ ...pinned, id: ordersId, name: '订单', pinned: false })
      const { value } = await generateDiagram(analysis, 'application', modelAt(server.baseUrl), previous)
      expect(server.bodies[0]).toContain('应用架构图')
      expect(server.bodies[0]).toContain('「我的方块」')
      expect(value.source).toBe('model')
      // 手改的方块原来所在的层不在新图里：连层一起插回去
      expect(value.layers.map((layer) => layer.name)).toEqual(['接口层', '业务层', '数据层', previous.layers[0]!.name])
      const all = value.layers.flatMap((layer) => layer.groups.flatMap((group) => group.blocks))
      const find = (name: string) => all.find((item) => item.name === name)!
      expect(find('启动')).toMatchObject({ paths: ['src/main.ts'], packages: ['express'], unverified: false })
      expect(find('订单')).toMatchObject({ id: ordersId, paths: ['src/orders'] })
      expect(find('编的')).toMatchObject({ paths: [], packages: [], unverified: true })
      expect(find('MySQL')).toMatchObject({ kind: 'external', unverified: false })
      expect(find('我的方块')).toMatchObject({ pinned: true, paths: ['src/db'] })
      expect(value.sides).toHaveLength(1)
      expect(value.sides[0]!.to).toBe(value.layers.find((layer) => layer.name === '数据层')!.id)
      expect(value.connectors).toEqual([{ from: value.layers[0]!.id, to: value.layers[1]!.id, label: '函数调用' }])
      expect(value.dropped).toBe(2)
    } finally {
      await server.close()
    }
  })

  test('目标架构提案：方块图加规则，规则里的方块名对上 id，沿用现有目标里同名方块的 id', async () => {
    const server = await startScriptedServer([
      {
        toolCalls: [
          {
            name: 'submit_target',
            input: {
              diagram: {
                layers: [
                  { name: '接口', description: '', groups: [{ name: '', blocks: [{ name: '订单', description: '', kind: 'code', paths: ['./src/orders/'], packages: [] }] }] },
                  { name: '数据', description: '', groups: [{ name: '', blocks: [{ name: '数据访问', description: '', kind: 'code', paths: ['src/db'], packages: [] }, { name: '缓存', description: '计划中', kind: 'code', paths: ['src/cache'], packages: [] }] }] },
                ],
                sides: [],
                connectors: [{ from: '接口', to: '数据', label: '函数调用' }],
              },
              layered: true,
              strictLayers: false,
              noCycles: true,
              forbid: [{ from: '数据访问', to: '订单', note: '' }, { from: '订单', to: '不存在', note: '' }],
              allow: [],
              externals: [{ package: 'express', only: ['订单'], note: '' }],
              rationale: '分两层。',
            },
          },
        ],
      },
    ])
    try {
      const current: TargetArchitecture = {
        version: 1,
        updatedAt: '',
        diagram: {
          kind: 'application',
          source: 'model',
          generatedAt: '',
          model: null,
          fingerprint: '',
          layers: [{ id: 'L1', name: '接口', description: '', pinned: false, groups: [{ id: 'G1', name: '', pinned: false, blocks: [{ id: 'C1', name: '订单', description: '', kind: 'code', paths: ['src/orders'], packages: [], pinned: false, unverified: false }] }] }],
          sides: [],
          connectors: [],
          dropped: 0,
        },
        rules: [],
        enforceInTasks: false,
      }
      const { value } = await proposeTarget(analysis, current, '数据层不能依赖业务', modelAt(server.baseUrl))
      expect(server.bodies[0]).toContain('数据层不能依赖业务')
      expect(server.bodies[0]).toContain('- 订单: src/orders')
      const { target } = value
      expect(target.diagram.layers[0]!.id).toBe('L1')
      const blocks = target.diagram.layers.flatMap((layer) => layer.groups.flatMap((group) => group.blocks))
      expect(blocks.map((item) => [item.name, item.paths])).toEqual([
        ['订单', ['src/orders']],
        ['数据访问', ['src/db']],
        ['缓存', ['src/cache']],
      ])
      expect(blocks[0]!.id).toBe('C1')
      expect(target.rules.map((rule) => rule.kind)).toEqual(['layers', 'no-cycles', 'forbid', 'external'])
      expect(target.enforceInTasks).toBe(false)
      expect(value.rationale).toBe('分两层。')
    } finally {
      await server.close()
    }
  })
})
