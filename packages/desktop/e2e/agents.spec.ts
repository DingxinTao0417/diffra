import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startDesignTask, startTask, waitTaskDone, waitTaskStatus } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { exec, lastToolResult, read, replaceLines, type ScriptMessages, startScriptedModel } from './scripted-model'

test('子智能体：两个工人并行改各自认领的文件，改别人的被拒；卡片显示进度和结果，任务监控列出工人和改动归属；权限确认写明是哪个工人；重启后卡片还在', async () => {
  test.setTimeout(120_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-agents-'))
  writeFileSync(join(project, 'a.txt'), 'alpha\n')
  writeFileSync(join(project, 'b.txt'), 'beta\n')
  const model = await startScriptedModel([
    {
      toolCalls: [
        { name: 'delegate', input: { name: '甲', task: 'WORKER-A：把 a.txt 改成大写', files: ['a.txt'] } },
        { name: 'delegate', input: { name: '乙', task: 'WORKER-B：把 b.txt 改成大写', files: ['b.txt'] } },
      ],
    },
    { text: '两个文件都改好了' },
    // 甲第一步慢一点：乙的确认弹出来时甲还在跑
    { match: 'WORKER-A', toolCalls: [read('a.txt')], delayMs: 2500 },
    { match: 'WORKER-A', toolCalls: [replaceLines('a.txt', 'alpha', 'ALPHA')] },
    { match: 'WORKER-A', toolCalls: [{ name: 'report', input: { summary: 'a.txt 改成大写了' } }] },
    { match: 'WORKER-B', toolCalls: [read('a.txt')] },
    { match: 'WORKER-B', toolCalls: [replaceLines('a.txt', 'alpha', 'hacked')] },
    { match: 'WORKER-B', toolCalls: [exec('echo note > b-note.txt')] },
    { match: 'WORKER-B', toolCalls: [read('b.txt')] },
    { match: 'WORKER-B', toolCalls: [replaceLines('b.txt', 'beta', 'BETA')] },
    { match: 'WORKER-B', toolCalls: [{ name: 'report', input: { summary: 'b.txt 改成大写了', issues: 'a.txt 归甲，没动' } }] },
  ])
  let app = await launchApp(userDataDir)
  try {
    let window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '把两个文件都改成大写')

    // 两张卡片同时在跑；乙跑命令要确认，确认卡写明是乙
    const cards = window.getByTestId('agent-card')
    const card = (name: string) => window.locator(`[data-testid="agent-card"][data-agent="${name}"]`)
    await expect(cards).toHaveCount(2)
    const permission = window.getByTestId('permission-card')
    await expect(permission.getByTestId('permission-agent')).toHaveText('来自子智能体 乙')
    await expect(card('甲')).toHaveAttribute('data-status', 'in_progress')
    await expect(card('甲').getByTestId('agent-progress')).toContainText('第 1 步')
    await expect(window.getByTestId('monitor-agent')).toHaveCount(2)
    await permission.getByRole('button', { name: '允许一次', exact: true }).click()
    await waitTaskDone(window)

    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('ALPHA\n')
    expect(readFileSync(join(project, 'b.txt'), 'utf8')).toBe('BETA\n')
    const a = card('甲')
    const b = card('乙')
    await expect(a).toHaveAttribute('data-status', 'completed')
    await expect(a).toContainText('a.txt 改成大写了')
    await expect(a).toContainText('认领：a.txt')
    await expect(b).toContainText('待处理：a.txt 归甲，没动')
    // 展开乙：改甲认领的 a.txt 被拒，b.txt 的改动能看代码
    await b.getByRole('button', { name: '展开子智能体 乙 的步骤' }).click()
    const bSteps = b.getByTestId('agent-steps')
    const refused = bSteps.locator('[data-testid="tool-call"][data-status="failed"]')
    await expect(refused).toHaveCount(1)
    await refused.getByRole('button').click()
    await expect(bSteps).toContainText('a.txt is owned by worker "甲"')
    await expect(bSteps.getByRole('button', { name: '查看改动 b.txt' })).toBeVisible()
    // 第 660 步：两个一起派出时卡片上面有组织图；结束后写着用时和步数，乙改了的文件列出来
    await expect(window.getByTestId('agent-team').getByTestId('agent-team-member')).toHaveCount(2)
    await expect(b.getByTestId('agent-stats')).toContainText('用时')
    await expect(b.getByTestId('agent-edited')).toContainText('b.txt')
    // 工人的步骤不出现在主对话里
    await expect(window.getByTestId('turn').locator(':scope > [data-testid="tool-call"][data-kind="edit"]')).toHaveCount(0)
    // 任务监控：工人都交回了，改动文件标出是谁改的
    await expect(window.getByTestId('monitor-agent').filter({ hasText: '甲' })).toHaveAttribute('data-status', 'completed')
    await expect(window.getByTestId('monitor-file').filter({ hasText: 'a.txt' }).getByTestId('monitor-file-agent')).toHaveText('甲')
    await expect(window.getByTestId('monitor-file').filter({ hasText: /^b\.txt/ }).getByTestId('monitor-file-agent')).toHaveText('乙')
    // 主智能体和两个工人的请求都发给了模型；工人的请求从它的任务开始，带认领说明
    const workerBodies = model.bodies().filter((body) => body.includes('WORKER-B'))
    expect(workerBodies.some((body) => body.includes('Files you own: b.txt'))).toBe(true)

    // 重启后：卡片、结果和步骤都还在
    await app.close()
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await window.getByTestId('sidebar-task').first().click()
    await expect(window.getByTestId('agent-card')).toHaveCount(2)
    await expect(window.locator('[data-testid="agent-card"][data-agent="甲"]')).toHaveAttribute('data-status', 'completed')
    await window.locator('[data-testid="agent-card"][data-agent="甲"]').getByRole('button', { name: '展开子智能体 甲 的步骤' }).click()
    await expect(window.locator('[data-testid="agent-card"][data-agent="甲"]').getByTestId('agent-steps')).toContainText('a.txt')
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test('子智能体：停止时工人一起停，卡片标成未完成', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-agents-stop-'))
  writeFileSync(join(project, 'a.txt'), 'alpha\n')
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'delegate', input: { name: '慢', task: 'WORKER-SLOW：慢慢看', files: ['a.txt'] } }] },
    { match: 'WORKER-SLOW', toolCalls: [{ name: 'report', input: { summary: '不会到这里' } }], delayMs: 20_000 },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '慢慢来')
    const card = window.getByTestId('agent-card')
    await expect(card).toHaveAttribute('data-status', 'in_progress')
    await window.getByRole('button', { name: '停止', exact: true }).click()
    await expect(card).toHaveAttribute('data-status', 'failed')
    await expect(card).toContainText('已停止')
    await waitTaskStatus(window, 'stopped')
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

