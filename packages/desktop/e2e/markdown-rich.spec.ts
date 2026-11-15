import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test'
import { chooseProject, startTask, taskInput, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

// 8x8 的 PNG（绿色）
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGPQyw7HihiGlgQAZ+E8AeyZfSMAAAAASUVORK5CYII=', 'base64')

const fence = '```'
const longCode = Array.from({ length: 40 }, (_, index) => `const line${index + 1} = ${index + 1}`).join('\n')
const tableRows = Array.from({ length: 30 }, (_, index) => `| 第 ${index + 1} 项 | ${index * 10} |`).join('\n')

const ANSWER = [
  '## 改动说明',
  '',
  `${fence}js src/util.js:10 {2}`,
  'export function add(a, b) {',
  '  return a + b // 这一行高亮',
  '}',
  'const text = "字符串"',
  fence,
  '',
  `${fence}ts`,
  longCode,
  fence,
  '',
  `${fence}diff`,
  '--- a/src/util.js',
  '+++ b/src/util.js',
  '@@ -1,3 +1,3 @@',
  ' export function add(a, b) {',
  '-  return a - b',
  '+  return a + b',
  ' }',
  '--- a/src/other.js',
  '+++ b/src/other.js',
  '@@ -5,2 +5,3 @@',
  ' const x = 1',
  '+const y = 2',
  ' const z = 3',
  fence,
  '',
  '> [!WARNING] 小心升级',
  '> 升级前先备份数据。',
  '',
  '> [!DETAILS]- 完整日志',
  '> 第一行日志',
  '',
  '> 普通的引用',
  '',
  '| 项目 | 数值 |',
  '| :--- | ---: |',
  tableRows,
  '',
  '质能方程 $E=mc^2$，环境变量 $PATH 和 $HOME 照原样。',
  '',
  '$$',
  '\\int_0^1 x\\,dx = \\frac{1}{2}',
  '$$',
  '',
  `${fence}mermaid`,
  'flowchart LR',
  '  A[开始] --> B{判断}',
  '  B -->|是| C[结束]',
  fence,
  '',
  `${fence}mermaid`,
  'flowchart LR',
  '  A --> (((',
  fence,
  '',
  '`src/util.js:2`',
  '',
  '![截图](shot.png) 和网上的 ![图标](https://example.com/icon.png)',
  '',
  '![前 改版前](shot.png) ![后 改版后](shot.png)',
  '',
  '参考了官方文档[^1]。',
  '',
  '[^1]: [React 文档](https://react.dev/learn)',
].join('\n')

// 第二轮流式输出到一半：流程图围栏还没写完
const STREAMING = ['先看流程：', '', `${fence}mermaid`, 'flowchart TD', '  A[第一步] --> B[第二步]', fence, '', '画完了。'].join('\n')

// Windows 的剪贴板把换行存成 \r\n，比较前统一成 \n
async function clipboard(app: ElectronApplication): Promise<string> {
  return (await app.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, '\n')
}

// 富块的右边不超出回答这一栏、回答本身不横向溢出
async function expectNoOverflow(answer: Locator) {
  type Box = { scrollWidth: number; clientWidth: number; getBoundingClientRect(): { right: number; width: number }; getAttribute(name: string): string | null }
  const overflow = await answer.evaluate((root) => {
    const markdown = root.querySelector('.markdown') as unknown as Box
    const { right, width } = markdown.getBoundingClientRect()
    const blocks = [...root.querySelectorAll('[data-testid="code-block"], [data-testid="diff-block"], [data-testid="md-table"], [data-testid="mermaid-block"], [data-testid="math-block"], [data-testid="file-card"], [data-testid="callout"]')] as unknown as Box[]
    const outside = blocks.filter((block) => block.getBoundingClientRect().right > right + 1).map((block) => `${block.getAttribute('data-testid')}:${Math.round(block.getBoundingClientRect().width)}`)
    return { scroll: markdown.scrollWidth - markdown.clientWidth, outside, width: Math.round(width) }
  })
  expect(overflow, `回答这一栏宽 ${overflow.width}px`).toEqual({ scroll: 0, outside: [], width: overflow.width })
}

async function setWidth(app: ElectronApplication, window: Page, width: number) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size, 900), width)
  await expect.poll(() => window.evaluate(() => (globalThis as unknown as { innerWidth: number }).innerWidth)).toBeLessThanOrEqual(width)
}

