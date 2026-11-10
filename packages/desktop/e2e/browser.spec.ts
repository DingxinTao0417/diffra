import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, taskInput, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel, openModelsPage, providerCard } from './model-setup'
import { startScriptedModel } from './scripted-model'

// 测试网站：一个表单（填名字、点按钮打招呼）、一条控制台日志、一个去第二页的链接
const PAGES: Record<string, string> = {
  '/': `<!doctype html><html><head><meta charset="utf-8"><title>测试页</title></head><body>
<h1>欢迎</h1>
<label for="name">名字</label><input id="name">
<button id="hello">打招呼</button>
<p id="out"></p>
<a href="/second">第二页</a>
<script>
console.log('页面加载好了')
document.getElementById('hello').onclick = () => {
  document.getElementById('out').textContent = '你好，' + document.getElementById('name').value
  console.error('按钮被点了')
}
</script></body></html>`,
  '/second': `<!doctype html><html><head><meta charset="utf-8"><title>第二页</title></head><body><h1>这是第二页</h1></body></html>`,
  // 故意做坏的页面：手机上横向溢出；文字被裁掉；按钮被透明层盖住；图标链接太小；浅灰字对比度不够；图片没有 alt（图片还是 404）
  '/layout': `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>布局问题</title>
<style>
body { margin: 0; font: 16px sans-serif; background: #fff; color: #111 }
.wide { width: 600px; height: 40px; background: #eef }
.box { width: 200px; height: 40px; overflow: hidden; line-height: 20px }
.pale { color: #bbbbbb }
.wrap { position: relative; height: 60px }
.cover { position: absolute; inset: 0; background: rgba(255, 255, 255, 0.01) }
.icon { display: inline-block; width: 16px; height: 16px; background: #333 }
</style></head><body>
<div class="wide">很宽的横幅</div>
<div class="box">这一段文字很长很长，会超过两行的高度，第三行以后被盒子裁掉看不到了，用户读不全这里的内容</div>
<p class="pale">浅灰色的说明文字</p>
<div class="wrap"><button id="buy">购买</button><div class="cover"></div></div>
<a class="icon" href="/second" aria-label="图标链接"></a>
<img src="/logo.png" width="40" height="40">
</body></html>`,
}

async function startSite(): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const page = PAGES[req.url ?? '/']
    if (!page) return void res.writeHead(404).end()
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }
}

