import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { answerOpenDialog, chooseProject, startTask, taskInput, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

interface DesignToolResult {
  text: string
  image: { mimeType: string; data: string } | null
}
// 设计页里的 window.__diffraDesign（e2e 的 tsconfig 没有 DOM 类型，按 globalThis 取）
type DesignGlobal = typeof globalThis & { __diffraDesign?: { ready(): boolean; run(name: string, args: unknown): Promise<DesignToolResult> } }

// 设计页是主进程叠在面板上的单独视图，Playwright 里是另一个页面
async function findDesignPage(app: ElectronApplication): Promise<Page> {
  const pages = () => app.context().pages().filter((page) => page.url().includes('design.html'))
  await expect.poll(() => pages().length, { timeout: 15_000 }).toBeGreaterThan(0)
  const page = pages()[0]!
  await expect.poll(() => page.evaluate(() => (globalThis as DesignGlobal).__diffraDesign?.ready() ?? false), { timeout: 30_000 }).toBe(true)
  return page
}

function runTool(page: Page, name: string, args: unknown): Promise<DesignToolResult> {
  return page.evaluate(([tool, input]) => (globalThis as DesignGlobal).__diffraDesign!.run(tool, input), [name, args] as const)
}

// 按类型找节点；文字节点给内容，其他给名字
async function nodeNames(page: Page, type: string): Promise<string[]> {
  const { nodes } = JSON.parse((await runTool(page, 'find_nodes', { type })).text) as { nodes: Array<{ id: string; name: string }> }
  return Promise.all(
    nodes.map(async (node) => {
      const detail = JSON.parse((await runTool(page, 'get_node', { id: node.id, depth: 0 })).text) as { characters?: string }
      return detail.characters ?? node.name
    }),
  )
}

test('设计面板：OpenPencil 画布能画矩形、写中文、撤销，存成 .fig 再打开，导出 PNG；设计页的外部网络被拦，主界面的 CSP 不变', async () => {
  test.setTimeout(120_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-design-'))
  const model = await startScriptedModel([{ text: '好的' }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '打开设计面板')
    await waitTaskDone(window)

    await window.getByRole('button', { name: '设计', exact: true }).click()
    await expect(window.getByTestId('design-panel')).toBeVisible()
    const design = await findDesignPage(app)
    // 坐标都相对画布：画布左边、上边是图层面板和工具栏
    const box = await design.locator('canvas').boundingBox()
    expect(box?.width).toBeGreaterThan(300)
    const at = (x: number, y: number) => [box!.x + x, box!.y + y] as const
    const blank = at(box!.width - 20, box!.height - 20)

    // 按 R 画矩形
    await design.mouse.click(...blank)
    await design.keyboard.press('r')
    await design.mouse.move(...at(40, 60))
    await design.mouse.down()
    await design.mouse.move(...at(200, 160), { steps: 8 })
    await design.mouse.up()
    expect(await nodeNames(design, 'RECTANGLE')).toHaveLength(1)

    // 按 T 写一段中文
    await design.keyboard.press('Escape')
    await design.keyboard.press('t')
    await design.mouse.click(...at(50, 240))
    await design.keyboard.type('你好 Diffra')
    await design.keyboard.press('Escape')
    await expect.poll(() => nodeNames(design, 'TEXT')).toContain('你好 Diffra')
    // 中文按系统字体排版：两个汉字各约一个字号宽。缺字形时只按方框量，整行会窄很多
    const { nodes: texts } = JSON.parse((await runTool(design, 'find_nodes', { type: 'TEXT' })).text) as { nodes: Array<{ id: string }> }
    await expect
      .poll(async () => (JSON.parse((await runTool(design, 'get_node', { id: texts[0]?.id ?? '', depth: 0 })).text) as { width: number }).width, { timeout: 15_000 })
      .toBeGreaterThan(65)
    await design.screenshot({ path: 'test-results/design-canvas.png' })

    // 撤销到没有文字，矩形还在
    for (let i = 0; i < 5 && (await nodeNames(design, 'TEXT')).length > 0; i++) {
      await design.mouse.click(...blank)
      await design.keyboard.press('Control+z')
    }
    expect(await nodeNames(design, 'TEXT')).toHaveLength(0)
    expect(await nodeNames(design, 'RECTANGLE')).toHaveLength(1)

    // 存成 .fig；清空画布后再打开，矩形回来了
    const figPath = join(project, 'demo.fig')
    await app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: target })) as typeof dialog.showSaveDialog
    }, figPath)
    await window.getByRole('button', { name: '另存到项目（.fig）', exact: true }).click()
    await expect.poll(() => existsSync(figPath) && statSync(figPath).size, { timeout: 15_000 }).toBeGreaterThan(0)
    await design.mouse.click(...blank)
    await design.keyboard.press('Control+a')
    await design.keyboard.press('Delete')
    await expect.poll(() => nodeNames(design, 'RECTANGLE')).toHaveLength(0)
    await answerOpenDialog(app, figPath)
    await window.getByRole('button', { name: '打开 .fig 文件', exact: true }).click()
    await expect.poll(() => nodeNames(design, 'RECTANGLE'), { timeout: 15_000 }).toHaveLength(1)

    // 导出 PNG（智能体看图用的同一个工具）
    const exported = await runTool(design, 'export_image', { format: 'PNG' })
    expect(exported.image?.mimeType).toBe('image/png')
    const png = Buffer.from(exported.image?.data ?? '', 'base64')
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    writeFileSync('test-results/design-export.png', png)

    // 设计页放开了 eval，但外部网络被主进程拦掉；主界面的 CSP 没变，仍然不能 eval
    const network = await design.evaluate(() => fetch('https://example.com/').then(
      () => 'reached',
      (error: unknown) => `blocked: ${String(error)}`,
    ))
    expect(network).toContain('blocked')
    // （Playwright 的 evaluate 走调试协议，不受页面 CSP 限制，所以直接核对 CSP 原文）
    const mainCsp = await window.evaluate<string>(`document.querySelector('meta[http-equiv="Content-Security-Policy"]').content`)
    expect(mainCsp).toContain("script-src 'self';")
    expect(mainCsp).not.toContain('unsafe-eval')
    expect(readFileSync(figPath).length).toBeGreaterThan(100)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

