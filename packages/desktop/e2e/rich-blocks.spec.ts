import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test'
import { chooseProject, startTask, taskInput, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

const fence = '```'
const block = (kind: string, value: unknown) => [`${fence}${kind}`, typeof value === 'string' ? value : JSON.stringify(value, null, 2), fence, ''].join('\n')

const bigJson = { name: 'diffra', version: '0.5.1', scripts: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`task${index}`, `node scripts/task${index}.ts`])), nested: { deep: { target: 'found-me' } } }

const ANSWER = [
  '构建耗时对比：',
  '',
  block('chart', { type: 'bar', title: '构建耗时', unit: 's', data: [{ label: '安装', value: 12 }, { label: '构建', value: 30 }, { label: '测试', value: 45 }, { label: '打包', value: 20 }] }),
  block('chart', { type: 'line', title: '每日请求', x: ['周一', '周二', '周三', '周四'], series: [{ name: 'p50', data: [80, 90, 70, 60] }, { name: 'p95', data: [200, 240, 180, 160] }] }),
  block('chart', { type: 'pie', title: '用例结果', data: [{ name: '通过', value: 120 }, { name: '失败', value: 3 }, { name: '跳过', value: 7 }] }),
  block('chart', { type: 'heatmap', title: '错误分布', x: ['00', '06', '12', '18'], y: ['周一', '周二'], data: [[1, 4, 9, 2], [0, 3, 12, 5]] }),
  block('metrics', { items: [{ label: '包体积', value: 412, unit: 'KB', delta: '-8%', better: 'down' }, { label: '首屏', value: '1.8', unit: 's', delta: '+0.3', better: 'down' }, { label: '用例', value: 130 }] }),
  block('table', { title: '模块体积', columns: ['模块', { key: 'kb', label: '体积（KB）' }], rows: Array.from({ length: 12 }, (_, index) => [`module-${String.fromCharCode(97 + index)}`, (index * 37) % 100]) }),
  block('timeline', { items: [{ time: '10:00', title: '开始部署', status: 'done' }, { time: '10:05', title: '迁移数据库', status: 'failed', detail: '锁等待超时' }, { time: '10:08', title: '回滚', status: 'active' }] }),
  block('steps', { title: '升级步骤', current: 2, items: ['备份数据', { title: '跑迁移', command: 'pnpm db:migrate' }, '重启服务'] }),
  block('compare', { criteria: ['速度'], options: [{ name: '方案 A', summary: '改动小', pros: ['不动接口'], cons: ['慢'], scores: { 速度: '一般' } }, { name: '方案 B', summary: '重写缓存', pros: ['快'], scores: { 速度: '快' }, recommended: true }] }),
  block('filetree', { items: [{ path: 'src/app.ts', status: 'modified' }, { path: 'src/new.ts', status: 'added', note: '新的入口' }, { path: 'docs/old.md', status: 'deleted' }] }),
  block('keyvalue', { 端口: 3000, 模式: 'development', 入口: 'src/app.ts' }),
  block('json', bigJson),
  block('log', ['INFO 服务启动', 'WARN 慢查询 1200ms', 'ERROR 连接被拒绝', '    at connect (src/app.ts:3:5)', 'DEBUG 重试第 1 次'].join('\n')),
  '下面两个写错了：',
  '',
  block('chart', '{ "type": "bar", "data": [ '),
  block('metrics', { v: 2, items: [{ label: '新格式', value: 1 }] }),
].join('\n')

async function clipboard(app: ElectronApplication): Promise<string> {
  return (await app.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, '\n')
}

async function setWidth(app: ElectronApplication, window: Page, width: number) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size, 900), width)
  await expect.poll(() => window.evaluate(() => (globalThis as unknown as { innerWidth: number }).innerWidth)).toBeLessThanOrEqual(width)
}

async function expectNoOverflow(answer: Locator) {
  type Box = { scrollWidth: number; clientWidth: number; getBoundingClientRect(): { right: number; width: number }; getAttribute(name: string): string | null }
  const overflow = await answer.evaluate((root) => {
    const markdown = root.querySelector('.markdown') as unknown as Box
    const { right, width } = markdown.getBoundingClientRect()
    const blocks = [...root.querySelectorAll('figure')] as unknown as Box[]
    const outside = blocks.filter((item) => item.getBoundingClientRect().right > right + 1).map((item) => `${item.getAttribute('data-testid')}:${Math.round(item.getBoundingClientRect().width)}`)
    return { scroll: markdown.scrollWidth - markdown.clientWidth, outside, width: Math.round(width) }
  })
  expect(overflow, `回答这一栏宽 ${overflow.width}px`).toEqual({ scroll: 0, outside: [], width: overflow.width })
}

