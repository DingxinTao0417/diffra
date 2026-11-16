import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { answerOpenDialog, startTask, taskInput, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { patch, read, startScriptedModel } from './scripted-model'

// 一个小后端：界面 → 服务 → 数据，服务里两个文件互相依赖
const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'shop', dependencies: { express: '^5' } }),
  'src/ui/App.ts': "import { listOrders } from '../services/orders'\nexport function App() {\n  return listOrders()\n}\n",
  'src/ui/format.ts': 'export function money(value: number) {\n  return `¥${value}`\n}\n',
  'src/services/orders.ts': "import { query } from '../db/client'\nimport { price } from './pricing'\n\nexport function listOrders() {\n  return query('orders').map(price)\n}\n",
  'src/services/pricing.ts': "import { listOrders } from './orders'\nexport function price(row: string) {\n  return row + listOrders.length\n}\n",
  'src/db/client.ts': "import express from 'express'\n\nexport function query(table: string): string[] {\n  void express\n  return [table]\n}\n",
}

const box = (name: string, paths: string[], kind = 'code', packages: string[] = []) => ({ name, description: '', kind, paths, packages })

// 模型画的应用架构图：「支付」的路径是编的，核对后标成对不上
const APPLICATION = {
  layers: [
    { name: '界面层', description: '', groups: [{ name: '界面', blocks: [box('应用界面', ['src/ui'])] }] },
    { name: '业务层', description: '', groups: [{ name: '', blocks: [box('订单服务', ['src/services']), box('支付', ['src/payments'], 'code', ['stripe'])] }] },
    { name: '数据层', description: '', groups: [{ name: '', blocks: [box('数据访问', ['src/db'], 'code', ['express']), box('MySQL', [], 'external')] }] },
  ],
  sides: [{ name: '日志', description: '', fromLayer: '界面层', toLayer: '数据层', blocks: [box('日志', [])] }],
  connectors: [
    { from: '界面层', to: '业务层', label: '函数调用' },
    { from: '业务层', to: '数据层', label: 'SQL 查询' },
  ],
}

const LONG_ACTION = '把订单按创建时间倒序排好，再按每页二十条分页，最后连同总条数一起返回给管理后台渲染成订单列表'

const INTERPRETATION = {
  summary: '一个小网店后端，界面调服务，服务查数据库。',
  techStack: ['TypeScript', 'Express'],
  entryPoints: [{ path: 'src/ui/App.ts', description: '界面入口' }],
  readingOrder: [{ path: 'src/services', reason: '业务都在这里' }],
  externalSystems: [{ name: '数据库', kind: '数据库', description: '存订单', packages: ['express'], anchors: [{ path: 'src/db/client.ts', line: 3, symbol: 'query' }] }],
  flows: [
    {
      name: '列订单',
      description: '界面拿订单列表',
      steps: [
        { from: 'src/ui', to: 'src/services', action: '调 listOrders', anchor: { path: 'src/ui/App.ts', line: 3, symbol: 'App' } },
        { from: 'src/services', to: 'src/db', action: '查询订单表', anchor: { path: 'src/services/orders.ts', line: 5, symbol: null } },
        // 两个参与方最后一段都叫 src；说明很长
        { from: 'apps/web/src', to: 'apps/admin/src', action: LONG_ACTION, anchor: null },
      ],
    },
  ],
}

// 「列订单」的流程图：查不到就重试的循环；有一条连到不存在的节点，核对时去掉
const FLOWCHART = {
  groups: [{ id: 'retry', label: '重试循环', parent: null }],
  nodes: [
    { id: 'start', kind: 'start', label: '界面要订单', detail: '', group: null, anchor: { path: 'src/ui/App.ts', line: 2, symbol: 'App' } },
    { id: 'list', kind: 'action', label: '列订单', detail: 'listOrders', group: 'retry', anchor: { path: 'src/services/orders.ts', line: 1, symbol: 'listOrders' } },
    { id: 'query', kind: 'action', label: '查询订单表', detail: "query('orders')", group: 'retry', anchor: null },
    { id: 'ok', kind: 'decision', label: '查到了？', detail: '', group: 'retry', anchor: null },
    { id: 'done', kind: 'end', label: '返回订单', detail: '', group: null, anchor: null },
  ],
  edges: [
    { from: 'start', to: 'list', label: '' },
    { from: 'list', to: 'query', label: '' },
    { from: 'query', to: 'ok', label: '' },
    { from: 'ok', to: 'list', label: '否' },
    { from: 'ok', to: 'done', label: '是' },
    { from: 'ok', to: 'ghost', label: '超时' },
  ],
  notes: [
    { text: '界面调 listOrders 要订单列表。', nodes: ['start', 'list'] },
    { text: '服务查订单表，没查到就再查一次。', nodes: ['query', 'ok'] },
    { text: '查到后把订单交回界面。', nodes: ['done'] },
  ],
}