test('内置浏览器：智能体打开本地页面、读页面、输入、点击、看控制台，面板跟着打开；外部网站先问；地址栏能用；能看图的模型可以截图、按指定宽度截图；布局检查报出页面问题', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-browser-'))
  // 有样式文件就算前端项目，系统提示词里加上前端的做法
  writeFileSync(join(project, 'styles.css'), 'body { margin: 0 }\n')
  const site = await startSite()
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'browser_navigate', input: { url: `${site.url}/` } }] },
    { toolCalls: [{ name: 'browser_snapshot', input: {} }] },
    { toolCalls: [{ name: 'browser_type', input: { ref: 'e1', text: '小明' } }] },
    { toolCalls: [{ name: 'browser_click', input: { ref: 'e2' } }] },
    { toolCalls: [{ name: 'browser_snapshot', input: {} }] },
    { toolCalls: [{ name: 'browser_console', input: {} }] },
    { toolCalls: [{ name: 'browser_navigate', input: { url: 'example.com' } }] },
    { text: '页面看完了' },
    // 第二个任务：能看图的模型截图；在做坏的页面上查布局，再按手机宽度截图
    { toolCalls: [{ name: 'browser_navigate', input: { url: `${site.url}/second` } }] },
    { toolCalls: [{ name: 'browser_screenshot', input: {} }] },
    { toolCalls: [{ name: 'browser_navigate', input: { url: `${site.url}/layout` } }] },
    { toolCalls: [{ name: 'browser_check_layout', input: {} }] },
    { toolCalls: [{ name: 'browser_screenshot', input: { width: 375 } }] },
    { text: '截到了' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '看看本地页面')

    // 打开外部网站要确认，这里拒绝
    const permission = window.getByTestId('permission-card')
    await expect(permission).toContainText('在浏览器里打开 example.com', { timeout: 30_000 })
    await permission.getByRole('button', { name: '拒绝' }).click()
    await waitTaskDone(window)

    const bodies = model.bodies()
    // 前端项目、不看图的模型：提示词让它在浏览器里检查，不让它截图
    expect(bodies[0]).toContain('Front-end work (this project has UI code):')
    expect(bodies[0]).toContain('run browser_check_layout')
    expect(bodies[0]).not.toContain('browser_screenshot with width')
    expect(bodies[2]).toContain('textbox \\"名字\\" [ref=e1]')
    expect(bodies[2]).toContain('button \\"打招呼\\" [ref=e2]')
    expect(bodies[2]).toContain('link \\"第二页\\" [ref=e3]')
    expect(bodies[5]).toContain('你好，小明')
    expect(bodies[6]).toContain('[log] 页面加载好了')
    expect(bodies[6]).toContain('[error] 按钮被点了')
    expect(bodies[7]).toContain('did not allow opening example.com')
    // 智能体一用浏览器，面板就打开了，地址栏是它打开的网址
    const panel = window.getByTestId('browser-panel')
    await expect(panel).toBeVisible()
    const address = panel.getByLabel('网址')
    await expect(address).toHaveValue(`${site.url}/`)
    await window.screenshot({ path: 'test-results/browser-panel.png' })

    // 用户自己在地址栏打开第二页；后退回到首页
    await address.fill(`${site.url}/second`)
    await address.press('Enter')
    await expect(address).toHaveValue(`${site.url}/second`)
    await panel.getByRole('button', { name: '后退' }).click()
    await expect(address).toHaveValue(`${site.url}/`)
    // 收起再打开面板，标签页还在
    await window.getByRole('button', { name: '浏览器', exact: true }).click()
    await expect(panel).toBeHidden()
    await window.getByRole('button', { name: '浏览器', exact: true }).click()
    await expect(panel.getByLabel('网址')).toHaveValue(`${site.url}/`)

    // 给模型打开「图片」，新任务里截图：截图作为图片跟在工具结果后面发给模型
    await openModelsPage(window)
    await providerCard(window, '脚本模型').getByRole('button', { name: 'scripted 模型操作', exact: true }).click()
    await window.getByRole('menuitem', { name: '配置能力', exact: true }).click()
    const capabilities = window.getByRole('dialog')
    await capabilities.getByRole('checkbox', { name: '视觉', exact: true }).click()
    await capabilities.getByRole('button', { name: '保存模型能力', exact: true }).click()
    await expect(capabilities).toBeHidden()
    await window.getByRole('button', { name: '返回' }).click()
    await window.getByTestId('sidebar').getByRole('button', { name: '新任务' }).click()
    await taskInput(window).fill('截个图')
    await window.getByRole('button', { name: '发送', exact: true }).click()
    await waitTaskDone(window, 30_000)
    const visionBodies = model.bodies()
    expect(visionBodies[8]).toContain('browser_screenshot with width 1280 and with width 375')
    expect(visionBodies[10]).toContain('data:image/jpeg;base64,')
    expect(visionBodies[10]).toContain('The screenshot is attached in the next message.')

    // 布局检查：手机宽度下横向溢出、点击区域太小；两种宽度都有被裁掉的字和被盖住的按钮；桌面宽度查对比度和 alt
    const report = visionBodies[12] ?? ''
    const reportText = (JSON.parse(report) as { messages: Array<{ role: string; content: unknown }> }).messages.at(-1)?.content
    writeFileSync('test-results/layout-report.txt', String(reportText))
    expect(report).toContain('布局检查：布局问题')
    const [phone = '', desktop = ''] = report.split('桌面 1280×800：')
    expect(phone).toContain('手机 375×812：')
    expect(phone).toContain('横向溢出：页面内容宽 600px')
    expect(phone).toContain('div.wide')
    expect(phone).toContain('（16×16）')
    expect(phone).toContain('div.box')
    expect(phone).toContain('被 div.cover 盖住')
    expect(desktop).not.toContain('横向溢出')
    expect(desktop).toContain('被容器裁掉一部分')
    expect(desktop).toContain('被 div.cover 盖住')
    expect(desktop).toContain('p.pale')
    expect(desktop).toContain('#bbbbbb 在 #ffffff 上')
    expect(desktop).toContain('没有 alt 的图片（1 张）：/logo.png')
    expect(desktop).toContain('条没读过的错误或警告')

    // 按手机宽度截图：图片是 375 宽，截完面板恢复原来的宽度
    expect(visionBodies[13]).toContain('截图 375x812（按 375px 宽的视口渲染）')
    // 请求里带着整段对话的图片，最后一张才是这次截的
    const phoneShot = [...(visionBodies[13] ?? '').matchAll(/data:image\/jpeg;base64,([A-Za-z0-9+/=]+)/g)].at(-1)?.[1]
    expect(phoneShot).toBeTruthy()
    writeFileSync('test-results/browser-phone-375.jpg', Buffer.from(phoneShot ?? '', 'base64'))
    const restored = await app.evaluate(({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0]?.contentView.children.at(-1)
      return view && 'webContents' in view ? (view.webContents as Electron.WebContents).executeJavaScript('window.innerWidth') : null
    })
    expect(restored).not.toBe(375)
    expect(restored).toBeGreaterThan(300)
  } finally {
    await app.close()
    await model.close()
    site.server.closeAllConnections()
    site.server.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('开发服务器：智能体按 package.json 的 dev 脚本在终端里启动（先确认），拿到本地地址后在浏览器里打开；能看输出、能停', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-devserver-'))
  // 先占一个空闲端口再放掉，开发服务器用它，剧本里的模型就知道地址
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'devserver-demo', private: true, scripts: { dev: 'node server.cjs' } }))
  writeFileSync(
    join(project, 'server.cjs'),
    `require('node:http').createServer((req, res) => { console.log('GET ' + req.url); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<title>演示</title><h1>开发服务器的页面</h1>') }).listen(${port}, () => console.log('  Local: http://localhost:${port}/'))`,
  )
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'dev_server_start', input: {} }] },
    { toolCalls: [{ name: 'browser_navigate', input: { url: `http://localhost:${port}/` } }] },
    { toolCalls: [{ name: 'browser_snapshot', input: {} }] },
    { toolCalls: [{ name: 'dev_server_logs', input: {} }] },
    { toolCalls: [{ name: 'dev_server_stop', input: {} }] },
    { text: '预览完了' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '起开发服务器看看')

    const permission = window.getByTestId('permission-card')
    await expect(permission).toContainText('npm run dev', { timeout: 30_000 })
    await permission.getByRole('button', { name: '允许一次' }).click()
    await waitTaskDone(window, 60_000)

    const bodies = model.bodies()
    expect(bodies[1]).toContain(`地址：http://localhost:${port}/`)
    expect(bodies[3]).toContain('开发服务器的页面')
    expect(bodies[4]).toContain('GET /')
    expect(bodies[5]).toContain('已停止：npm run dev')
    // 开发服务器在底部终端的一个标签页里跑，停了以后标签页显示已退出
    await expect(window.getByTestId('terminal-tab')).toHaveCount(1)
    await expect(window.getByTestId('terminal-tab')).toContainText('已退出')
    await window.screenshot({ path: 'test-results/devserver.png' })
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