// 第 650–652 步：结构化富块——图表、指标、表格、时间线、步骤、对比、文件树、键值、JSON、日志；数据不对或版本太新回退成代码；系统提示词里有回答格式指南
test('回答里的结构化富块：每种块的关键操作、非法数据和新版本回退成代码、深浅色截图、窄屏不溢出', async () => {
  test.setTimeout(150_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-rich-blocks-'))
  mkdirSync(join(project, 'src'))
  writeFileSync(join(project, 'src', 'app.ts'), ['import { serve } from "./server"', '', 'connect()', 'serve()', ''].join('\n'))
  const model = await startScriptedModel([{ text: ANSWER }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '分析一下构建')
    await waitTaskDone(window)
    // 系统提示词里告诉了模型这些写法
    expect(model.bodies()[0]).toContain('## Formatting your answer')
    const answer = window.getByTestId('agent-message').last()

    // 图表：四种都画成 SVG；柱状图能切到数据表看数字
    const charts = answer.getByTestId('chart-block')
    await expect(charts).toHaveCount(4)
    for (const kind of ['bar', 'line', 'pie', 'heatmap']) await expect(answer.locator(`[data-kind="chart-${kind}"] [data-testid="chart-canvas"] svg`).first()).toBeVisible()
    const bar = answer.locator('[data-kind="chart-bar"]')
    await expect(bar).toContainText('构建耗时')
    await bar.getByRole('button', { name: '看数据表' }).click()
    await expect(bar.getByTestId('chart-table').locator('tbody tr')).toHaveCount(4)
    await expect(bar.getByTestId('chart-table')).toContainText('测试')
    await bar.getByRole('button', { name: '看图' }).click()
    await expect(bar.getByTestId('chart-table')).toHaveCount(0)

    // 指标卡：变差的（首屏 +0.3s，越小越好）标出来，变好的不标
    const metrics = answer.getByTestId('metric')
    await expect(metrics).toHaveCount(3)
    await expect(metrics.nth(0).locator('[data-trend="down"]')).not.toHaveAttribute('data-worse')
    await expect(metrics.nth(1).locator('[data-worse]')).toBeVisible()

    // 表格：点表头排序（再点倒序），能筛选，复制成 CSV
    const table = answer.getByTestId('rich-table')
    const firstCell = table.getByTestId('rich-table-row').first().locator('td').nth(1)
    await table.getByRole('button', { name: /体积/ }).click()
    await expect(firstCell).toHaveText('0')
    await table.getByRole('button', { name: /体积/ }).click()
    await expect(firstCell).toHaveText('96')
    await table.getByLabel('筛选表格').fill('module-c')
    await expect(table.getByTestId('rich-table-row')).toHaveCount(1)
    await table.getByRole('button', { name: '复制为 CSV' }).click()
    await expect.poll(() => clipboard(app)).toBe('模块,体积（KB）\nmodule-c,74')

    // 时间线：失败的一步标红
    await expect(answer.getByTestId('rich-timeline-item')).toHaveCount(3)
    await expect(answer.locator('[data-testid="rich-timeline-item"][data-status="failed"]')).toContainText('锁等待超时')

    // 步骤：第 2 步是当前步骤；勾上后进度变；命令能交给智能体（填进输入框，不发送）
    const steps = answer.getByTestId('rich-steps')
    await expect(steps.locator('[aria-current="step"]')).toContainText('跑迁移')
    await expect(steps).toContainText('完成 1/3')
    await steps.getByRole('checkbox', { name: /跑迁移/ }).click()
    await expect(steps).toContainText('完成 2/3')
    await expect(steps.locator('[aria-current="step"]')).toContainText('重启服务')
    await steps.getByRole('button', { name: '让智能体执行' }).click()
    await expect(taskInput(window)).toHaveValue('执行这条命令：\npnpm db:migrate')
    await taskInput(window).fill('')

    // 方案对比：推荐项有标记；「选这个」把选择填进输入框
    const compare = answer.getByTestId('rich-compare')
    await expect(compare.locator('[data-recommended]')).toContainText('推荐')
    await compare.locator('[data-recommended]').getByRole('button', { name: '选这个' }).click()
    await expect(taskInput(window)).toHaveValue('选「方案 B」')
    await taskInput(window).fill('')

    // 文件树：改动标记；项目里的文件点了在文件面板打开
    const tree = answer.getByTestId('rich-filetree')
    await expect(tree.getByTestId('rich-filetree-file')).toHaveCount(3)
    await expect(tree.locator('[data-status="deleted"]')).toContainText('old.md')
    await tree.getByRole('button', { name: /app\.ts/ }).click()
    await expect(window.getByTestId('file-panel')).toContainText('app.ts')
    await window.getByRole('button', { name: '关闭面板' }).click()

    // 键值表
    await expect(answer.getByTestId('rich-keyvalue')).toContainText('development')

    // JSON：长的默认是树；搜索自动展开命中的路径；点键名复制路径；能切回代码
    const json = answer.getByTestId('json-tree')
    await expect(json.getByText('"found-me"')).toHaveCount(0)
    await json.getByLabel('搜索 JSON').fill('found')
    await expect(json.getByText('"found-me"')).toBeVisible()
    await json.getByRole('button', { name: '"target"' }).click()
    await expect.poll(() => clipboard(app)).toBe('$.nested.deep.target')
    await json.getByRole('button', { name: '按代码查看' }).click()
    await expect(answer.locator('[data-testid="code-block"] [data-language="json"]')).toBeVisible()

    // 日志：按级别筛选；源码位置能点开到那一行
    const log = answer.getByTestId('log-block')
    await expect(log.getByTestId('log-line')).toHaveCount(5)
    await log.getByTestId('log-filter-error').click()
    await expect(log.getByTestId('log-line')).toHaveCount(1)
    await expect(log.getByTestId('log-line')).toContainText('连接被拒绝')
    await log.getByTestId('log-filter-error').click()
    await log.getByTestId('log-source').click()
    await expect(window.getByTestId('file-panel').locator('.cm-target-line')).toHaveText('connect()')
    await window.getByRole('button', { name: '关闭面板' }).click()

    // 写错的 JSON、版本比当前新的块回退成代码，写明原因
    const fallbacks = answer.getByTestId('rich-fallback')
    await expect(fallbacks).toHaveCount(2)
    await expect(fallbacks.nth(0)).toContainText('没能显示成图表')
    await expect(fallbacks.nth(1)).toContainText('第 2 版')

    // 深浅色各截一张；深色时图表跟着重设颜色
    await setWidth(app, window, 1280)
    const shots: Array<[string, Locator]> = [
      ['chart-bar', bar],
      ['chart-line', answer.locator('[data-kind="chart-line"]')],
      ['chart-pie', answer.locator('[data-kind="chart-pie"]')],
      ['chart-heatmap', answer.locator('[data-kind="chart-heatmap"]')],
      ['metrics', answer.getByTestId('rich-metrics')],
      ['table', table],
      ['timeline', answer.getByTestId('rich-timeline')],
      ['steps', steps],
      ['compare', compare],
      ['filetree', tree],
      ['keyvalue', answer.getByTestId('rich-keyvalue')],
      ['log', log],
    ]
    for (const [name, locator] of shots) await locator.screenshot({ path: `test-results/rich-${name}-light.png` })
    const lightBar = await bar.getByTestId('chart-canvas').innerHTML()
    await window.emulateMedia({ colorScheme: 'dark' })
    await expect(window.locator('html')).toHaveClass(/dark/)
    await expect.poll(() => bar.getByTestId('chart-canvas').innerHTML()).not.toBe(lightBar)
    for (const [name, locator] of shots) await locator.screenshot({ path: `test-results/rich-${name}-dark.png` })
    await window.emulateMedia({ colorScheme: 'light' })
    await setWidth(app, window, 375)
    await expectNoOverflow(answer)
    for (const [name, locator] of shots.slice(0, 1).concat(shots.slice(4, 9))) await locator.screenshot({ path: `test-results/rich-${name}-375.png` })
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})