// 机器忙时设计页第一次读系统字体列表要好几秒；把第一次读卡住，写完中文再放行（e2e 的 tsconfig 没有 DOM 类型，写成字符串）
const HOLD_FIRST_LOCAL_FONTS_QUERY = `if (location.href.includes('design.html')) {
  const query = window.queryLocalFonts.bind(window)
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let held = false
  window.__releaseLocalFonts = () => release()
  window.queryLocalFonts = (options) => {
    if (held) return query(options)
    held = true
    return gate.then(() => query(options))
  }
}`

// 页面不可见时 queryLocalFonts 会被拒（「Page needs to be visible.」）；只拒第一次
const REJECT_FIRST_LOCAL_FONTS_QUERY = `if (location.href.includes('design.html')) {
  const query = window.queryLocalFonts.bind(window)
  let rejected = false
  window.queryLocalFonts = (options) => {
    if (rejected) return query(options)
    rejected = true
    return Promise.reject(new DOMException('Page needs to be visible.', 'SecurityError'))
  }
}`

// 打开设计面板、写一段中文；返回读文字宽度的函数
async function writeChinese(app: ElectronApplication, model: { baseUrl: string }, project: string): Promise<{ design: Page; width: () => Promise<number> }> {
  const window = await app.firstWindow()
  await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
  await chooseProject(app, window, project)
  await startTask(window, '打开设计面板')
  await waitTaskDone(window)
  await window.getByRole('button', { name: '设计', exact: true }).click()
  const design = await findDesignPage(app)
  const box = (await design.locator('canvas').boundingBox())!
  await design.mouse.click(box.x + box.width - 20, box.y + box.height - 20)
  await design.keyboard.press('t')
  await design.mouse.click(box.x + 50, box.y + 240)
  await design.keyboard.type('你好 Diffra')
  await design.keyboard.press('Escape')
  await expect.poll(() => nodeNames(design, 'TEXT')).toContain('你好 Diffra')
  const { nodes: texts } = JSON.parse((await runTool(design, 'find_nodes', { type: 'TEXT' })).text) as { nodes: Array<{ id: string }> }
  const width = async () => (JSON.parse((await runTool(design, 'get_node', { id: texts[0]?.id ?? '', depth: 0 })).text) as { width: number }).width
  return { design, width }
}

