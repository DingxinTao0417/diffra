import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, test } from '@playwright/test'
import { chooseProject, startTask, taskInput, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

const fence = '```'

const ANSWER = [
  '## 结论',
  '',
  '> [!TIP] 先看图',
  '> 流程和数字都在下面。',
  '',
  `${fence}ts`,
  'export function add(a: number, b: number): number {',
  '  return a + b',
  '}',
  fence,
  '',
  `${fence}mermaid`,
  'flowchart LR',
  '  A[收到请求] --> B{命中缓存} --> C[返回]',
  fence,
  '',
  `${fence}chart`,
  JSON.stringify({ type: 'bar', title: '构建耗时', unit: 's', data: [{ label: '安装', value: 12 }, { label: '构建', value: 30 }] }),
  fence,
  '',
  '$$',
  'E = mc^2',
  '$$',
  '',
  '| 模块 | 体积 |',
  '| --- | ---: |',
  '| app | 120 KB |',
].join('\n')

// 主窗口里 <a download> 的下载：存到指定位置，不弹保存框
async function saveDownloadsTo(app: ElectronApplication, dir: string) {
  await app.evaluate(({ session }, target) => {
    session.defaultSession.on('will-download', (_event, item) => item.setSavePath(`${target}/${item.getFilename()}`))
  }, dir)
}

// 在一个看不见的窗口里打开导出的文件：读背景色和有没有报错，截一张图
async function openExported(app: ElectronApplication, file: string, shot: string) {
  const result = await app.evaluate(async ({ BrowserWindow }, file) => {
    const window = new BrowserWindow({ show: false, width: 900, height: 1400, webPreferences: { offscreen: false } })
    const errors: string[] = []
    window.webContents.on('console-message', (event) => {
      if (event.level === 'error') errors.push(event.message)
    })
    await window.loadFile(file)
    const info = (await window.webContents.executeJavaScript(
      `({ background: getComputedStyle(document.body).backgroundColor, scripts: document.scripts.length, svgs: document.querySelectorAll('svg').length, math: document.querySelectorAll('math').length })`,
    )) as { background: string; scripts: number; svgs: number; math: number }
    const image = (await window.webContents.capturePage()).toPNG().toString('base64')
    window.destroy()
    return { ...info, errors, image }
  }, file)
  const { image, ...info } = result
  writeFileSync(shot, Buffer.from(image, 'base64'))
  return info
}

function savedSnapshot(userDataDir: string): boolean {
  const dir = join(userDataDir, 'sessions')
  return existsSync(dir) && readdirSync(dir, { recursive: true }).some((name) => String(name).endsWith('.json') && readFileSync(join(dir, String(name)), 'utf8').includes('"visualSnapshot"'))
}

// 第 671 步：统一静态渲染——一轮存成单文件 HTML，用对话里同一套组件，带主题、高亮、流程图、图表、公式和可视化快照，不带脚本
test('导出这一轮：单文件 HTML，没有脚本和操作按钮；高亮、流程图、图表、公式、表格、可视化快照都在；跟着应用的深浅色', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-export-'))
  const downloads = mkdtempSync(join(tmpdir(), 'diffra-e2e-export-out-'))
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'show_visual', input: { title: '导出的图', code: '<div style="height:120px;border-radius:12px;background:var(--soft);padding:12px">可视化内容</div>' } }] },
    { text: ANSWER },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '画个图再总结')
    await waitTaskDone(window)
    await expect(window.getByTestId('mermaid-block').locator('svg').first()).toBeVisible()
    // 快照只在可视化整张露在窗口里时截：回答很长，对话滚到底时它已经出去了，滚回来
    await window.getByTestId('visual').scrollIntoViewIfNeeded()
    await window.mouse.move(1, 1)
    await expect.poll(() => savedSnapshot(userDataDir), { timeout: 20_000 }).toBe(true)
    await saveDownloadsTo(app, downloads)

    await window.getByTestId('turn-actions').getByRole('button', { name: '导出这一轮' }).click()
    await window.getByRole('menuitem', { name: 'HTML', exact: true }).click()
    const file = join(downloads, '画个图再总结.html')
    await expect.poll(() => existsSync(file), { timeout: 20_000 }).toBe(true)
    const html = readFileSync(file, 'utf8')
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<title>画个图再总结</title>')
    expect(html).toContain("default-src 'none'")
    expect(html).not.toMatch(/<script|<iframe/i)
    expect(html).not.toContain('turn-actions')
    expect(html).toContain('data-testid="user-message"')
    expect(html).toContain('tok-')
    expect(html).toContain('data-testid="mermaid-block"')
    expect(html).toContain('data-testid="chart-canvas"')
    expect(html).toContain('<math')
    expect(html).toContain('120 KB')
    expect(html).toContain('data-testid="visual-snapshot"')
    expect(html).toMatch(/src="data:image\/webp;base64,/)
    const light = await openExported(app, file, 'test-results/export-turn-light.png')
    expect(light).toMatchObject({ scripts: 0, errors: [] })
    expect(light.svgs).toBeGreaterThan(1)
    expect(light.math).toBe(1)

    // 深色：导出的文件也是深色
    await window.emulateMedia({ colorScheme: 'dark' })
    await expect(window.locator('html')).toHaveClass(/dark/)
    rmSync(file)
    await window.getByTestId('turn-actions').getByRole('button', { name: '导出这一轮' }).click()
    await window.getByRole('menuitem', { name: 'HTML', exact: true }).click()
    await expect.poll(() => existsSync(file), { timeout: 20_000 }).toBe(true)
    expect(readFileSync(file, 'utf8')).toMatch(/<html[^>]* class="[^"]*dark/)
    const dark = await openExported(app, file, 'test-results/export-turn-dark.png')
    expect(dark.errors).toEqual([])
    expect(dark.background).not.toBe(light.background)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(downloads, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

// 第 678 步：导出成 Markdown、PDF、图片，整个任务也能导出
test('导出：一轮存成 Markdown（提问、回答原文、可视化快照）、PDF、整页图片；任务菜单里能导出整个任务', async () => {
  test.setTimeout(120_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-export-formats-'))
  const downloads = mkdtempSync(join(tmpdir(), 'diffra-e2e-export-formats-out-'))
  const model = await startScriptedModel([{ text: ANSWER }, { text: '第二轮的回答：都导出好了。' }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '总结一下')
    await waitTaskDone(window)
    await expect(window.getByTestId('mermaid-block').locator('svg').first()).toBeVisible()
    await saveDownloadsTo(app, downloads)
    // 保存框换成直接存到临时目录
    const saveTo = (file: string) =>
      app.evaluate(({ dialog }, target) => {
        dialog.showSaveDialog = (async () => ({ canceled: false, filePath: target })) as typeof dialog.showSaveDialog
      }, file)
    const exportTurn = async (format: string) => {
      await window.getByTestId('turn-actions').last().getByRole('button', { name: '导出这一轮' }).click()
      await window.getByRole('menuitem', { name: format, exact: true }).click()
    }

    // Markdown：标题、提问引用、回答原文（图表照样是围栏）
    await exportTurn('Markdown')
    const markdownFile = join(downloads, '总结一下.md')
    await expect.poll(() => existsSync(markdownFile), { timeout: 20_000 }).toBe(true)
    const markdown = readFileSync(markdownFile, 'utf8')
    expect(markdown.startsWith('# 总结一下\n\n> 总结一下\n')).toBe(true)
    expect(markdown).toContain('```mermaid')
    expect(markdown).toContain('```chart')
    expect(markdown).toContain('| app | 120 KB |')

    // PDF
    const pdfFile = join(downloads, 'turn.pdf')
    await saveTo(pdfFile)
    await exportTurn('PDF')
    await expect.poll(() => existsSync(pdfFile), { timeout: 30_000 }).toBe(true)
    expect(readFileSync(pdfFile).subarray(0, 5).toString()).toBe('%PDF-')

    // 图片：整页一张，比一屏高
    const pngFile = join(downloads, 'turn.png')
    await saveTo(pngFile)
    await exportTurn('图片（PNG）')
    await expect.poll(() => existsSync(pngFile), { timeout: 30_000 }).toBe(true)
    const png = readFileSync(pngFile)
    copyFileSync(pngFile, 'test-results/export-turn-page.png')
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    expect(png.readUInt32BE(16)).toBe(900)
    // 和同一份 HTML 在 900 宽的窗口里的整页高度一样（不是只截一屏）
    await exportTurn('HTML')
    const turnHtml = join(downloads, '总结一下.html')
    await expect.poll(() => existsSync(turnHtml), { timeout: 20_000 }).toBe(true)
    const pageHeight = await app.evaluate(async ({ BrowserWindow }, file) => {
      const page = new BrowserWindow({ show: false, width: 900, height: 600 })
      await page.loadFile(file)
      const height = (await page.webContents.executeJavaScript('document.documentElement.scrollHeight')) as number
      page.destroy()
      return height
    }, turnHtml)
    expect(pageHeight).toBeGreaterThan(600)
    expect(Math.abs(png.readUInt32BE(20) - pageHeight)).toBeLessThanOrEqual(2)
    rmSync(turnHtml)

    // 整个任务：两轮都在
    await taskInput(window).fill('再来一轮')
    await window.keyboard.press('Control+Enter')
    await expect(window.getByTestId('turn')).toHaveCount(2)
    await waitTaskDone(window)
    await window.getByRole('main').getByRole('button', { name: '任务菜单' }).click()
    await window.getByRole('menuitem', { name: '导出整个任务' }).click()
    await window.getByRole('menuitem', { name: 'HTML', exact: true }).click()
    const taskFile = join(downloads, '总结一下.html')
    await expect.poll(() => existsSync(taskFile), { timeout: 20_000 }).toBe(true)
    const html = readFileSync(taskFile, 'utf8')
    expect(html.match(/data-testid="turn"/g)).toHaveLength(2)
    expect(html).toContain('第二轮的回答')
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(downloads, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

// 第 679 步：分享版——按发给远程设备一样的规则脱敏的单文件 HTML，不上传
test('分享版：一轮做成脱敏的单文件 HTML，密钥和本机路径换掉，开头写明脱敏了什么', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-share-'))
  const downloads = mkdtempSync(join(tmpdir(), 'diffra-e2e-share-out-'))
  // 假密钥在运行时拼出来，仓库里不出现完整的密钥格式
  const secret = ['sk-proj-', 'a'.repeat(40)].join('')
  const file = join(project, 'src', 'app.ts')
  const model = await startScriptedModel([{ text: `配置里的 key 是 ${secret}，入口在 ${file}。` }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '看看配置')
    await waitTaskDone(window)
    await expect(window.getByTestId('agent-message').last()).toContainText(secret)
    await saveDownloadsTo(app, downloads)

    await window.getByTestId('turn-actions').last().getByRole('button', { name: '导出这一轮' }).click()
    await window.getByRole('menuitem', { name: '分享版（脱敏 HTML）' }).click()
    const shared = join(downloads, '看看配置（分享版）.html')
    await expect.poll(() => existsSync(shared), { timeout: 20_000 }).toBe(true)
    const html = readFileSync(shared, 'utf8')
    expect(html).toContain('<title>看看配置（分享版）</title>')
    expect(html).toContain('data-testid="share-banner"')
    expect(html).toContain('[已脱敏：模型服务的 API Key]')
    expect(html).not.toContain(secret)
    expect(html).not.toContain(project)
    expect(html).not.toContain(project.replace(/\\/g, '/'))
    // 项目里的路径换成相对项目的（正文里分隔符照原样）
    expect(html).toMatch(/入口在 src[\\/]app\.ts/)
    expect(html).not.toMatch(/<script/i)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(downloads, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
