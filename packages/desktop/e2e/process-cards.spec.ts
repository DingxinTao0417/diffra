import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { exec, startScriptedModel } from './scripted-model'

const fence = '```'

// 第 663 步：计划卡的步骤能挪、能勾掉做完的、能从某一步开始执行
test('计划步骤：挪动会重写计划文字并重新编号，勾掉的步骤和「从第 N 步开始」写进发给智能体的话', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-plan-steps-'))
  const model = await startScriptedModel([
    {
      toolCalls: [
        {
          name: 'submit_plan',
          input: {
            understanding: '整理代码',
            steps: [
              { title: '读代码', detail: '看结构', files: [] },
              { title: '改代码', detail: '', files: ['a.ts'] },
              { title: '跑测试', detail: '', files: [] },
            ],
            risks: ['可能影响别处'],
          },
        },
      ],
    },
    { text: '从第二步开始做完了' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    const input = window.getByRole('textbox', { name: '任务', exact: true })
    await input.pressSequentially('/计划')
    await input.press('Enter')
    await startTask(window, '整理一下代码')
    const steps = window.getByTestId('plan-steps')
    await expect(steps.getByTestId('plan-step')).toHaveCount(3, { timeout: 20_000 })
    await waitTaskDone(window)

    // 第 3 步往上挪：文字跟着改、重新编号；第 2 步下面缩进的「涉及」跟着它走，风险留在最后
    await steps.getByTestId('plan-step').nth(2).hover()
    await steps.getByRole('button', { name: '把第 3 步往上挪' }).click()
    const content = window.getByLabel('计划内容')
    await expect(content).toHaveValue('整理代码\n\n1. 读代码\n   看结构\n2. 跑测试\n3. 改代码\n   涉及：a.ts\n\n风险和需要确认的问题：\n- 可能影响别处')
    await steps.getByRole('checkbox', { name: /第 1 步已经做完/ }).click()
    await steps.getByTestId('plan-step').nth(1).hover()
    await steps.getByRole('button', { name: '从第 2 步开始执行' }).click()
    await expect(window.getByTestId('user-message').last()).toContainText('从第 2 步开始（第 1 步已经做完，不用再做）')
    await waitTaskDone(window)
    expect(model.bodies().at(-1)).toContain('2. 跑测试')
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

// 第 664 步：回答里的后续事项能加进待办，和侧栏的待办是同一份
test('后续事项：加进待办后显示待办的状态，能勾掉；存进待办列表', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-todos-block-'))
  const answer = ['这次先做到这里，剩下的：', '', `${fence}todos`, JSON.stringify(['给解析器补测试', { text: '换掉泄露过的密钥', note: '旧的在日志里出现过' }]), fence].join('\n')
  const model = await startScriptedModel([{ text: answer }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '先做一部分')
    await waitTaskDone(window)
    const block = window.getByTestId('rich-todos')
    const items = block.getByTestId('rich-todo')
    await expect(items).toHaveCount(2)
    await expect(items.nth(1)).toContainText('旧的在日志里出现过')
    await items.nth(0).getByRole('button', { name: '加入待办' }).click()
    await expect(items.nth(0)).toHaveAttribute('data-linked', 'open')
    await expect.poll(() => readFileSync(join(userDataDir, 'todos.json'), 'utf8')).toContain('给解析器补测试')
    await items.nth(0).getByRole('checkbox').click()
    await expect(items.nth(0)).toHaveAttribute('data-linked', 'done')
    // 勾掉的是待办列表里的同一条
    const saved = () => (JSON.parse(readFileSync(join(userDataDir, 'todos.json'), 'utf8')) as { todos: Array<{ text: string; done: boolean; project: string | null }> }).todos
    await expect.poll(() => saved().find((todo) => todo.text === '给解析器补测试')?.done).toBe(true)
    expect(saved().find((todo) => todo.text === '给解析器补测试')?.project).toBe(project)
    // 第二条还没加：有「加入待办」，「全部加入待办」把它也加上
    await block.getByRole('button', { name: '全部加入待办' }).click()
    await expect(items.nth(1)).toHaveAttribute('data-linked', 'open')
    for (const scheme of ['light', 'dark'] as const) {
      await window.emulateMedia({ colorScheme: scheme })
      await block.screenshot({ path: `test-results/rich-todos-${scheme}.png` })
    }
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

// 第 665 步：Lighthouse 报告画成分数、指标和请求瀑布图；CPU profile 画成火焰图，最耗时的帧能点开源码
test('性能：Lighthouse 的分数、指标和瀑布图；CPU profile 的火焰图，热点能跳到源码', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-perf-'))
  mkdirSync(join(project, 'src'))
  writeFileSync(join(project, 'src', 'hot.js'), ['export function main() {', '  return work()', '}', 'function work() {', '  let x = 0', '}', ''].join('\n'))
  const lighthouse = {
    lighthouseVersion: '12.0.0',
    finalDisplayedUrl: 'http://localhost:3000/',
    categories: { performance: { title: '性能', score: 0.42 }, accessibility: { title: '无障碍', score: 0.95 } },
    audits: {
      'first-contentful-paint': { title: '首次内容绘制', displayValue: '1.2 s', score: 0.8 },
      'largest-contentful-paint': { title: '最大内容绘制', displayValue: '4.8 s', score: 0.2 },
      'network-requests': {
        details: {
          items: [
            { url: 'http://localhost:3000/', networkRequestTime: 0, networkEndTime: 120, transferSize: 2048, resourceType: 'Document', statusCode: 200 },
            { url: 'http://localhost:3000/app.js', networkRequestTime: 130, networkEndTime: 1600, transferSize: 420000, resourceType: 'Script', statusCode: 200 },
            { url: 'http://localhost:3000/missing.png', networkRequestTime: 140, networkEndTime: 200, transferSize: 0, resourceType: 'Image', statusCode: 404 },
          ],
        },
      },
    },
  }
  writeFileSync(join(project, 'lh.json'), JSON.stringify(lighthouse))
  const url = pathToFileURL(join(project, 'src', 'hot.js')).href
  const profile = {
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, children: [2] },
      { id: 2, callFrame: { functionName: 'main', url, lineNumber: 0 }, children: [3] },
      { id: 3, callFrame: { functionName: 'work', url, lineNumber: 3 }, children: [] },
    ],
    startTime: 0,
    endTime: 100_000,
    samples: [2, 3, 3, 3, 3],
    timeDeltas: [0, 20_000, 20_000, 20_000, 20_000],
  }
  writeFileSync(join(project, 'run.cpuprofile'), JSON.stringify(profile))
  const model = await startScriptedModel([{ toolCalls: [exec('cat lh.json')] }, { toolCalls: [exec('cat run.cpuprofile')] }, { text: '分析完了' }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '看看性能')
    await waitTaskDone(window)
    await window.getByTestId('tool-group').getByRole('button').first().click()
    const open = async (command: string) => {
      const step = window.getByTestId('tool-call').filter({ hasText: command }).first()
      await step.getByRole('button').first().click()
      return step.getByTestId('tool-output')
    }
    const lh = await open('cat lh.json')
    await expect(lh.getByTestId('lighthouse-score')).toHaveCount(2)
    await expect(lh.getByTestId('lighthouse-score').first()).toContainText('42')
    await expect(lh.getByTestId('lighthouse')).toContainText('4.8 s')
    await expect(lh.getByTestId('waterfall-row')).toHaveCount(3)
    await expect(lh.getByTestId('waterfall-row').nth(1)).toContainText('1470 ms')

    const flame = await open('cat run.cpuprofile')
    await expect(flame.getByTestId('flame-frame').filter({ hasText: 'work' })).toHaveCount(1)
    await expect(flame.getByTestId('flame-hottest')).toContainText('work')
    await flame.getByTestId('flame-source').first().click()
    await expect(window.getByTestId('file-panel').locator('.cm-target-line')).toHaveText('function work() {')
    await window.getByRole('button', { name: '关闭面板' }).click()
    for (const scheme of ['light', 'dark'] as const) {
      await window.emulateMedia({ colorScheme: scheme })
      await lh.screenshot({ path: `test-results/perf-lighthouse-${scheme}.png` })
      await flame.screenshot({ path: `test-results/perf-flame-${scheme}.png` })
    }
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})