test('设计面板：系统字体列表晚到、或第一次被拒时，先写的中文之后按系统字体重新排版', async () => {
  test.setTimeout(180_000)
  for (const [initScript, held] of [[HOLD_FIRST_LOCAL_FONTS_QUERY, true], [REJECT_FIRST_LOCAL_FONTS_QUERY, false]] as const) {
    const userDataDir = makeUserDataDir()
    const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-design-'))
    const model = await startScriptedModel([{ text: '好的' }])
    const app = await launchApp(userDataDir)
    try {
      await app.context().addInitScript(initScript)
      const { design, width } = await writeChinese(app, model, project)
      if (held) {
        // 列表没到时中文只能按方框量；这一条也证明卡住生效了
        expect(await width()).toBeLessThan(65)
        await design.evaluate('window.__releaseLocalFonts()')
      }
      await expect.poll(width, { timeout: 15_000 }).toBeGreaterThan(65)
    } finally {
      await app.close()
      await model.close()
      rmSync(project, { recursive: true, force: true })
      rmSync(userDataDir, { recursive: true, force: true })
    }
  }
})

// 面板关着、窗口最小化时设计页不可见，读系统字体会被当场拒绝（「Page needs to be visible.」，连单个字体文件也读不了）。
// Playwright 给页面开了焦点模拟，页面在测试里一直算可见，所以这里模拟不可见和这种拒绝
const SIMULATE_HIDDEN_PAGE = `if (location.href.includes('design.html')) {
  const query = window.queryLocalFonts.bind(window)
  let hidden = false
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
  window.__setPageHidden = (value) => {
    hidden = value
    document.dispatchEvent(new Event('visibilitychange'))
  }
  window.queryLocalFonts = (options) => (hidden ? Promise.reject(new DOMException('Page needs to be visible.', 'SecurityError')) : query(options))
}`