// 第 640 步：回答里的富文档基础——代码块高亮、diff、callout、表格、公式、流程图、图片、文件卡、来源卡；流式输出时没写完的富块先占位
test('回答里的富文档：代码高亮和行号、diff、callout、表格、公式、流程图、图片、文件卡、来源卡；非法内容回退成代码；流式输出时富块先占位', async () => {
  test.setTimeout(150_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-markdown-rich-'))
  mkdirSync(join(project, 'src'))
  writeFileSync(join(project, 'src', 'util.js'), Array.from({ length: 20 }, (_, index) => `// util 第 ${index + 1} 行`).join('\n') + '\n')
  writeFileSync(join(project, 'shot.png'), PNG)
  const model = await startScriptedModel([{ text: ANSWER }, { text: STREAMING, pauseAfter: { text: 'A[第一步] --> B[第二步]\n', ms: 2500 } }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '讲讲改动')
    await waitTaskDone(window)
    const answer = window.getByTestId('agent-message').last()

    // 代码块：文件名、语法高亮、行号从 10 开始、第 2 行高亮；复制的是代码本身（不带行号）；是项目里的文件，能在文件面板打开
    const code = answer.getByTestId('code-block').first()
    await expect(code).toContainText('src/util.js')
    await expect(code.locator('.tok-keyword').first()).toHaveText('export')
    await expect(code.locator('.tok-string')).toContainText('"字符串"')
    await expect(code.locator('.code-ln').first()).toHaveText('10')
    await expect(code.locator('.code-line-mark')).toHaveCount(1)
    await expect(code.locator('.code-line-mark')).toContainText('return a + b')
    await code.getByRole('button', { name: '复制代码' }).click()
    await expect.poll(() => clipboard(app)).toBe('export function add(a, b) {\n  return a + b // 这一行高亮\n}\nconst text = "字符串"')
    await code.getByRole('button', { name: '在文件面板打开' }).click()
    await expect(window.getByTestId('file-panel').locator('.cm-target-line')).toHaveText('// util 第 10 行')

    // 长代码默认收起，只露前 16 行；展开后 40 行
    const long = answer.getByTestId('code-block').nth(1)
    await expect(long.locator('.code-line')).toHaveCount(16)
    await long.getByTestId('code-expand').click()
    await expect(long.locator('.code-line')).toHaveCount(40)

    // diff：两个文件，各自的增删数；文件能收起
    const diff = answer.getByTestId('diff-block')
    await expect(diff).toContainText('改动 · 2 个文件')
    await expect(diff.getByTestId('diff-block-file')).toHaveCount(2)
    await expect(diff.getByTestId('diff-block-file').first()).toContainText('src/util.js')
    await expect(diff.getByTestId('diff-block-lines')).toHaveCount(2)
    await diff.getByRole('button', { name: /src\/other\.js/ }).click()
    await expect(diff.getByTestId('diff-block-lines')).toHaveCount(1)

    // callout：标题、警告样式；「详情」默认收起，点开看正文；普通引用照旧
    const warning = answer.locator('[data-callout="warning"]')
    await expect(warning).toContainText('小心升级')
    await expect(warning).toContainText('升级前先备份数据。')
    const details = answer.locator('[data-callout="details"]')
    await expect(details.getByText('第一行日志')).toBeHidden()
    await details.getByRole('button', { name: '完整日志' }).click()
    await expect(details.getByText('第一行日志')).toBeVisible()
    await expect(answer.locator('blockquote')).toContainText('普通的引用')

    // 表格：30 行先收起只显示 15 行，展开后全显示；能复制成 CSV
    const table = answer.getByTestId('md-table')
    await expect(table.locator('tbody tr:visible')).toHaveCount(15)
    await table.getByTestId('table-expand').click()
    await expect(table.locator('tbody tr:visible')).toHaveCount(30)
    await table.hover()
    await table.getByRole('button', { name: '复制为 CSV' }).click()
    await expect.poll(() => clipboard(app)).toContain('项目,数值\n第 1 项,0\n')

    // 公式：行内和块级用 KaTeX 排版；$PATH 和 $HOME 不是公式，照原样
    await expect(answer.getByTestId('math-inline').locator('.katex')).toHaveCount(1)
    await expect(answer.getByTestId('math-block').locator('.katex-display')).toHaveCount(1)
    await expect(answer).toContainText('$PATH 和 $HOME')

    // 流程图：画成 SVG；语法错的按代码显示并说明
    const diagram = answer.getByTestId('mermaid-block')
    await expect(diagram.locator('.mermaid-view > svg')).toHaveCount(1)
    await expect(diagram.locator('.mermaid-view > svg')).toContainText('判断')
    await expect(answer.getByTestId('rich-fallback')).toContainText('流程图语法有误')

    // 单独一段的文件引用是文件卡，能预览那几行
    const card = answer.getByTestId('file-card')
    await expect(card).toContainText('src/util.js')
    await card.getByRole('button', { name: /预览/ }).click()
    await expect(card.getByTestId('file-card-preview')).toContainText('// util 第 2 行')

    // 图片：项目里的图片显示出来，点开大图；网络图片不加载，显示成链接；「前」「后」两张是对比滑块
    await expect(answer.getByTestId('answer-image').first()).toBeVisible()
    await expect.poll(() => answer.getByTestId('answer-image').first().evaluate((image) => (image as unknown as { naturalWidth: number }).naturalWidth)).toBe(8)
    await expect(answer.getByTestId('web-image')).toContainText('example.com')
    await expect(answer.getByTestId('image-compare')).toBeVisible()
    await answer.getByRole('button', { name: '查看大图：截图' }).click()
    await expect(window.getByTestId('lightbox-image')).toBeVisible()
    await window.getByRole('button', { name: '放大', exact: true }).last().click()
    await expect(window.getByTestId('lightbox')).toContainText('125%')
    await window.keyboard.press('Escape')

    // 脚注里的网页来源画成来源卡
    await expect(answer.getByTestId('source-card')).toContainText('react.dev')

    // 窄屏和宽屏都不横向溢出；深浅色各截一张整段回答。先关掉右侧的文件面板（上面点「在文件面板打开」开的），窄窗口下侧栏会自动收起
    await window.getByRole('button', { name: '关闭面板' }).click()
    await setWidth(app, window, 1280)
    await expectNoOverflow(answer)
    // 每种块各截一张：整段回答比视口高，超出视口的部分截不出来
    const shots: Array<[string, Locator]> = [
      ['code', code],
      ['diff', diff],
      ['callout', warning],
      ['table', table],
      ['math', answer.getByTestId('math-block')],
      ['mermaid', diagram],
      ['file-card', card],
      ['compare', answer.getByTestId('image-compare')],
      ['sources', answer.locator('.footnotes')],
    ]
    for (const [name, locator] of shots) await locator.screenshot({ path: `test-results/markdown-rich-${name}-light.png` })
    // 跟随系统切到深色：流程图按深色的颜色重画
    const lightDiagram = await diagram.locator('.mermaid-view').innerHTML()
    await window.emulateMedia({ colorScheme: 'dark' })
    await expect(window.locator('html')).toHaveClass(/dark/)
    await expect.poll(() => diagram.locator('.mermaid-view').innerHTML()).not.toBe(lightDiagram)
    for (const [name, locator] of shots) await locator.screenshot({ path: `test-results/markdown-rich-${name}-dark.png` })
    await window.emulateMedia({ colorScheme: 'light' })
    await setWidth(app, window, 375)
    await expectNoOverflow(answer)
    for (const [name, locator] of shots.slice(0, 4)) await locator.screenshot({ path: `test-results/markdown-rich-${name}-375.png` })
    await setWidth(app, window, 1280)

    // 第二轮：流程图围栏写到一半时只有占位，不先闪出代码；写完换成图
    await taskInput(window).fill('再画个流程')
    await window.getByRole('button', { name: '发送', exact: true }).click()
    const streaming = window.getByTestId('agent-message').last()
    await expect(streaming).toContainText('先看流程')
    await expect(streaming.getByTestId('rich-skeleton')).toBeVisible()
    await expect(streaming.getByTestId('code-block')).toHaveCount(0)
    await waitTaskDone(window)
    await expect(streaming.getByTestId('mermaid-block').locator('.mermaid-view > svg')).toContainText('第二步')
    await expect(streaming.getByTestId('rich-skeleton')).toHaveCount(0)
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})
