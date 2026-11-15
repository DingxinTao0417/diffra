import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test'
import { RICH_BLOCK_KINDS } from '../../core/src/rich/blocks.ts'
import { RICH_SAMPLES, sampleSource } from '../../core/test/fixtures/rich-samples.ts'
import { chooseProject, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

const fence = '```'
const valid = RICH_BLOCK_KINDS.flatMap((kind) => [`### ${kind}`, '', `${fence}${kind}`, sampleSource(kind), fence, ''])
const invalid = RICH_BLOCK_KINDS.flatMap((kind) => {
  const source = RICH_SAMPLES[kind].invalid
  return source === null ? [] : [`${fence}${kind}`, source, fence, '']
})
const ANSWER = [...valid, '下面这些数据不对：', '', ...invalid].join('\n')
// 图表的 data-kind 带上图的类型（chart-bar）；短的 JSON 先按代码显示，带「树形查看」开关
const blockOf = (kind: string) => (kind === 'chart' ? '[data-kind^="chart-"]' : kind === 'json' ? '[data-kind="json"], [data-kind="code"]:has([aria-label="树形查看"])' : `[data-kind="${kind}"]`)

async function setWidth(app: ElectronApplication, window: Page, width: number) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size, 900), width)
  await expect.poll(() => window.evaluate(() => (globalThis as unknown as { innerWidth: number }).innerWidth)).toBeLessThanOrEqual(width)
}

// 回答这一栏没有横向滚动，每个块都在栏里
async function expectNoOverflow(answer: Locator) {
  type Box = { scrollWidth: number; clientWidth: number; getBoundingClientRect(): { right: number; width: number }; getAttribute(name: string): string | null }
  await expect
    .poll(() =>
      answer.evaluate((root) => {
        const markdown = root.querySelector('.markdown') as unknown as Box
        const { right } = markdown.getBoundingClientRect()
        const outside = ([...root.querySelectorAll('figure')] as unknown as Box[]).filter((item) => item.getBoundingClientRect().right > right + 1).map((item) => item.getAttribute('data-kind'))
        return { scroll: markdown.scrollWidth - markdown.clientWidth, outside }
      }),
    )
    .toEqual({ scroll: 0, outside: [] })
}

// 导出的单文件 HTML 在这么宽的窗口里打开：页面没有横向滚动（手机上看分享版）
async function exportOverflow(app: ElectronApplication, file: string, width: number) {
  return app.evaluate(
    async ({ BrowserWindow }, { file, width }) => {
      const page = new BrowserWindow({ show: false, width, height: 900, useContentSize: true })
      await page.loadFile(file)
      const result = (await page.webContents.executeJavaScript(
        // 有竖滚动条时 innerWidth 把滚动条也算进去了，按 clientWidth 比
        `(() => { const width = document.documentElement.clientWidth; return { chart: Math.round(document.querySelector('[data-testid="chart-canvas"] svg')?.getBoundingClientRect().height ?? 0) > 50, overflow: document.documentElement.scrollWidth - width, outside: [...document.querySelectorAll('figure, pre, table, svg')].filter((item) => item.getBoundingClientRect().right > width + 1 && !item.closest('.overflow-x-auto, .overflow-auto, pre')).map((item) => item.tagName + ':' + (item.closest('[data-kind]')?.getAttribute('data-kind') ?? '')) } })()`,
      )) as { chart: boolean; overflow: number; outside: string[] }
      const image = (await page.webContents.capturePage()).toPNG().toString('base64')
      page.destroy()
      return { ...result, image }
    },
    { file, width },
  )
}

// 第 684 步：富块的质量门槛——每种内置富块（和 core 的门槛用同一份样例）都画得出来、数据不对时回退、明暗截图、375 和 1280 宽不溢出，导出的页面也一样
test('富块质量门槛：每种块都画得出来、数据不对回退成代码；深浅色各截一张；375 和 1280 宽不溢出；导出的页面在这两个宽度也不溢出', async () => {
  test.setTimeout(150_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-rich-gate-'))
  const downloads = mkdtempSync(join(tmpdir(), 'diffra-e2e-rich-gate-out-'))
  const model = await startScriptedModel([{ text: ANSWER }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '每种块都来一个')
    await waitTaskDone(window)
    const answer = window.getByTestId('agent-message').last()
    await expect(answer.locator(`${blockOf('chart')} svg`).first()).toBeVisible()

    // 每种块都画出来了；数据不对的回退成代码，写明原因
    for (const kind of RICH_BLOCK_KINDS) await expect(answer.locator(blockOf(kind)).first(), kind).toBeVisible()
    // 不合法的 JSON 本来就按代码显示，不另写原因
    const broken = RICH_BLOCK_KINDS.filter((kind) => RICH_SAMPLES[kind].invalid !== null && kind !== 'json').length
    await expect(answer.getByTestId('rich-fallback')).toHaveCount(broken)

    // 深浅色各截一张
    await setWidth(app, window, 1280)
    for (const kind of RICH_BLOCK_KINDS) {
      const block = answer.locator(blockOf(kind)).first()
      await block.scrollIntoViewIfNeeded()
      await block.screenshot({ path: `test-results/gate-${kind}-light.png` })
    }
    await window.emulateMedia({ colorScheme: 'dark' })
    await expect(window.locator('html')).toHaveClass(/dark/)
    await window.waitForTimeout(400)
    for (const kind of RICH_BLOCK_KINDS) {
      const block = answer.locator(blockOf(kind)).first()
      await block.scrollIntoViewIfNeeded()
      await block.screenshot({ path: `test-results/gate-${kind}-dark.png` })
    }
    await window.emulateMedia({ colorScheme: 'light' })

    // 应用里 1280 和 375 宽。先关掉右侧面板（窄窗口下左边的侧栏会自动收起，右侧面板不会）
    const closePanel = window.getByRole('button', { name: '关闭面板' })
    if (await closePanel.isVisible()) await closePanel.click()
    await expectNoOverflow(answer)
    await setWidth(app, window, 375)
    await answer.locator(blockOf('chart')).first().scrollIntoViewIfNeeded()
    await window.screenshot({ path: 'test-results/gate-375.png' })
    await expectNoOverflow(answer)
    await setWidth(app, window, 1280)

    // 导出的页面
    await app.evaluate(({ session }, target) => {
      session.defaultSession.on('will-download', (_event, item) => item.setSavePath(`${target}/${item.getFilename()}`))
    }, downloads)
    await window.getByTestId('turn-actions').last().getByRole('button', { name: '导出这一轮' }).click()
    await window.getByRole('menuitem', { name: 'HTML', exact: true }).click()
    const file = join(downloads, '每种块都来一个.html')
    await expect.poll(() => existsSync(file), { timeout: 20_000 }).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('data-kind="chart-bar"')
    for (const width of [375, 1280]) {
      const { image, ...result } = await exportOverflow(app, file, width)
      writeFileSync(`test-results/gate-export-${width}.png`, Buffer.from(image, 'base64'))
      // 图表缩小了也还看得见（没有塌成 0 高）
      expect(result, `导出页 ${width} 宽`).toEqual({ chart: true, overflow: 0, outside: [] })
    }
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(downloads, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
