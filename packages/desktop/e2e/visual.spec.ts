import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
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
