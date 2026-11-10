// 官网用的产品截图、分享卡片和图标：pnpm --filter @diffra/desktop website:shots
// 用演示项目和脚本模型在开发版里摆出场景，浅色、深色各截一套，放到 website/public/assets/。
// 全是演示数据：临时数据目录、临时项目，不碰开发和正式安装的数据。先 pnpm build 再跑
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { _electron as electron, chromium, type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { chooseProject, startDesignTask, startTask, waitTaskDone } from '../../e2e/flows'
import { APP_VERSION, desktopDir } from '../../e2e/launch'
import { configureCoderModel } from '../../e2e/model-setup'
import { startScriptedModel } from '../../e2e/scripted-model'

const ASSETS = resolve(desktopDir, '../../website/public/assets')
const SHOTS = join(ASSETS, 'shots')
const WINDOW = { width: 1440, height: 900 }

// ---- 演示项目：一个小的待办网页 ----
const TODOS_JS = `// 待办的数据和筛选
export function createTodo(title) {
  return { id: crypto.randomUUID(), title, done: false }
}

export function visibleTodos(todos, filter) {
  if (filter === 'active') return todos.filter((todo) => !todo.done)
  if (filter === 'done') return todos.filter((todo) => todo.done)
  return todos
}
`
const CREATE_TODO = `export function createTodo(title) {
  return { id: crypto.randomUUID(), title, done: false }
}`
const CREATE_TODO_WITH_PRIORITY = `export const PRIORITIES = ['high', 'normal', 'low']

export function createTodo(title, priority = 'normal') {
  return { id: crypto.randomUUID(), title, done: false, priority }
}

// 高 > 中 > 低；同一优先级保持原来的顺序
export function sortByPriority(todos) {
  return [...todos].sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority))
}`
const APP_JS = `import { createTodo, visibleTodos } from './todos.js'

const todos = [
  createTodo('写周报'),
  createTodo('修复登录页的样式'),
  createTodo('准备评审材料'),
  createTodo('回复客户邮件'),
]
todos[3].done = true

const list = document.querySelector('#list')
function render(filter = 'all') {
  list.replaceChildren(...visibleTodos(todos, filter).map((todo) => {
    const item = document.createElement('li')
    item.className = todo.done ? 'done' : ''
    item.textContent = todo.title
    return item
  }))
}
render()
`
const APP_JS_WITH_PRIORITY = `import { createTodo, sortByPriority, visibleTodos } from './todos.js'

const LABELS = { high: '高', normal: '中', low: '低' }

const todos = [
  createTodo('写周报', 'low'),
  createTodo('修复登录页的样式', 'high'),
  createTodo('准备评审材料', 'normal'),
  createTodo('回复客户邮件', 'high'),
]
todos[3].done = true

const list = document.querySelector('#list')
function render(filter = 'all') {
  const items = sortByPriority(visibleTodos(todos, filter)).map((todo) => {
    const item = document.createElement('li')
    item.className = todo.done ? 'done' : ''
    const badge = document.createElement('span')
    badge.className = \`badge \${todo.priority}\`
    badge.textContent = LABELS[todo.priority]
    item.append(badge, todo.title)
    return item
  })
  list.replaceChildren(...items)
}
render()
`
const PRIORITY_TEST = `import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTodo, sortByPriority } from '../src/todos.js'

test('按优先级排序：高 > 中 > 低，同级保持原来的顺序', () => {
  const todos = [createTodo('a', 'low'), createTodo('b', 'high'), createTodo('c'), createTodo('d', 'high')]
  assert.deepEqual(sortByPriority(todos).map((todo) => todo.title), ['b', 'd', 'c', 'a'])
})
`
const INDEX_HTML = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>我的待办</title><link rel="stylesheet" href="styles.css"></head>
<body>
<main>
  <h1>我的待办</h1>
  <nav><button class="on">全部</button><button>进行中</button><button>已完成</button></nav>
  <ul id="list"></ul>
</main>
<script type="module" src="src/app.js"></script>
</body>
</html>
`
const STYLES_CSS = `body { margin: 0; background: #f6f7f9; font-family: "Segoe UI", "Microsoft YaHei UI", sans-serif; color: #1f2328; }
main { max-width: 520px; margin: 64px auto; padding: 32px; background: #fff; border-radius: 16px; box-shadow: 0 10px 40px rgba(0,0,0,.08); }
h1 { margin: 0 0 20px; font-size: 26px; }
nav { display: flex; gap: 8px; margin-bottom: 16px; }
nav button { padding: 6px 14px; border: 1px solid #d0d7de; border-radius: 999px; background: #fff; font: inherit; font-size: 14px; }
nav button.on { background: #1f2328; color: #fff; border-color: #1f2328; }
ul { margin: 0; padding: 0; list-style: none; }
li { display: flex; align-items: center; gap: 12px; padding: 14px 4px; border-top: 1px solid #eaeef2; font-size: 16px; }
li.done { color: #8c959f; text-decoration: line-through; }
.badge { padding: 2px 10px; border-radius: 6px; font-size: 13px; font-weight: 600; text-decoration: none; }
.badge.high { background: #ffebe9; color: #cf222e; }
.badge.normal { background: #fff8c5; color: #9a6700; }
.badge.low { background: #ddf4ff; color: #0969da; }
`

function writeDemoProject(root: string): string {
  const project = join(root, 'todo-app')
  mkdirSync(join(project, 'src'), { recursive: true })
  mkdirSync(join(project, 'test'), { recursive: true })
  writeFileSync(join(project, 'package.json'), `${JSON.stringify({ name: 'todo-app', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`)
  writeFileSync(join(project, 'README.md'), '# todo-app\n\n一个小的待办网页。\n')
  writeFileSync(join(project, 'index.html'), INDEX_HTML)
  writeFileSync(join(project, 'styles.css'), STYLES_CSS)
  writeFileSync(join(project, 'src', 'todos.js'), TODOS_JS)
  writeFileSync(join(project, 'src', 'app.js'), APP_JS)
  writeFileSync(
    join(project, 'test', 'todos.test.js'),
    `import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTodo, visibleTodos } from '../src/todos.js'

test('按状态筛选', () => {
  const todos = [createTodo('a'), createTodo('b')]
  todos[1].done = true
  assert.deepEqual(visibleTodos(todos, 'active').map((todo) => todo.title), ['a'])
  assert.deepEqual(visibleTodos(todos, 'done').map((todo) => todo.title), ['b'])
})
`,
  )
  return project
}

// 演示页面：浏览器场景里智能体打开它
async function serveProject(project: string): Promise<{ server: Server; url: string }> {
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }
  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] === '/' ? '/index.html' : (request.url ?? '/').split('?')[0]!
    try {
      const body = readFileSync(join(project, path))
      response.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' }).end(body)
    } catch {
      response.writeHead(404).end()
    }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` }
}

// ---- 截图：主界面加上叠在上面的原生视图（内置浏览器、设计画布），拼成一张 2 倍图存成 WebP ----
async function capture(app: ElectronApplication, window: Page, name: string): Promise<void> {
  await window.waitForTimeout(600)
  const parts = await app.evaluate(async ({ BrowserWindow, WebContentsView }) => {
    const win = BrowserWindow.getAllWindows()[0]!
    const [width, height] = win.getContentSize()
    const main = (await win.webContents.capturePage()).toDataURL()
    const views: Array<{ x: number; y: number; width: number; height: number; data: string }> = []
    for (const view of win.contentView.children) {
      if (!(view instanceof WebContentsView) || view.webContents === win.webContents) continue
      const bounds = view.getBounds()
      if (!view.getVisible() || bounds.width === 0 || bounds.height === 0) continue
      views.push({ ...bounds, data: (await view.webContents.capturePage()).toDataURL() })
    }
    return { width, height, main, views }
  })
  // 在应用的页面里用 canvas 拼图（脚本的 tsconfig 没有 DOM 类型，写成字符串）
  const data = await window.evaluate<string>(`(async (input) => {
    const load = (src) => new Promise((done, fail) => { const image = new Image(); image.onload = () => done(image); image.onerror = fail; image.src = src })
    const main = await load(input.main)
    const scale = main.naturalWidth / input.width
    const canvas = document.createElement('canvas')
    canvas.width = main.naturalWidth
    canvas.height = main.naturalHeight
    const context = canvas.getContext('2d')
    context.drawImage(main, 0, 0)
    for (const view of input.views) context.drawImage(await load(view.data), view.x * scale, view.y * scale, view.width * scale, view.height * scale)
    return canvas.toDataURL('image/webp', 0.9)
  })(${JSON.stringify(parts)})`)
  writeFileSync(join(SHOTS, `${name}.webp`), Buffer.from(data.split(',')[1]!, 'base64'))
}

async function launch(userDataDir: string): Promise<ElectronApplication> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  const app = await electron.launch({
    args: ['.', '--force-device-scale-factor=2'],
    cwd: desktopDir,
    env: { ...env, DIFFRA_USER_DATA_DIR: userDataDir, DIFFRA_BROWSER_HOST_TARGETS: 'none' },
  })
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height), WINDOW)
  return app
}

const DESIGN_JSX = `<Frame name="待办 · 手机" w={360} h="hug" flex="col" gap={16} p={24} bg="#FFFFFF" rounded={20}>
  <Frame name="顶栏" w="fill" h="hug" flex="row" justify="between" items="center">
    <Text name="标题" size={24} weight="bold" color="#111827">今天</Text>
    <Icon name="lucide:bell" size={22} color="#2E6B57" />
  </Frame>
  <Text name="副标题" size={14} color="#6B7280">还有 3 件事要做</Text>
  <Frame name="待办 1" w="fill" h="hug" flex="row" gap={12} p={14} items="center" bg="#F4F7F5" rounded={12}>
    <Icon name="lucide:circle" size={20} color="#2E6B57" />
    <Text name="内容" size={15} color="#111827">修复登录页的样式</Text>
  </Frame>
  <Frame name="待办 2" w="fill" h="hug" flex="row" gap={12} p={14} items="center" bg="#F4F7F5" rounded={12}>
    <Icon name="lucide:circle" size={20} color="#2E6B57" />
    <Text name="内容" size={15} color="#111827">回复客户邮件</Text>
  </Frame>
  <Frame name="待办 3" w="fill" h="hug" flex="row" gap={12} p={14} items="center" bg="#F4F7F5" rounded={12}>
    <Icon name="lucide:circle-check" size={20} color="#9CA3AF" />
    <Text name="内容" size={15} color="#9CA3AF">准备评审材料</Text>
  </Frame>
  <Frame name="按钮" w="fill" h={48} flex="row" justify="center" items="center" bg="#2E6B57" rounded={12}>
    <Text name="按钮文字" size={16} weight="bold" color="#FFFFFF">新建待办</Text>
  </Frame>
</Frame>`

for (const theme of ['light', 'dark'] as const) {
  test(`官网截图（${theme === 'light' ? '浅色' : '深色'}）`, async () => {
    test.setTimeout(300_000)
    mkdirSync(SHOTS, { recursive: true })
    const root = mkdtempSync(join(tmpdir(), 'diffra-shots-'))
    const userDataDir = join(root, 'data')
    mkdirSync(userDataDir)
    const project = writeDemoProject(root)
    const site = await serveProject(project)
    writeFileSync(
      join(userDataDir, 'settings.json'),
      JSON.stringify({
        version: 1,
        providers: [],
        roles: { coder: null, planner: null, reviewer: null, fallback: null },
        appearance: { theme, palette: 'forest', fontSize: 'md', contentWidth: 'standard' },
        lastSeenVersion: APP_VERSION,
      }),
    )
    const model = await startScriptedModel([
      { match: '补一段安装说明', toolCalls: [{ name: 'edit_file', input: { path: 'README.md', old_string: '一个小的待办网页。\n', new_string: '一个小的待办网页。\n\n## 运行\n\n```\nnpm test\n```\n' } }] },
      { match: '补一段安装说明', toolCalls: [{ name: 'finish', input: { summary: 'README 里加了「运行」一节。' } }] },
      { match: '解释一下', text: '`todos.js` 只管数据：`createTodo` 建一条待办，`visibleTodos` 按「全部 / 进行中 / 已完成」筛选。`app.js` 负责把筛选结果画到页面上。' },
      { match: '给待办加上优先级', text: '先看一下项目结构。', toolCalls: [{ name: 'list_files', input: { path: '.' } }] },
      { match: '给待办加上优先级', toolCalls: [{ name: 'read_file', input: { path: 'src/todos.js' } }] },
      { match: '给待办加上优先级', toolCalls: [{ name: 'read_file', input: { path: 'src/app.js' } }] },
      {
        match: '给待办加上优先级',
        text: '计划：\n\n1. 先写测试，定下规则：**高 > 中 > 低**，同级保持原来的顺序\n2. 在 `todos.js` 里加 `priority` 字段和 `sortByPriority`\n3. 列表按优先级排序，每条前面显示优先级标签',
        toolCalls: [{ name: 'edit_file', input: { path: 'test/priority.test.js', old_string: '', new_string: PRIORITY_TEST } }],
      },
      { match: '给待办加上优先级', text: '测试没过：`sortByPriority` 还没写，符合预期。现在实现它。', toolCalls: [{ name: 'edit_file', input: { path: 'src/todos.js', old_string: CREATE_TODO, new_string: CREATE_TODO_WITH_PRIORITY } }] },
      { match: '给待办加上优先级', text: '测试通过了。最后让列表按优先级显示。', toolCalls: [{ name: 'edit_file', input: { path: 'src/app.js', old_string: APP_JS, new_string: APP_JS_WITH_PRIORITY } }] },
      {
        match: '给待办加上优先级',
        toolCalls: [
          {
            name: 'finish',
            input: {
              summary:
                '待办现在有优先级了：\n\n- `createTodo` 多了 `priority` 参数，默认是「中」\n- 新增 `sortByPriority`：高 > 中 > 低，同级保持原来的顺序\n- 列表按优先级排序，每条前面有优先级标签\n\n新加的测试和原有测试都通过了。',
            },
          },
        ],
      },
      { match: '在浏览器里看看', text: '打开本地页面看一下。', toolCalls: [{ name: 'browser_navigate', input: { url: site.url } }] },
      { match: '在浏览器里看看', toolCalls: [{ name: 'browser_snapshot', input: {} }] },
      { match: '在浏览器里看看', text: '页面正常：四条待办按优先级排好，「修复登录页的样式」和「回复客户邮件」在最前面，已完成的那条是灰色划线。' },
      { match: '设计一个', toolCalls: [{ name: 'design_render', input: { jsx: DESIGN_JSX } }] },
      { match: '设计一个', text: '画好了：手机上的「今天」待办页，顶部标题和提醒，三条待办，底部是新建按钮。' },
    ])
    const app = await launch(userDataDir)
    try {
      const window = await app.firstWindow()
      await configureCoderModel(window, { name: 'DeepSeek', baseUrl: model.baseUrl, apiKey: 'demo-key-123456', modelId: 'deepseek-chat' })
      await chooseProject(app, window, project)
      await window.evaluate(`window.diffra.saveProject(${JSON.stringify(project)}, { checks: { afterEdit: 'node --test', beforeFinish: null }, readOnlyPaths: [] })`)
      const newTask = () => window.getByTestId('sidebar').getByRole('button', { name: '新任务', exact: true }).click()

      // 侧栏里先有两个别的任务
      await startTask(window, '给 README 补一段安装说明')
      await waitTaskDone(window, 60_000)
      await newTask()
      await startTask(window, '解释一下 todos.js 的结构')
      await waitTaskDone(window, 60_000)

      // 主场景：先写测试（检查不过）再实现
      await newTask()
      await startTask(window, '给待办加上优先级，列表按优先级排序')
      await waitTaskDone(window, 90_000)
      await capture(app, window, `hero-${theme}`)

      await window.getByRole('button', { name: '展开代码详情', exact: true }).first().click()
      // 没通过的那次检查放在画面上方，接着的修复跟在下面（对话的滚动容器在每一轮外面两层）
      await window.evaluate(`(() => {
        const scroller = document.querySelector('[data-testid="turn"]').parentElement.parentElement
        const check = document.querySelector('[data-testid="tool-call"][data-kind="check"]')
        scroller.scrollTop += check.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 140
      })()`)
      await capture(app, window, `checks-${theme}`)

      await window.locator('header').getByRole('button', { name: '审阅改动', exact: true }).click()
      await expect(window.getByTestId('review-file').first()).toBeVisible()
      await window.getByTestId('review-file').filter({ hasText: 'todos.js' }).first().click()
      await capture(app, window, `review-${theme}`)
      await window.getByRole('button', { name: '任务监控' }).click()

      // 浏览器
      await newTask()
      await startTask(window, '在浏览器里看看页面效果')
      await waitTaskDone(window, 60_000)
      await expect(window.getByTestId('browser-panel')).toBeVisible()
      await capture(app, window, `browser-${theme}`)

      // 设计
      await startDesignTask(window, '设计一个手机上的待办首页')
      await expect(window.getByTestId('design-panel')).toBeVisible()
      await waitTaskDone(window, 60_000)
      await window.waitForTimeout(1500)
      await capture(app, window, `design-${theme}`)
    } finally {
      await app.close()
      await model.close()
      site.server.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
}

// 分享卡片（1200×630）和图标：用 Chromium 把 HTML、SVG 渲染成 PNG
test('分享卡片和图标', async () => {
  mkdirSync(ASSETS, { recursive: true })
  const publicDir = resolve(ASSETS, '..')
  const icon = readFileSync(join(desktopDir, 'build', 'brand', 'icon.svg'), 'utf8')
  copyFileSync(join(desktopDir, 'build', 'brand', 'icon.svg'), join(publicDir, 'favicon.svg'))
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 })
    for (const [file, size, padding, background] of [
      ['favicon-32.png', 32, 0, 'transparent'],
      ['apple-touch-icon.png', 180, 28, '#ffffff'],
    ] as const) {
      await page.setViewportSize({ width: size, height: size })
      await page.setContent(`<body style="margin:0;background:${background}"><div style="width:${size}px;height:${size}px;padding:${padding}px;box-sizing:border-box">${icon.replace('<svg ', '<svg width="100%" height="100%" ')}</div></body>`)
      await page.screenshot({ path: join(publicDir, file), omitBackground: background === 'transparent' })
    }
    await page.setViewportSize({ width: 1200, height: 630 })
    await page.setContent(`<!doctype html><html><body style="margin:0">
<div style="width:1200px;height:630px;box-sizing:border-box;padding:80px 88px;display:flex;flex-direction:column;justify-content:space-between;
  background:radial-gradient(70% 90% at 85% 0%, rgba(63,216,200,.22), transparent 60%), radial-gradient(60% 80% at 0% 100%, rgba(34,173,122,.18), transparent 60%), #0f1412;
  color:#ecece8;font-family:'Segoe UI','Microsoft YaHei UI',sans-serif">
  <div style="display:flex;align-items:center;gap:16px;font-size:34px;font-weight:650">
    <div style="width:56px;height:56px">${icon.replace('<svg ', '<svg width="100%" height="100%" ')}</div>Diffra
  </div>
  <div>
    <div style="font-size:64px;font-weight:700;line-height:1.2;letter-spacing:-1px">描述任务，<br>Diffra 在你的项目里把它做完</div>
    <div style="margin-top:24px;font-size:28px;color:#a3a29c">Windows 上的编程智能体 · 改完先过检查 · 每一轮都能撤销</div>
  </div>
</div></body></html>`)
    await page.screenshot({ path: join(ASSETS, 'og.png') })
  } finally {
    await browser.close()
  }
})