// e2e 按 Node 的类型检查，页面里用到的那点 DOM 自己写
type PageDom = { document: { querySelector(selector: string): { getAttribute(name: string): string | null } | null; querySelectorAll(selector: string): { length: number } } }
// 设计页是主进程叠在面板上的单独视图，Playwright 里是另一个页面
type DesignGlobal = typeof globalThis & { __diffraDesign?: { run(name: string, args: unknown, agent?: unknown): Promise<{ text: string }> } }

const frameIds = (messages: ScriptMessages) => {
  const { nodes } = JSON.parse(lastToolResult(messages)) as { nodes: Array<{ id: string; name: string }> }
  return Object.fromEntries(nodes.map((node) => [node.name, node.id]))
}
// 工人的第一条消息里写着它负责的节点
const ownNode = (messages: ScriptMessages) => /Nodes you own: (-?\d+:\d+)/.exec(JSON.stringify(messages))![1]!

test('设计子智能体：两个工人同时画同一页的不同区块，画布上有各自的光标；改别人的区块被拒；做完光标收起', async () => {
  test.setTimeout(120_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-design-agents-'))
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'design_render', input: { jsx: '<Frame name="首页" w={800} h={560} flex="col" bg="#FFFFFF"><Frame name="页眉" w="fill" h={120} bg="#F3F4F6" /><Frame name="列表" w="fill" h={400} bg="#F9FAFB" /></Frame>' } }] },
    { toolCalls: [{ name: 'design_find_nodes', input: { type: 'FRAME' } }] },
    {
      toolCalls: [
        { name: 'delegate', input: (messages: ScriptMessages) => ({ name: '头', task: 'WORKER-HEAD：画页眉', nodes: [frameIds(messages)['页眉']] }) },
        { name: 'delegate', input: (messages: ScriptMessages) => ({ name: '列', task: 'WORKER-LIST：画文章列表', nodes: [frameIds(messages)['列表']] }) },
      ],
    },
    { text: '首页画好了' },
    // 两个工人第一步都慢一点：画布上同时有两个光标
    { match: 'WORKER-HEAD', toolCalls: [{ name: 'design_set_fill', input: (messages: ScriptMessages) => ({ id: ownNode(messages), color: '#FDE68A' }) }], delayMs: 2500 },
    { match: 'WORKER-HEAD', toolCalls: [{ name: 'design_find_nodes', input: { name: '列表' } }] },
    { match: 'WORKER-HEAD', toolCalls: [{ name: 'design_set_fill', input: (messages: ScriptMessages) => ({ id: frameIds(messages)['列表'], color: '#000000' }) }] },
    { match: 'WORKER-HEAD', toolCalls: [{ name: 'report', input: { summary: '页眉涂好了', issues: '列表不归我' } }] },
    { match: 'WORKER-LIST', toolCalls: [{ name: 'design_set_fill', input: (messages: ScriptMessages) => ({ id: ownNode(messages), color: '#BFDBFE' }) }], delayMs: 2500 },
    // 列晚点交回：头去改列表时列还占着它
    { match: 'WORKER-LIST', toolCalls: [{ name: 'report', input: { summary: '列表涂好了' } }], delayMs: 3000 },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startDesignTask(window, '画个博客首页，分给两个工人')
    await expect(window.getByTestId('agent-card')).toHaveCount(2)
    const design = app.context().pages().find((page) => page.url().includes('design.html'))!
    // 两个工人各一个光标；主智能体这时在等它们，不画它的
    const cursors = design.getByTestId('design-agent-cursor')
    await expect(design.locator('[data-testid="design-agent-cursor"][data-agent="头"]')).toBeVisible()
    await expect(design.locator('[data-testid="design-agent-cursor"][data-agent="列"]')).toBeVisible()
    await expect(cursors).toHaveCount(2)
    await waitTaskDone(window)
    // 做完：工人和主智能体的光标都收起
    await expect(cursors).toHaveCount(0)
    const fills = await design.evaluate(async () => {
      const run = (name: string, args: unknown) => (globalThis as DesignGlobal).__diffraDesign!.run(name, args)
      const { nodes } = JSON.parse((await run('find_nodes', { type: 'FRAME' })).text) as { nodes: Array<{ id: string; name: string }> }
      const result: Record<string, unknown> = {}
      for (const node of nodes) result[node.name] = (JSON.parse((await run('get_node', { id: node.id, depth: 0 })).text) as { fills?: unknown }).fills
      return JSON.stringify(result)
    })
    const parsed = JSON.parse(fills) as Record<string, Array<{ color?: { r: number; g: number; b: number } }>>
    const hex = (fill: { color?: { r: number; g: number; b: number } } | undefined) =>
      fill?.color ? `#${[fill.color.r, fill.color.g, fill.color.b].map((value) => Math.round(value * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}` : null
    expect(hex(parsed['页眉']?.[0])).toBe('#FDE68A')
    expect(hex(parsed['列表']?.[0])).toBe('#BFDBFE')
    // 头去改列的区块被拒：列表还是列涂的颜色，拒绝的说明交给了头
    const head = window.locator('[data-testid="agent-card"][data-agent="头"]')
    await expect(head).toContainText('待处理：列表不归我')
    const bodies = model.bodies().filter((body) => body.includes('WORKER-HEAD'))
    expect(bodies.some((body) => body.includes('belongs to worker'))).toBe(true)
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test('设计光标：先到要改的图层再改；名字后写着在干什么，认领的区块有虚线框，改完闪一下；图层在视野外时边上有名字，点一下移过去；结束时显示完成再收起', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-design-cursor-'))
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'design_render', input: { jsx: '<Frame name="首页" w={800} h={560} flex="col" bg="#FFFFFF"><Frame name="页眉" w="fill" h={120} bg="#F3F4F6" /><Frame name="列表" w="fill" h={400} bg="#F9FAFB" /></Frame>' } }] },
    { text: '首页画好了' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startDesignTask(window, '画个首页')
    await waitTaskDone(window)
    const design = app.context().pages().find((page) => page.url().includes('design.html'))!
    const worker = { id: 'w-cursor', name: '甲', color: '#2563EB' }
    const ids = await design.evaluate(async (agent) => {
      const api = (globalThis as DesignGlobal).__diffraDesign!
      const { nodes } = JSON.parse((await api.run('find_nodes', { type: 'FRAME' })).text) as { nodes: Array<{ id: string; name: string }> }
      const byName = Object.fromEntries(nodes.map((node) => [node.name, node.id]))
      await api.run('__agent_claim', { nodes: [byName['页眉'], byName['列表']] }, agent)
      return byName as Record<string, string>
    }, worker)
    const cursor = design.locator('[data-testid="design-agent-cursor"][data-agent="甲"]')
    await expect(cursor).toHaveAttribute('data-node', ids['页眉']!)
    await expect(design.locator('[data-testid="design-agent-claim"][data-agent="甲"]')).toHaveCount(2)

    // 改列表：光标先到列表、名字后写「修改」，走到位后才改（光标到了之后至少还等了一段才改完），改完闪一下
    const seen = await design.evaluate(
      async ({ agent, target }) => {
        const api = (globalThis as DesignGlobal).__diffraDesign!
        const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
        await pause(400)
        const dom = (globalThis as unknown as PageDom).document
        const cursorOf = () => dom.querySelector('[data-testid="design-agent-cursor"][data-agent="甲"]')
        // 记下光标指到列表的时刻
        let arrivedAt = 0
        const watch = setInterval(() => {
          if (!arrivedAt && cursorOf()?.getAttribute('data-node') === target) arrivedAt = performance.now()
        }, 5)
        const pending = api.run('rename_node', { id: target, name: '文章列表' }, agent)
        await pause(40)
        const action = cursorOf()?.getAttribute('data-action')
        await pending
        const doneAt = performance.now()
        clearInterval(watch)
        const flashes = dom.querySelectorAll('[data-testid="design-agent-flash"]').length
        const { name } = JSON.parse((await api.run('get_node', { id: target, depth: 0 })).text) as { name: string }
        return { arrived: arrivedAt > 0, lead: doneAt - arrivedAt, action, name, flashes }
      },
      { agent: worker, target: ids['列表']! },
    )
    expect(seen.arrived).toBe(true)
    expect(seen.lead).toBeGreaterThan(120)
    expect(seen.action).toBe('修改')
    expect(seen.name).toBe('文章列表')
    expect(seen.flashes).toBeGreaterThan(0)
    // 做完这次调用在等模型：名字后面是省略号
    await expect(cursor).toHaveAttribute('data-action', '')

    // 把画布移开：图层不在视野里时，画布边上出现带方向的名字，点一下移回去
    const canvas = design.locator('canvas').first()
    await canvas.hover()
    // 每次滚动最多移 120px
    for (let index = 0; index < 40; index++) await design.mouse.wheel(0, 120)
    const edge = design.locator('[data-testid="design-agent-edge"][data-agent="甲"]')
    await expect(edge).toBeVisible()
    await expect(cursor).toHaveCount(0)
    await edge.click()
    await expect(cursor).toBeVisible()
    await expect(edge).toHaveCount(0)

    // 结束：先显示「完成」，然后光标和认领框都收起
    await design.evaluate((agent) => (globalThis as DesignGlobal).__diffraDesign!.run('__agent_done', {}, agent), worker)
    await expect(cursor).toHaveAttribute('data-action', 'done')
    await expect(design.locator('[data-testid="design-agent-claim"]')).toHaveCount(0)
    await expect(cursor).toHaveCount(0)
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})
