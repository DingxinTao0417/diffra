import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { captureClipboard, lastCopied } from './clipboard'
import { chooseProject, startTask, taskInput, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

// e2e 按 Node 的类型检查，页面里用到的那点 DOM 自己写
type PageStyle = { getComputedStyle(element: unknown): { color: string } }

// 1x1 的 PNG
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

test('对话里的可视化：脚本能跑、能从网上加载脚本和图片、跟着应用主题；碰不到主界面；按钮能填输入框，链接要先确认', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-visual-'))
  // 本地服务模拟 CDN：一个脚本库和一张图片
  const cdn = createServer((request, response) => {
    if (request.url === '/lib.js') return void response.writeHead(200, { 'content-type': 'text/javascript' }).end('window.fromCdn = "库加载了"')
    if (request.url === '/pixel.png') return void response.writeHead(200, { 'content-type': 'image/png' }).end(PIXEL)
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => cdn.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(cdn.address() as AddressInfo).port}`
  const code = [
    '<div id="ran"></div><div id="lib"></div><div id="parent"></div><div id="bridge"></div>',
    '<p id="themed" style="color: var(--fg)">主题文字</p>',
    `<img id="pic" src="${base}/pixel.png" width="1" height="1">`,
    '<button id="pick" onclick="diffra.fill(\'选 A\')">选 A</button>',
    '<a id="link" href="https://example.com/docs">文档</a>',
    `<script src="${base}/lib.js"></script>`,
    '<script>',
    "document.getElementById('ran').textContent = '脚本跑了'",
    "document.getElementById('lib').textContent = window.fromCdn || '没加载'",
    "try { document.getElementById('parent').textContent = parent.document.title } catch (e) { document.getElementById('parent').textContent = '访问不到主界面' }",
    "document.getElementById('bridge').textContent = typeof window.diffra.fill === 'function' && !('listTodos' in window.diffra) ? '只有填入' : '多了接口'",
    '</script>',
  ].join('\n')
  const model = await startScriptedModel([{ toolCalls: [{ name: 'show_visual', input: { title: '方案对比', code } }] }, { text: '上面是对比图' }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '画个对比图')
    await waitTaskDone(window)
    // 工具说明给了模型
    expect(model.bodies()[0]).toContain('"name":"show_visual"')

    const card = window.getByTestId('visual')
    await expect(card).toContainText('方案对比')
    const frame = window.frameLocator('[data-testid="visual"] iframe')
    await expect(frame.locator('#ran')).toHaveText('脚本跑了')
    await expect(frame.locator('#lib')).toHaveText('库加载了')
    await expect(frame.locator('#parent')).toHaveText('访问不到主界面')
    await expect(frame.locator('#bridge')).toHaveText('只有填入')
    await expect.poll(() => frame.locator('#pic').evaluate((image) => (image as unknown as { naturalWidth: number }).naturalWidth)).toBe(1)
    // 颜色是应用的前景色
    const appColor = await window.evaluate('getComputedStyle(document.body).color')
    await expect.poll(() => frame.locator('#themed').evaluate((element) => (globalThis as unknown as PageStyle).getComputedStyle(element).color)).toBe(appColor)
    // 高度跟着内容，不是默认的 120
    await expect.poll(async () => (await card.locator('iframe').boundingBox())?.height ?? 0).toBeGreaterThan(150)

    // 按钮把文字填进输入框，不发送
    await frame.locator('#pick').click()
    await expect(taskInput(window)).toHaveValue('选 A')
    expect(model.requests()).toBe(2)
    // 链接不在框里打开，先问
    await frame.locator('#link').click()
    await expect(window.getByTestId('visual-link')).toContainText('https://example.com/docs')
    await window.getByTestId('visual-link').getByRole('button', { name: '不打开' }).click()
    await expect(window.getByTestId('visual-link')).toHaveCount(0)
    await expect(frame.locator('#ran')).toHaveText('脚本跑了')

    // 放大、看代码
    await card.getByRole('button', { name: '放大' }).click()
    await expect(card).toHaveAttribute('data-expanded', 'true')
    await window.keyboard.press('Escape')
    await expect(card).toHaveAttribute('data-expanded', 'false')
    await card.getByRole('button', { name: '看代码' }).click()
    await expect(card.locator('pre')).toContainText('diffra.fill')
  } finally {
    await app.close()
    await model.close()
    await new Promise<void>((resolve) => cdn.close(() => resolve()))
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

// 第 666–667 步：可视化的工具箱（diffra.chart、diffra.ui、打开文件、复制）和预设（模型只给数据）
test('可视化的预设和工具箱：对比和流程图按模板画，图表和指标卡跟着主题；能打开项目里的文件、复制；预设数据不对时模型拿到原因', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-visual-kit-'))
  mkdirSync(join(project, 'src'))
  writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 1\nexport const target = 2\n')
  const kitCode = [
    '<div id="c"></div>',
    "<button id=\"open\" onclick=\"diffra.openFile('src/a.ts', 2)\">打开</button>",
    "<button id=\"copy\" onclick=\"diffra.copy('复制的字')\">复制</button>",
    '<script>',
    "diffra.chart('bar', [{ label: '安装', value: 3 }, { label: '构建', value: 5 }], { title: '耗时', unit: 's', into: '#c' })",
    "document.body.append(diffra.ui.stat({ label: '用例', value: 120, delta: -3, better: 'up' }))",
    '</script>',
  ].join('\n')
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'show_visual', input: { title: '方案对比', preset: 'compare', data: { options: [{ name: '方案 A', pros: ['改动小'] }, { name: '方案 B', summary: '重写缓存', recommended: true }] } } }] },
    { toolCalls: [{ name: 'show_visual', input: { title: '构建指标', code: kitCode } }] },
    { toolCalls: [{ name: 'show_visual', input: { title: '发布流程', preset: 'flow', data: { nodes: [{ id: 'a', label: '开始', kind: 'start' }, { id: 'b', label: '判断', kind: 'decision' }, { id: 'c', label: '结束', kind: 'end' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c', label: '是' }] } } }] },
    { toolCalls: [{ name: 'show_visual', input: { title: '坏的', preset: 'chart', data: { type: 'donut3', data: [] } } }] },
    { text: '画完了' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await captureClipboard(window)
    await startTask(window, '画几个图')
    await waitTaskDone(window)
    const visuals = window.getByTestId('visual')
    await expect(visuals).toHaveCount(3)

    // 对比预设：两个方案，推荐的有标记；「选这个」填进输入框
    const compare = visuals.nth(0).locator('iframe').contentFrame()
    await expect(compare.locator('.dk-option')).toHaveCount(2)
    await expect(compare.locator('.dk-option').nth(1)).toContainText('推荐')
    await compare.locator('.dk-option').nth(1).getByRole('button', { name: '选这个' }).click()
    await expect(taskInput(window)).toHaveValue('选「方案 B」')
    await taskInput(window).fill('')

    // 工具箱：两根柱子、变差的指标标出来；打开项目里的文件到那一行；复制
    const kit = visuals.nth(1).locator('iframe').contentFrame()
    await expect(kit.locator('.dk-chart svg rect')).toHaveCount(2)
    await expect(kit.locator('.dk-chart-title')).toHaveText('耗时')
    await expect(kit.locator('.dk-stat')).toContainText('120')
    await expect(kit.locator('.dk-stat-delta')).toHaveClass(/dk-worse/)
    // 先复制再打开文件：打开、关上侧栏会让可视化重新排版，紧接着点里面的按钮可能点偏
    await kit.locator('#copy').click()
    await expect.poll(() => lastCopied(window)).toBe('复制的字')
    await kit.locator('#open').click()
    await expect(window.getByTestId('file-panel').locator('.cm-target-line')).toHaveText('export const target = 2')
    await window.getByRole('button', { name: '关闭面板' }).click()

    // 流程图预设：三个节点
    const flow = visuals.nth(2).locator('iframe').contentFrame()
    await expect(flow.locator('.dk-flow svg text').filter({ hasText: '判断' })).toHaveCount(1)
    // 预设数据不对：没画出来，模型拿到哪个字段不对
    // （AI SDK 按同一份 schema 先校验，按预设查的数据也在里面：写明是 data.type、能选哪些）
    const lastTool = (JSON.parse(model.bodies().at(-1)!) as { messages: Array<{ role: string; content: unknown }> }).messages.filter((message) => message.role === 'tool').at(-1)
    expect(String(lastTool?.content)).toContain('Invalid input for tool show_visual')
    expect(String(lastTool?.content)).toMatch(/"data",\s*"type"/)
    expect(String(lastTool?.content)).toMatch(/expected one of .*bar.*donut.*scatter/)

    for (const scheme of ['light', 'dark'] as const) {
      await window.emulateMedia({ colorScheme: scheme })
      for (const [index, name] of ['compare', 'kit', 'flow'].entries()) {
        // 刚滚进视口的沙箱 iframe 要等它画一帧，不然截到空白（只影响截图，内容上面已经断言过）
        await visuals.nth(index).scrollIntoViewIfNeeded()
        await window.waitForTimeout(300)
        await visuals.nth(index).screenshot({ path: `test-results/visual-${name}-${scheme}.png` })
      }
    }
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

// 第 668–669 步：同名可视化的版本切换和对比、从某一版接着改、固定到白板、演示模式逐步出现
test('可视化的版本、白板和演示：同名的能切版本、和上一版对比、从旧版接着改；固定到白板并排看；演示时一步步出现', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-visual-versions-'))
  const second = ['<div id="v">第二版</div>', '<p data-step="1">第一步</p>', '<p data-step="2">第二步</p>', '<p data-step="3">第三步</p>'].join('\n')
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'show_visual', input: { title: '首页布局', code: '<div id="v">第一版</div>' } }] },
    { toolCalls: [{ name: 'show_visual', input: { title: '首页布局', code: second } }] },
    { text: '改了一版' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '画两版布局')
    await waitTaskDone(window)
    const card = window.getByTestId('visual').nth(1)
    const frame = (index = 0) => card.getByTestId('visual-frames').locator('iframe').nth(index).contentFrame()

    // 第二张卡片是第 2/2 版；切到上一版看第一版，再切回来
    await expect(card.getByTestId('visual-versions')).toContainText('第 2/2 版')
    await expect(frame().locator('#v')).toHaveText('第二版')
    await card.getByRole('button', { name: '上一版', exact: true }).click()
    await expect(card).toHaveAttribute('data-version', '1')
    await expect(frame().locator('#v')).toHaveText('第一版')
    // 在旧版上「从这一版接着改」：填进输入框
    await card.getByRole('button', { name: '从这一版接着改' }).click()
    await expect(taskInput(window)).toHaveValue('回到可视化「首页布局」的第 1 版，在它的基础上接着改：')
    await taskInput(window).fill('')
    await card.getByRole('button', { name: '下一版', exact: true }).click()
    // 和上一版并排对比
    await card.getByRole('button', { name: '和上一版对比' }).click()
    await expect(card.getByTestId('visual-frames').locator('iframe')).toHaveCount(2)
    await expect(frame(0).locator('#v')).toHaveText('第一版')
    await expect(frame(1).locator('#v')).toHaveText('第二版')
    await card.getByRole('button', { name: '不对比' }).click()

    // 固定到白板：右侧栏打开，里面是这一版；取下后白板空了
    await card.getByRole('button', { name: '固定到白板' }).click()
    const board = window.getByTestId('visuals-panel')
    await expect(board.getByTestId('pinned-visual')).toHaveCount(1)
    await expect(board.getByTestId('pinned-visual').locator('iframe').contentFrame().locator('#v')).toHaveText('第二版')
    await board.screenshot({ path: 'test-results/visual-board.png' })
    await board.getByRole('button', { name: '从白板取下' }).click()
    await expect(board).toContainText('还没有固定的可视化')
    await window.getByRole('button', { name: '关闭面板' }).click()

    // 演示：铺满窗口，第一步之后的先藏着；→ 一步步出现，Esc 结束
    await card.getByRole('button', { name: '演示' }).click()
    const presentation = window.getByTestId('visual-presentation')
    const stage = presentation.locator('iframe').contentFrame()
    await expect(presentation.getByTestId('visual-presentation-step')).toHaveText('1/3')
    await expect(stage.locator('[data-step="2"]')).toHaveClass(/dk-hidden/)
    await window.keyboard.press('ArrowRight')
    await expect(presentation.getByTestId('visual-presentation-step')).toHaveText('2/3')
    await expect(stage.locator('[data-step="2"]')).not.toHaveClass(/dk-hidden/)
    await expect(stage.locator('[data-step="3"]')).toHaveClass(/dk-hidden/)
    await window.keyboard.press('Escape')
    await expect(presentation).toHaveCount(0)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
