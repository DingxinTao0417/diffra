import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, expect, test } from '@playwright/test'
import { chooseProject, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel, openModelCapabilities, openModelsPage } from './model-setup'
import { type ScriptMessages, startScriptedModel } from './scripted-model'

// 电脑操控用真的驱动（Windows 是 SendInput，macOS 是 JXA）：会真的动鼠标键盘，默认不跑，DIFFRA_E2E_REAL_INPUT=1 才跑。
// 只在测试自己开的 Chromium 窗口里操作（主屏幕左上角），跑的时候别碰鼠标键盘。只输入字母和中文，不按回车
const REAL = process.env.DIFFRA_E2E_REAL_INPUT === '1'

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>电脑操控测试</title></head>
<body style="margin:0;font:16px sans-serif;user-select:none">
<textarea id="t" style="position:absolute;left:20px;top:20px;width:280px;height:90px"></textarea>
<div id="d" style="position:absolute;left:340px;top:20px;width:280px;height:90px;background:#ddd">双击这里</div>
<div id="r" style="position:absolute;left:20px;top:140px;width:280px;height:90px;background:#ccf">右键这里</div>
<div id="s" style="position:absolute;left:340px;top:140px;width:280px;height:150px;overflow:auto;background:#cfc"><div style="height:3000px">滚动这里</div></div>
<div id="g" style="position:absolute;left:20px;top:260px;width:70px;height:70px;background:#fc8">拖我</div>
<script>
window.events = []
d.addEventListener('dblclick', () => events.push('dblclick'))
r.addEventListener('contextmenu', (event) => { event.preventDefault(); events.push('contextmenu') })
let start = null
g.addEventListener('mousedown', (event) => { start = event.screenX })
document.addEventListener('mouseup', (event) => { if (start !== null) { events.push('drag ' + (event.screenX - start)); start = null } })
</script></body></html>`

type Point = { x: number; y: number }

// 屏幕上的点（逻辑像素）换成最近一张截图上的像素：工具结果里写着「屏幕 W×H（逻辑像素），截图 w×h」
function toShot(messages: ScriptMessages, point: Point): Point {
  const match = /屏幕 (\d+)×(\d+)（逻辑像素），截图 (\d+)×(\d+)/.exec(JSON.stringify(messages))
  if (!match) throw new Error('还没有截图')
  const [, screenWidth, screenHeight, shotWidth, shotHeight] = match.map(Number)
  return { x: Math.round((point.x * shotWidth!) / screenWidth!), y: Math.round((point.y * shotHeight!) / screenHeight!) }
}

test('电脑操控（真的鼠标键盘）：截屏、单击、输入（含中文）、按组合键、双击、右键、滚动、拖动都落在测试窗口里，操作记录全记下', async () => {
  test.skip(!REAL || (process.platform !== 'win32' && process.platform !== 'darwin'), '会动真的鼠标键盘：DIFFRA_E2E_REAL_INPUT=1 才跑，只支持 Windows 和 macOS')
  test.setTimeout(180_000)
  const userDataDir = makeUserDataDir()
  const workspace = mkdtempSync(join(tmpdir(), 'diffra-e2e-computer-real-'))
  const project = join(workspace, 'project')
  execFileSync('git', ['init', '-q', project])
  writeFileSync(join(project, 'README.md'), '项目')
  const app = await launchApp(userDataDir)
  // Diffra 的窗口挪到右边，不挡测试窗口
  await app.evaluate(({ BrowserWindow, screen }) => {
    const area = screen.getPrimaryDisplay().workArea
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: area.x + Math.max(760, area.width - 1100), y: area.y, width: Math.min(1100, area.width - 760), height: area.height })
  })
  const browser = await chromium.launch({ headless: false, args: ['--window-position=40,40', '--window-size=700,560'] })
  const page = await browser.newPage({ viewport: null })
  await page.setContent(PAGE)
  // 元素中心在屏幕上的位置：窗口位置 + 边框和顶栏 + 元素在页面里的位置
  const layout = await page.evaluate<Record<'text' | 'double' | 'right' | 'scroll' | 'drag', Point>>(`(() => {
    const border = (window.outerWidth - window.innerWidth) / 2
    const left = window.screenX + border
    const top = window.screenY + window.outerHeight - window.innerHeight - border
    const center = (id) => {
      const rect = document.getElementById(id).getBoundingClientRect()
      return { x: left + rect.left + rect.width / 2, y: top + rect.top + rect.height / 2 }
    }
    return { text: center('t'), double: center('d'), right: center('r'), scroll: center('s'), drag: center('g') }
  })()`)
  const act = (action: string, point: Point | null, extra: (messages: ScriptMessages) => Record<string, unknown> = () => ({})) => ({
    toolCalls: [{ name: 'computer', input: (messages: ScriptMessages) => ({ action, ...(point ? toShot(messages, point) : {}), ...extra(messages) }) }],
  })
  const model = await startScriptedModel([
    act('screenshot', null),
    act('click', layout.text),
    act('type', null, () => ({ text: 'hello' })),
    act('key', null, () => ({ keys: 'Ctrl+A' })),
    act('type', null, () => ({ text: 'diffra-ok 中文' })),
    act('double_click', layout.double),
    act('right_click', layout.right),
    act('scroll', layout.scroll, () => ({ direction: 'down', amount: 5 })),
    act('drag', layout.drag, (messages) => {
      const to = toShot(messages, { x: layout.drag.x + 150, y: layout.drag.y })
      return { to_x: to.x, to_y: to.y }
    }),
    act('screenshot', null),
    { text: '都做完了' },
  ])
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await openModelsPage(window)
    const capabilities = await openModelCapabilities(window, '脚本模型', 'scripted')
    await capabilities.getByRole('checkbox', { name: '视觉', exact: true }).click()
    await capabilities.getByRole('button', { name: '保存模型能力', exact: true }).click()
    await expect(capabilities).toBeHidden()
    await window.getByRole('navigation', { name: '设置分区' }).getByRole('button', { name: '浏览器与电脑操控' }).click()
    await window.getByRole('switch', { name: '让智能体操作这台电脑' }).click()
    await window.getByRole('alertdialog').getByRole('button', { name: '我明白了，打开' }).click()
    await window.getByRole('button', { name: '返回' }).click()

    // 完全访问：不弹确认（点确认卡会把焦点抢回 Diffra，输入就落不到测试窗口）
    await chooseProject(app, window, project)
    await window.getByTestId('permission-mode').click()
    await window.getByRole('menuitemradio', { name: /完全访问/ }).click()
    await startTask(window, '在测试窗口里点一点、输入、滚动和拖动')
    await waitTaskDone(window, 120_000)

    expect(await page.inputValue('#t')).toBe('diffra-ok 中文')
    const events = await page.evaluate<string[]>('window.events')
    expect(events).toContain('dblclick')
    expect(events).toContain('contextmenu')
    const drag = events.find((event) => event.startsWith('drag '))
    expect(Math.abs(Number(drag?.slice(5)) - 150)).toBeLessThanOrEqual(6)
    expect(await page.evaluate<number>("document.getElementById('s').scrollTop")).toBeGreaterThan(0)
    // 截图发给了模型；每一步都记进了操作记录
    expect(model.bodies().some((body) => body.includes('逻辑像素') && body.includes('image'))).toBe(true)
    const audit = readFileSync(join(userDataDir, 'computer-audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { ok: boolean })
    expect(audit).toHaveLength(10)
    expect(audit.every((entry) => entry.ok)).toBe(true)
    await page.screenshot({ path: 'test-results/computer-real-target.png' })
  } finally {
    await browser.close()
    await app.close()
    await model.close()
    rmSync(workspace, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