test('设计面板：页面不可见时写进去的中文，回到可见后按系统字体重新排版', async () => {
  test.setTimeout(120_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-design-'))
  const model = await startScriptedModel([{ text: '好的' }])
  const app = await launchApp(userDataDir)
  try {
    await app.context().addInitScript(SIMULATE_HIDDEN_PAGE)
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '打开设计面板')
    await waitTaskDone(window)
    await window.getByRole('button', { name: '设计', exact: true }).click()
    const design = await findDesignPage(app)

    await design.evaluate('window.__setPageHidden(true)')
    // 直接调设计页的工具（智能体调用时会先把面板打开）；新建文字层后攒着的那次准备字体也在不可见时跑完
    await runTool(design, 'render', { jsx: '<Text name="问候" size={20}>你好你好你好</Text>' })
    await design.waitForTimeout(1000)
    const { nodes: texts } = JSON.parse((await runTool(design, 'find_nodes', { type: 'TEXT' })).text) as { nodes: Array<{ id: string }> }
    const width = async () => (JSON.parse((await runTool(design, 'get_node', { id: texts[0]?.id ?? '', depth: 0 })).text) as { width: number }).width
    // 六个汉字、字号 20：系统字体（微软雅黑）每个字一个字号宽，共约 120；读不到时按 Inter 的方框量，方框宽 1344/2048 个字号，共约 79。取中间的 100
    expect(await width()).toBeLessThan(100)

    await design.evaluate('window.__setPageHidden(false)')
    await expect.poll(width, { timeout: 15_000 }).toBeGreaterThan(100)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

const CARD_JSX = `<Frame name="登录卡片" w={320} h="hug" flex="col" gap={12} p={24} bg="#FFFFFF" rounded={12}>
  <Text name="标题" size={20} weight="bold" color="#111827">欢迎回来</Text>
  <Frame name="按钮" w="fill" h={40} bg="#2563EB" rounded={8} />
</Frame>`

test('设计面板：打开后智能体拿到设计工具，用 render 在画布上画、读回节点；关着面板时调用会把面板打开；没打开过面板的任务不带设计工具', async () => {
  test.setTimeout(120_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-design-agent-'))
  const model = await startScriptedModel([
    { text: '先聊聊' },
    { toolCalls: [{ name: 'design_render', input: { jsx: CARD_JSX } }] },
    { toolCalls: [{ name: 'design_find_nodes', input: { type: 'TEXT' } }] },
    { text: '画好了' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '先不画')
    await waitTaskDone(window)

    // 打开设计面板，主进程把设计工具配置给会话；关掉面板后让智能体画
    await window.getByRole('button', { name: '设计', exact: true }).click()
    const design = await findDesignPage(app)
    await window.getByRole('button', { name: '设计', exact: true }).click()
    await expect(window.getByTestId('design-panel')).toBeHidden()
    await taskInput(window).fill('画一个登录卡片')
    await window.getByRole('button', { name: '发送', exact: true }).click()
    // 上一轮的「已完成」还在，先等这一轮的请求都到了
    await expect.poll(() => model.requests(), { timeout: 30_000 }).toBeGreaterThanOrEqual(4)
    await waitTaskDone(window, 30_000)

    const bodies = model.bodies()
    expect(bodies[0]).not.toContain('design_render')
    expect(bodies[0]).not.toContain('Design canvas:')
    expect(bodies[1]).toContain('"design_render"')
    expect(bodies[1]).toContain('Design canvas:')
    // 不看图的模型没有导出图片的工具，说明里让它用 describe 检查
    expect(bodies[1]).not.toContain('"design_export_image"')
    expect(bodies[1]).toContain('design_describe')
    expect(bodies[1]).toContain('Design JSX reference:')
    expect(bodies[2]).toContain('登录卡片')
    expect(bodies[3]).toContain('欢迎回来')
    // 智能体一用设计工具，面板就打开了；画布上有这张卡片，用户能撤销
    await expect(window.getByTestId('design-panel')).toBeVisible()
    expect(await nodeNames(design, 'TEXT')).toContain('欢迎回来')
    expect(await nodeNames(design, 'FRAME')).toEqual(expect.arrayContaining(['登录卡片', '按钮']))
    await design.screenshot({ path: 'test-results/design-agent-card.png' })
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

const ICON_CARD_JSX = `<Frame name="登录卡片" w={320} h="hug" flex="col" gap={12} p={24} bg="#FFFFFF" rounded={12}>
  <Icon name="lucide:bell" size={24} color="#2563EB" />
  <Text name="标题" size={20} weight="bold" color="#111827">欢迎回来</Text>
  <Frame name="按钮" w="fill" h={40} bg="#2563EB" rounded={8} />
</Frame>`

// 设计稿自动存在数据目录的 designs 下，一个任务一个文件
function designFiles(userDataDir: string): string[] {
  const dir = join(userDataDir, 'designs')
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.fig')) : []
}

test('设计任务：首页打开「设计」建任务，面板自动打开、画布占主区，第一条消息就带设计工具（含离线图标）；属性面板和右键菜单能改；自动保存，重启后恢复；删除任务时设计稿一起删', async () => {
  test.setTimeout(180_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-design-task-'))
  const model = await startScriptedModel([{ toolCalls: [{ name: 'design_render', input: { jsx: ICON_CARD_JSX } }] }, { text: '画好了' }])
  let app = await launchApp(userDataDir)
  try {
    let window = await app.firstWindow()
    // 窗口放大一些：设计页里图层、属性两栏都开着时画布还有足够的地方
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1600, 1000))
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    const toggle = window.getByRole('button', { name: '设计', exact: true })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await startTask(window, '画一个登录卡片')
    const panel = window.getByTestId('design-panel')
    await expect(panel).toBeVisible()
    await waitTaskDone(window, 30_000)

    // 第一条消息就带设计工具、说明和内置图标的提示；不用先发一条占位消息
    const bodies = model.bodies()
    expect(bodies[0]).toContain('"design_render"')
    expect(bodies[0]).toContain('"design_insert_icon"')
    expect(bodies[0]).toContain('Design canvas:')
    expect(bodies[0]).toContain('lucide:<name>')
    // 设计面板占主区：比对话列宽
    const widths = await window.evaluate<{ panel: number; column: number }>(
      `({ panel: document.querySelector('[data-testid="design-panel"]').getBoundingClientRect().width, column: document.querySelector('[data-testid="design-panel"]').previousElementSibling.getBoundingClientRect().width })`,
    )
    expect(widths.panel).toBeGreaterThan(widths.column)

    let design = await findDesignPage(app)
    expect(await nodeNames(design, 'FRAME')).toEqual(expect.arrayContaining(['登录卡片', '按钮', 'bell']))

    // 属性面板：从图层树选中卡片，把宽改成 400
    // 两侧面板按设计页宽度自动显隐，没开着就用工具栏打开
    for (const name of ['图层', '属性']) {
      const button = design.getByRole('button', { name, exact: true })
      if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click()
    }
    await design.getByTestId('layer-登录卡片').getByRole('button', { name: '登录卡片', exact: true }).click()
    const widthField = design.getByTestId('design-inspector').getByLabel('宽', { exact: true })
    await widthField.fill('400')
    await widthField.press('Enter')
    const cardWidth = async (page: Page) => {
      const { nodes } = JSON.parse((await runTool(page, 'find_nodes', { name: '登录卡片', type: 'FRAME' })).text) as { nodes: Array<{ id: string }> }
      return (JSON.parse((await runTool(page, 'get_node', { id: nodes[0]?.id ?? '', depth: 0 })).text) as { width: number }).width
    }
    await expect.poll(() => cardWidth(design)).toBe(400)

    // 右键菜单再制一份，再用工具栏撤销
    // 缩放到全部，卡片在画布正中；两侧面板打开后画布变了，这时再量
    await design.getByRole('button', { name: '适应', exact: true }).click()
    const box = (await design.locator('canvas').boundingBox())!
    await design.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
    // 右键选中指针下最里层的图层（和 OpenPencil、Figma 一样），再制出来的是它
    const layerCount = async () => (await nodeNames(design, 'FRAME')).length + (await nodeNames(design, 'TEXT')).length
    const before = await layerCount()
    await design.getByRole('menuitem', { name: '再制' }).click()
    await expect.poll(layerCount).toBe(before + 1)
    await design.getByRole('button', { name: '撤销', exact: true }).click()
    await expect.poll(layerCount).toBe(before)
    await design.screenshot({ path: 'test-results/design-task.png' })

    // 停下来一会儿后自动保存
    await expect.poll(() => designFiles(userDataDir).length, { timeout: 15_000 }).toBe(1)
    const saved = join(userDataDir, 'designs', designFiles(userDataDir)[0]!)
    await expect.poll(() => statSync(saved).size, { timeout: 15_000 }).toBeGreaterThan(0)
    await window.waitForTimeout(2500)
    await app.close()

    // 重启后打开任务：还是设计任务，面板自动打开，卡片和改过的宽度都在
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await window.getByTestId('sidebar-task').click()
    await expect(window.getByTestId('design-panel')).toBeVisible()
    design = await findDesignPage(app)
    await expect.poll(() => nodeNames(design, 'FRAME'), { timeout: 15_000 }).toEqual(expect.arrayContaining(['登录卡片', 'bell']))
    expect(await cardWidth(design)).toBe(400)

    // 删除任务：设计稿一起删
    await window.getByTestId('sidebar-task').click({ button: 'right' })
    await window.getByRole('menuitem', { name: '删除任务记录' }).click()
    await window.getByRole('button', { name: '删除记录', exact: true }).click()
    await expect(window.getByTestId('sidebar-task')).toHaveCount(0)
    await expect.poll(() => designFiles(userDataDir).length).toBe(0)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