const node = (window: Page, id: string) => window.getByTestId(`rf__node-${id}`)
const block = (window: Page, name: string) => window.getByTestId('diagram-block').filter({ has: window.getByText(name, { exact: true }) })
const tab = (window: Page, name: string) => window.getByRole('radio', { name, exact: true })

test('架构：添加项目自动出三张分层方块图；模型画图并核对路径；方块下钻到依赖图、文件、代码；手改的方块重画时保留；目标架构用方块图，任务里新增违规的依赖被打回', async () => {
  test.setTimeout(180_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-arch-'))
  for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(dirname(join(project, path)), { recursive: true })
    writeFileSync(join(project, path), content)
  }
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'submit_diagram', input: APPLICATION }] },
    { toolCalls: [{ name: 'submit_architecture', input: INTERPRETATION }] },
    { toolCalls: [{ name: 'submit_flowchart', input: FLOWCHART }] },
    // 用户把「应用界面」改名后重画：模型还是叫它「应用界面」，认领的代码一样，让位给改了名的
    { toolCalls: [{ name: 'submit_diagram', input: APPLICATION }] },
    // 任务：先查架构图看谁调了 listOrders（v2）；数据层反过来依赖业务层，违反分层，被打回后改掉
    { toolCalls: [{ name: 'architecture', input: { action: 'callers', path: 'src/services/orders.ts', symbol: 'listOrders' } }] },
    { toolCalls: [read('src/db/client.ts')] },
    { toolCalls: [patch('*** Update File: src/db/client.ts', " import express from 'express'", "+import { listOrders } from '../services/orders'")] },
    { text: '数据层用上了订单列表' },
    { toolCalls: [patch('*** Update File: src/db/client.ts', "-import { listOrders } from '../services/orders'")] },
    { text: '去掉了反向依赖' },
    // 模型提目标架构：数据层加一个计划中的「缓存」，去掉右边的「日志」和 MySQL，加一条禁止的依赖
    {
      toolCalls: [
        {
          name: 'submit_target',
          input: {
            diagram: {
              layers: [
                { name: '界面层', description: '', groups: [{ name: '界面', blocks: [box('前端界面', ['src/ui'])] }] },
                { name: '业务层', description: '', groups: [{ name: '', blocks: [box('订单服务', ['src/services'])] }] },
                { name: '数据层', description: '', groups: [{ name: '', blocks: [box('数据访问', ['src/db']), box('支付', []), box('缓存', ['src/cache'])] }] },
              ],
              sides: [],
              connectors: [],
            },
            layered: true,
            strictLayers: false,
            noCycles: true,
            forbid: [{ from: '前端界面', to: '数据访问', note: '界面只能经过业务层' }],
            allow: [],
            externals: [],
            rationale: '数据层加一层缓存；界面不直接碰数据。',
          },
        },
      ],
    },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await expect(window.getByText('要做什么？')).toBeVisible()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })

    // 侧栏进架构，空的；选文件夹添加后自动分析，卡片上是迷你分层图和数字
    await window.getByTestId('sidebar').getByRole('button', { name: '架构', exact: true }).click()
    await expect(window.getByText('还没有项目')).toBeVisible()
    await answerOpenDialog(app, project)
    await window.getByRole('button', { name: '选择文件夹', exact: true }).click()
    const card = window.getByTestId('architecture-card')
    await expect(card.getByText('循环依赖')).toBeVisible({ timeout: 30_000 })
    await expect(card).toContainText('5文件')
    await expect(card.getByTestId('architecture-thumbnail-block')).toHaveCount(3)

    // 打开就是应用架构图：没调模型时按依赖分了三层，每层一个目录
    await card.click()
    await expect(window.getByTestId('architecture-title')).toHaveText(project.split(/[\\/]/).pop()!)
    await expect(window.getByTestId('diagram-layer')).toHaveCount(3)
    await expect(window.getByTestId('diagram-block')).toHaveCount(3)
    await expect(window.getByTestId('architecture-diagram')).toContainText('按包、目录和依赖自动排的')
    // 没选中东西时右边是这张图的概况
    await expect(window.getByTestId('architecture-idle')).toContainText('3 层 · 3 个方块')
    await tab(window, '技术架构').click()
    // 双击技术方块：留在图上选中，不选中方块里的字，右边列出用到它的地方
    await block(window, 'express').dblclick()
    await expect(block(window, 'express')).toHaveAttribute('aria-pressed', 'true')
    expect(await window.evaluate('document.getSelection()?.toString() ?? ""')).toBe('')
    await expect(window.getByTestId('architecture-inspector')).toContainText('用到的地方（1）')
    await tab(window, '系统架构').click()
    await expect(block(window, '用户')).toBeVisible()
    await tab(window, '应用架构').click()

    // 让模型画应用架构图：层、分组、竖栏、连线说明；编的路径和包对不上，方块标出来
    await window.getByTestId('diagram-generate').click()
    await expect(window.getByTestId('architecture-diagram')).toContainText('scripted 画于', { timeout: 30_000 })
    await expect(window.getByTestId('diagram-layer')).toHaveCount(3)
    await expect(window.getByTestId('diagram-side')).toContainText('日志')
    await expect(window.getByTestId('diagram-connector').first()).toContainText('函数调用')
    await expect(block(window, '支付').getByLabel('对不上分析结果')).toBeVisible()
    await expect(block(window, '订单服务')).toContainText('2 文件')

    // 选中方块：右边列出它依赖的和依赖它的方块
    await block(window, '订单服务').click()
    const inspector = window.getByTestId('architecture-inspector')
    await expect(inspector).toContainText('依赖的方块（1）')
    await expect(inspector).toContainText('数据访问')
    await expect(inspector).toContainText('被哪些方块依赖（1）')

    // 双击方块进到它内部的依赖图：两个文件，方块外面的代码按方块分组
    const dataId = await block(window, '数据访问').getAttribute('data-block')
    await block(window, '订单服务').dblclick()
    await expect(window.getByTestId('architecture-breadcrumb')).toContainText('订单服务')
    await expect(node(window, 'file:src/services/orders.ts')).toBeVisible()
    await expect(node(window, `outside:block:${dataId}`)).toContainText('数据访问')
    await expect(node(window, `outside:block:${dataId}`)).toContainText('范围外 · 1 条依赖')

    // 点依赖线看背后的 import，点行号看代码，停在那一行
    await window.getByTestId(`rf__edge-file:src/services/orders.ts>outside:block:${dataId}`).click({ force: true })
    const imports = window.getByTestId('architecture-edge-imports')
    await expect(imports).toContainText('../db/client')
    await imports.getByRole('button', { name: /^1/ }).first().click()
    const source = window.getByTestId('architecture-source')
    await expect(source.locator('.bg-highlight')).toContainText("import { query } from '../db/client'")
    await source.press('Escape')

    // 单击文件看检查器，双击进符号视图，面包屑回到项目这层
    await node(window, 'file:src/services/orders.ts').click()
    await expect(inspector).toContainText('listOrders')
    await node(window, 'file:src/services/orders.ts').dblclick()
    await expect(window.getByTestId('architecture-file')).toContainText('被谁引用（2）')
    // 函数调用图（v2）：listOrders 被 App 调用、调用了 query；点 query 换到 db/client.ts，以 query 为中心
    const fileCalls = window.getByTestId('file-calls')
    await expect(fileCalls.getByTestId('call-function')).toHaveText(['listOrders←1 →1'])
    const callGraph = fileCalls.getByTestId('call-graph')
    await expect(callGraph).toContainText('App')
    await expect(callGraph).toContainText('src/ui/App.ts')
    await window.screenshot({ path: 'test-results/architecture-calls.png' })
    await callGraph.getByText('query', { exact: true }).click()
    await expect(window.getByTestId('architecture-file').getByRole('heading', { level: 2 })).toHaveText('src/db/client.ts')
    await expect(window.getByTestId('call-graph')).toContainText('listOrders')
    await window.getByTestId('architecture-breadcrumb').getByRole('button', { name: '项目', exact: true }).click()
    await expect(window.getByTestId('architecture-node')).toHaveCount(3)

    // 流程：模型解读出的时序图
    await tab(window, '流程').click()
    await window.getByRole('button', { name: '让模型解读' }).click()
    await expect(window.getByTestId('architecture-flows')).toContainText('查询订单表', { timeout: 30_000 })
    // 泳道撞名时带上前一段；箭头上的说明折行，不截断
    const sequence = window.getByRole('img', { name: '列订单的时序图' })
    await expect(sequence.locator('text', { hasText: /^web\/src$/ })).toHaveCount(1)
    await expect(sequence.locator('text', { hasText: /^admin\/src$/ })).toHaveCount(1)
    const label = sequence.locator('text', { hasText: '3. ' })
    await expect(label).toHaveText(`3. ${LONG_ACTION}`)
    expect(await label.locator('tspan').count()).toBeGreaterThan(1)
    await window.getByTestId('architecture-flows').screenshot({ path: 'test-results/architecture-flows.png' })

    // 流程图：让模型读代码画；判断是菱形，循环用框圈起来，连到不存在节点的线去掉
    await window.getByRole('radio', { name: '流程图', exact: true }).click()
    await window.getByRole('button', { name: '让模型画流程图' }).click()
    const flowchart = window.getByTestId('architecture-flowchart')
    await expect(flowchart.getByTestId('flowchart-node')).toHaveCount(5, { timeout: 30_000 })
    expect(model.bodies().at(-1)).toContain('export function listOrders()')
    await expect(flowchart.locator('[data-kind="decision"] polygon')).toHaveCount(1)
    await expect(flowchart.getByTestId('flowchart-group')).toContainText('重试循环')
    await expect(flowchart.getByTestId('flowchart-edge')).toHaveCount(5)
    await expect(flowchart.getByTestId('flowchart-dropped')).toHaveText('有 1 处对不上代码，已去掉')
    // 悬停一条讲解，只突出它说的节点
    const notes = flowchart.getByTestId('flowchart-notes').getByRole('button')
    await expect(notes).toHaveCount(3)
    await notes.nth(1).hover()
    await expect(flowchart.locator('[data-node="query"]')).not.toHaveAttribute('data-dim')
    await expect(flowchart.locator('[data-node="start"]')).toHaveAttribute('data-dim', '')
    await window.mouse.move(0, 0)
    await flowchart.screenshot({ path: 'test-results/architecture-flowchart.png' })
    await window.emulateMedia({ colorScheme: 'dark' })
    await flowchart.screenshot({ path: 'test-results/architecture-flowchart-dark.png' })
    await window.emulateMedia({ colorScheme: 'light' })
    // 有代码位置的节点点开看代码，停在那个函数
    await flowchart.getByRole('button', { name: /^列订单：看代码/ }).click()
    await expect(window.getByTestId('architecture-source').locator('.bg-highlight')).toContainText('export function listOrders()')
    await window.getByTestId('architecture-source').press('Escape')

    // 依赖：循环依赖；热点
    await tab(window, '依赖').click()
    await tab(window, '循环依赖').click()
    await expect(window.getByTestId('architecture-cycle')).toContainText('services/orders.ts')
    await tab(window, '热点').click()
    await expect(window.getByTestId('architecture-hotspots').locator('tbody tr')).toHaveCount(5)

    // 手改：编辑模式里双击改名、保存；让模型重画，改过的方块留着
    await tab(window, '架构图').click()
    await window.getByTestId('diagram-edit').click()
    await block(window, '应用界面').dblclick()
    await window.getByLabel('方块名', { exact: true }).fill('前端界面')
    await window.getByLabel('方块名', { exact: true }).press('Enter')
    await window.getByTestId('diagram-save').click()
    await expect(block(window, '前端界面')).toBeVisible()
    await window.getByTestId('diagram-generate').click()
    await expect(window.getByTestId('architecture-progress')).toHaveCount(0, { timeout: 30_000 })
    await expect(block(window, '前端界面')).toBeVisible()
    await expect(block(window, '应用界面')).toHaveCount(0)
    await window.getByTestId('diagram-edit').click()
    const dataGroup = window.getByTestId('diagram-group').filter({ has: block(window, '数据访问') })
    await block(window, '支付').dragTo(dataGroup)
    await block(window, 'MySQL').dragTo(window.getByTestId('diagram-side'))
    await window.getByTestId('diagram-save').click()
    await expect(window.getByTestId('diagram-save')).toHaveCount(0)
    await expect(window.getByTestId('diagram-group').filter({ has: block(window, '数据访问') })).toContainText('支付')
    await expect(window.getByTestId('diagram-side')).toContainText('MySQL')

    // 导出 PNG：存到临时目录，是一张 PNG，宽度和图差不多
    const pngPath = join(project, '..', `${basename(project)}-diagram.png`)
    await app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: target })) as typeof dialog.showSaveDialog
    }, pngPath)
    const diagramWidth = (await window.getByTestId('block-diagram').boundingBox())!.width
    await window.getByRole('button', { name: '导出 PNG' }).click()
    await expect.poll(() => existsSync(pngPath), { timeout: 10_000 }).toBe(true)
    const png = readFileSync(pngPath)
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    // PNG 头里的宽度（大端 32 位），按设备缩放比可能更宽
    expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(Math.floor(diagramWidth * 0.5))
    rmSync(pngPath, { force: true })

    // 目标架构：从应用架构图复制，现状叠在图上，没有违规；没写路径的方块算计划中
    await tab(window, '目标架构').click()
    await window.getByRole('button', { name: /从应用架构图复制/ }).click()
    await expect(window.getByTestId('architecture-target')).toContainText('没有违规')
    await expect(window.getByTestId('target-compare').getByTestId('diagram-block')).toHaveCount(6)
    await expect(window.getByTestId('target-compare').getByText('计划中')).toHaveCount(2)

    // 任务里给数据层加了依赖业务层的 import：架构检查打回，改掉后完成
    await window.getByRole('button', { name: '更多操作', exact: true }).click()
    await window.getByRole('menuitem', { name: '在这个项目开任务' }).click()
    await startTask(window, '让数据层用订单列表')
    await waitTaskDone(window, 60_000)
    await expect(window.getByTestId('tool-call').filter({ hasText: /查架构：被谁调用\s*src\/services\/orders\.ts listOrders/ })).toHaveCount(1)
    expect(model.bodies().some((body) => body.includes('src/ui/App.ts App (call at src/ui/App.ts:3)'))).toBe(true)
    const checks = window.locator('[data-testid="tool-call"][data-kind="architecture"]')
    await expect(checks.first()).toContainText('架构检查 · 1 处问题，已打回', { timeout: 10_000 })
    await expect(checks.first()).toContainText('src/db/client.ts:2')

    // 差距：计划中的方块能生成重构任务，说明填进首页输入框
    await window.getByTestId('sidebar').getByRole('button', { name: '架构', exact: true }).click()
    await window.getByTestId('architecture-card').click()
    await tab(window, '目标架构').click()
    await window.getByRole('radio', { name: /差距/ }).click()
    await expect(window.getByTestId('architecture-gaps')).toContainText('计划了还没有代码的方块（2）')
    await window.getByTestId('architecture-gaps').getByRole('button', { name: '生成重构任务' }).first().click()
    await expect(taskInput(window)).toHaveValue(/按目标架构新建/)

    await window.getByTestId('sidebar').getByRole('button', { name: '架构', exact: true }).click()
    await window.getByTestId('architecture-card').click()
    await tab(window, '目标架构').click()
    await window.getByRole('button', { name: '让模型提方案' }).click()
    const proposal = window.getByTestId('architecture-proposal')
    await proposal.getByLabel('原则').fill('界面不直接碰数据')
    await proposal.getByRole('button', { name: '生成方案' }).click()
    await expect(proposal).toContainText('数据层加一层缓存')
    await expect(proposal.locator('label')).toHaveCount(4)
    await expect(proposal).toContainText('「前端界面」不许依赖「数据访问」')
    // 不要「删除 日志」这一条
    await proposal.locator('label').filter({ hasText: '日志' }).getByRole('checkbox').click()
    await proposal.getByTestId('architecture-proposal-apply').click()
    await expect(proposal).toHaveCount(0)
    const compare = window.getByTestId('target-compare')
    await expect(block(window, '缓存')).toBeVisible()
    await expect(compare.getByTestId('diagram-side')).toContainText('日志')
    await expect(block(window, 'MySQL')).toHaveCount(0)
    await expect(window.getByTestId('architecture-idle')).toContainText('「前端界面」不许依赖「数据访问」')
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
